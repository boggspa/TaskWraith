'use strict'

/**
 * The many-agent workload's rounds, runner side.
 *
 * Every thread of the fixture gets a lane of its own: it sends a real
 * Ensemble round through the renderer's page API (`window.api.runEnsembleRound`,
 * the gates a user's send passes), waits until the page observer
 * (`liveThreadObserver.cjs`) has seen that round end, and sends the next, so
 * each thread always has one round running and never two. All lanes start
 * together, which is the load: a round on every thread at once.
 *
 * Nothing here reads a chat or sends a probe. One pump reads the observer for
 * every thread with one page call a poll. A lane never sends while the
 * observer shows a round it did not see end, a `steered` answer is a defect
 * that stops the lane, and an end not seen within its bound stops the lane
 * and is reported, never guessed at. A lane that fails stops alone; the
 * others keep their rounds going. Losing the observer fails every lane. Each
 * send is reduced in the page to its status, round id and page-measured
 * duration: no content crosses to the runner.
 *
 * Times: `sentAtMs`/`acceptedAtMs` are the runner's clock around the page
 * call, `pageMs` is the page's own measure of the call, and `endedAtMs` is
 * the page clock when the observer saw the round end (both clocks are this
 * machine's wall clock).
 */

const { TERMINAL_ROUND_STATUSES } = require('./liveLaneObserver.cjs')
const { sendRoundExpression } = require('./liveRoundLanes.cjs')
const {
  installThreadObserverExpression,
  parseThreadObserverRead,
  readThreadObserverExpression,
  threadObserverConfig
} = require('./liveThreadObserver.cjs')

const DEFAULT_OPTIONS = Object.freeze({
  pollMs: 250,
  callTimeoutMs: 60_000,
  roundTimeoutMs: 600_000,
  roundGapMs: 0
})

/**
 * The prompt a thread's lane sends as its round `index` (counted from 1):
 * no two sends of a run share one, so each is found again by its text.
 */
function manyAgentPrompt(place, index) {
  return `Many agents, thread ${place + 1}, round ${index}: answer briefly.`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function laneError(message, reason) {
  const error = new Error(message)
  error.code = 'T2_LIVE_THREAD_OBSERVER'
  error.reason = reason
  return error
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reject when `promise` has not settled within `ms`. */
function withTimeout(promise, ms, what) {
  let timer = null
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer))
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function positiveOption(options, name) {
  const value = options[name] === undefined ? DEFAULT_OPTIONS[name] : options[name]
  if (!finiteNonNegative(value) || value === 0) throw new Error(`${name} must be positive`)
  return value
}

/**
 * @param {{
 *   page: { evaluate(expression: string): Promise<unknown> },
 *   chatIds: string[],
 *   nowMs?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number, callTimeoutMs?: number,
 *   roundTimeoutMs?: number, roundGapMs?: number
 * }} options
 */
function createManyAgentLanes(options) {
  if (!isPlainObject(options) || !options.page || typeof options.page.evaluate !== 'function') {
    throw new Error('createManyAgentLanes needs a page adapter')
  }
  const config = threadObserverConfig({ chatIds: options.chatIds })
  const page = options.page
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const pollMs = positiveOption(options, 'pollMs')
  const callTimeoutMs = positiveOption(options, 'callTimeoutMs')
  const roundTimeoutMs = positiveOption(options, 'roundTimeoutMs')
  const roundGapMs =
    options.roundGapMs === undefined ? DEFAULT_OPTIONS.roundGapMs : options.roundGapMs
  if (!finiteNonNegative(roundGapMs)) throw new Error('roundGapMs must be non-negative')

  const call = (expression, what) =>
    withTimeout(
      Promise.resolve().then(() => page.evaluate(expression)),
      callTimeoutMs,
      what
    )

  // What the observer has shown of each thread, fed by the pump.
  const threads = config.chatIds.map((chatId) => ({
    chatId,
    rounds: [],
    failure: null,
    sends: 0,
    observed: { roundId: null, status: null },
    deliveries: { full: 0, compact: 0 },
    // Round id to its observed end.
    ends: new Map(),
    // The round end its lane waits on: a thread has one round at a time.
    waiting: null
  }))
  let sinceSeq = 0
  let installId = null
  let faults = 0
  let observerFailure = null
  let stopped = false
  let sendingStopped = false
  let pumping = null
  let loops = null

  async function readOnce() {
    const text = await call(readThreadObserverExpression(config, sinceSeq), 'thread observer read')
    const read = parseThreadObserverRead(text, config, sinceSeq, installId ?? undefined)
    if (!read.ok) throw laneError(`thread observer read refused: ${read.reason}`, read.reason)
    if (read.lost) throw laneError('thread observer lost transitions', 'transitions_lost')
    for (const transition of read.transitions) {
      // A status is null without a round id, so an end always names its round.
      if (TERMINAL_ROUND_STATUSES.includes(transition.status)) {
        threads[transition.thread].ends.set(transition.roundId, {
          status: transition.status,
          atMs: transition.atMs
        })
      }
      sinceSeq = transition.seq
    }
    for (const [place, seen] of read.threads.entries()) {
      threads[place].observed = { roundId: seen.roundId, status: seen.status }
      threads[place].deliveries = { full: seen.full, compact: seen.compact }
    }
    faults = read.faults
    return read
  }

  /** Answer every lane whose wait is over. An answered wait stays until the lane's next. */
  function settleWaiters() {
    for (const thread of threads) {
      const waiter = thread.waiting
      if (waiter === null) continue
      const end = thread.ends.get(waiter.roundId)
      if (end !== undefined) waiter.resolve({ value: end })
      else if (observerFailure !== null) waiter.resolve({ failure: observerFailure })
      else if (stopped) waiter.resolve({ failure: 'stopped' })
      else if (nowMs() > waiter.deadlineMs) waiter.resolve({ failure: 'unobserved' })
    }
  }

  /** Resolves `{ value }` once the round's end is seen, else `{ failure }`. */
  function roundEnd(thread, roundId) {
    const settled = new Promise((resolve) => {
      thread.waiting = { roundId, deadlineMs: nowMs() + roundTimeoutMs, resolve }
    })
    // The pump may already have ended: nothing later would answer this wait.
    settleWaiters()
    return settled
  }

  async function pump() {
    while (!stopped && observerFailure === null) {
      await sleep(pollMs)
      if (stopped) break
      try {
        await readOnce()
      } catch (error) {
        observerFailure = `observer_${error && error.reason ? error.reason : 'read_failed'}`
      }
      settleWaiters()
    }
    settleWaiters()
  }

  async function install() {
    if (installId !== null) throw new Error('the thread lanes are already installed')
    const status = await call(installThreadObserverExpression(config), 'thread observer install')
    if (status !== 'installed') {
      throw laneError(`thread observer install answered ${String(status)}`, String(status))
    }
    installId = (await readOnce()).installId
    pumping = pump()
  }

  async function sendRound(place, index) {
    const prompt = manyAgentPrompt(place, index)
    const sentAtMs = nowMs()
    try {
      const reply = await call(
        sendRoundExpression(threads[place].chatId, prompt),
        `runEnsembleRound (thread ${place + 1})`
      )
      const acceptedAtMs = nowMs()
      return {
        status: isPlainObject(reply) && typeof reply.status === 'string' ? reply.status : null,
        roundId: isPlainObject(reply) && typeof reply.roundId === 'string' ? reply.roundId : null,
        pageMs: isPlainObject(reply) && finiteNonNegative(reply.pageMs) ? reply.pageMs : null,
        sentAtMs,
        acceptedAtMs
      }
    } catch {
      return { failed: true }
    }
  }

  /** Why a send's answer does not start a new round, or null. */
  function sendProblem(send, rounds) {
    if (send.failed) return 'send_failed'
    if (send.status === 'steered') return 'steered'
    if (
      send.status !== 'started' ||
      send.roundId === null ||
      rounds.some((round) => round.roundId === send.roundId)
    ) {
      return 'not_started'
    }
    return null
  }

  /** A thread may send only when the observer shows no round it did not see end. */
  function busyProblem(thread) {
    if (observerFailure !== null) return observerFailure
    const { status } = thread.observed
    return status === null || TERMINAL_ROUND_STATUSES.includes(status) ? null : 'busy_before_send'
  }

  async function threadLoop(place) {
    const thread = threads[place]
    // Every failure below leaves the loop itself.
    while (!stopped && !sendingStopped) {
      const busy = busyProblem(thread)
      if (busy !== null) {
        thread.failure = busy
        break
      }
      thread.sends += 1
      const send = await sendRound(place, thread.sends)
      const problem = sendProblem(send, thread.rounds)
      if (problem !== null) {
        thread.failure = problem
        break
      }
      const round = {
        roundId: send.roundId,
        sentAtMs: send.sentAtMs,
        acceptedAtMs: send.acceptedAtMs,
        pageMs: send.pageMs,
        endedAtMs: null,
        status: null
      }
      thread.rounds.push(round)
      const waited = await roundEnd(thread, round.roundId)
      if (waited.failure !== undefined) {
        if (waited.failure !== 'stopped') thread.failure = waited.failure
        break
      }
      round.endedAtMs = waited.value.atMs
      round.status = waited.value.status
      if (roundGapMs > 0) await sleep(roundGapMs)
    }
  }

  /** Start a round on every thread, and keep one running on each. */
  function start() {
    if (installId === null) throw new Error('install the thread observer first')
    if (loops !== null) throw new Error('the thread lanes are already started')
    loops = threads.map((_thread, place) => threadLoop(place))
  }

  /**
   * Send no more rounds and wait for every one in flight to be seen to end
   * (each lane's own bound applies). Resolves with when the last of them
   * ended, or null when some thread's last round was never seen to end, or
   * a thread never had one.
   */
  async function stopSending() {
    if (loops === null) throw new Error('the thread lanes are not started')
    sendingStopped = true
    await Promise.allSettled(loops)
    const lastEnds = threads.map((thread) => {
      const last = thread.rounds[thread.rounds.length - 1]
      return last ? last.endedAtMs : null
    })
    return { drainedAtMs: lastEnds.includes(null) ? null : Math.max(...lastEnds) }
  }

  function snapshot() {
    return {
      observer: { installId, faults, failure: observerFailure },
      sending: loops !== null && !sendingStopped && !stopped,
      threads: threads.map((thread) => ({
        chatId: thread.chatId,
        rounds: thread.rounds.map((round) => ({ ...round })),
        failure: thread.failure,
        deliveries: { ...thread.deliveries }
      }))
    }
  }

  /**
   * Stop every lane and the pump, and wait for both: the pump settles what
   * the lanes wait on as it ends, and a send in flight is still recorded.
   * The app's own rounds are left to run.
   */
  async function stop() {
    stopped = true
    await Promise.allSettled([pumping, ...(loops || [])].filter(Boolean))
    return snapshot()
  }

  return { install, start, stopSending, snapshot, stop }
}

module.exports = {
  DEFAULT_MANY_AGENT_LANE_OPTIONS: DEFAULT_OPTIONS,
  createManyAgentLanes,
  manyAgentPrompt
}
