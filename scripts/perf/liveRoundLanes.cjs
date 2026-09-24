'use strict'

/**
 * M1 live lanes, runner side (Independent Threads, slice S5b).
 *
 * Two lanes drive real Ensemble rounds through the renderer's own page API
 * (`window.api.runEnsembleRound`, the gates a user's send passes) while the
 * S5a page observer (`liveLaneObserver.cjs`) reports each round's state:
 *
 * - The heavy lane keeps a round streaming on the heavy chat: it sends the
 *   next round as soon as it sees the last one end, and records the time in
 *   between as idle.
 * - The light lane sends one round at a time on the light chat, each only
 *   after it has seen the one before end, so a send never lands in a live
 *   round (that takes the steering path). It can cancel every Nth round at a
 *   fixed offset after main accepted it, timed from the page.
 *
 * Nothing here reads a chat or sends a probe. A lane never sends while the
 * observer shows a round it did not see end, a `steered` answer is a defect
 * that stops the lane, and an end not seen within its bound stops the lane
 * and is reported, never guessed at. One pump reads the observer for both
 * lanes, and every page call is bounded. Each send and cancel is reduced in
 * the page to its status, round id and page-measured duration: no content
 * crosses to the runner.
 *
 * Times: `sentAtMs`/`acceptedAtMs` are the runner's clock around a page call,
 * `pageMs` is the page's own measure of the call, and `endedAtMs` is the page
 * clock when the observer saw the round end (both clocks are this machine's
 * wall clock). An idle interval runs from a heavy round's observed end to the
 * next heavy round's acceptance, so it slightly overstates the real gap.
 */

const {
  TERMINAL_ROUND_STATUSES,
  installLaneObserverExpression,
  laneObserverConfig,
  parseLaneObserverRead,
  readLaneObserverExpression,
  roundEndIn
} = require('./liveLaneObserver.cjs')

const LANES = Object.freeze(['light', 'heavy'])
const DEFAULT_OPTIONS = Object.freeze({
  pollMs: 250,
  callTimeoutMs: 60_000,
  lightRoundTimeoutMs: 180_000,
  heavyRoundTimeoutMs: 600_000,
  heavyStartTimeoutMs: 60_000,
  lightGapMs: 1_000,
  cancelEvery: 0,
  cancelAfterMs: 1_500
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function laneError(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reject with a named code when `promise` has not settled within `ms`. */
function withTimeout(promise, ms, what) {
  let timer = null
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(laneError(`${what} did not settle within ${ms} ms`, 'T2_LIVE_PAGE_CALL_TIMEOUT')),
      ms
    )
  })
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer))
}

/** A page call that sends one round and answers only its status, id and duration. */
function sendRoundExpression(chatId, prompt) {
  return (
    '(function(){ var t0 = performance.now(); ' +
    `return Promise.resolve(window.api.runEnsembleRound(${JSON.stringify({ chatId, prompt })}))` +
    '.then(function(r){ var o = r !== null && typeof r === "object"; return { ' +
    'status: o && typeof r.status === "string" ? r.status : null, ' +
    'roundId: o && typeof r.roundId === "string" ? r.roundId : null, ' +
    'pageMs: performance.now() - t0 }; }); })()'
  )
}

/** A page call that cancels the chat's round; a refusal is an answer, not a throw. */
function cancelRoundExpression(chatId) {
  return (
    '(function(){ var t0 = performance.now(); ' +
    `return Promise.resolve(window.api.cancelEnsembleRound(${JSON.stringify(chatId)}))` +
    '.then(function(v){ return { ok: true, cancelled: v === true, pageMs: performance.now() - t0 }; }, ' +
    'function(){ return { ok: false, cancelled: false, pageMs: performance.now() - t0 }; }); })()'
  )
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function positiveOption(options, name) {
  const value = options[name] === undefined ? DEFAULT_OPTIONS[name] : options[name]
  if (!finiteNonNegative(value) || value === 0) throw new Error(`${name} must be positive`)
  return value
}

function isTerminal(status) {
  return TERMINAL_ROUND_STATUSES.includes(status)
}

/**
 * @param {{
 *   page: { evaluate(expression: string): Promise<unknown> },
 *   lightChatId: string,
 *   heavyChatId: string,
 *   nowMs?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number, callTimeoutMs?: number,
 *   lightRoundTimeoutMs?: number, heavyRoundTimeoutMs?: number,
 *   heavyStartTimeoutMs?: number, lightGapMs?: number,
 *   cancelEvery?: number, cancelAfterMs?: number
 * }} options
 */
function createLiveLanes(options) {
  if (!isPlainObject(options) || !options.page || typeof options.page.evaluate !== 'function') {
    throw new Error('createLiveLanes needs a page adapter')
  }
  const config = laneObserverConfig({
    lightChatId: options.lightChatId,
    heavyChatId: options.heavyChatId
  })
  const page = options.page
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const pollMs = positiveOption(options, 'pollMs')
  const callTimeoutMs = positiveOption(options, 'callTimeoutMs')
  const lightRoundTimeoutMs = positiveOption(options, 'lightRoundTimeoutMs')
  const heavyRoundTimeoutMs = positiveOption(options, 'heavyRoundTimeoutMs')
  const heavyStartTimeoutMs = positiveOption(options, 'heavyStartTimeoutMs')
  const cancelAfterMs = positiveOption(options, 'cancelAfterMs')
  const lightGapMs =
    options.lightGapMs === undefined ? DEFAULT_OPTIONS.lightGapMs : options.lightGapMs
  if (!finiteNonNegative(lightGapMs)) throw new Error('lightGapMs must be non-negative')
  const cancelEvery = options.cancelEvery === undefined ? 0 : options.cancelEvery
  if (!Number.isSafeInteger(cancelEvery) || cancelEvery < 0) {
    throw new Error('cancelEvery must be a non-negative integer')
  }

  const call = (expression, what) =>
    withTimeout(
      Promise.resolve().then(() => page.evaluate(expression)),
      callTimeoutMs,
      what
    )

  // Observer state, fed by the pump.
  const since = { light: 0, heavy: 0 }
  const logs = { light: [], heavy: [] }
  const observed = {
    light: { roundId: null, status: null },
    heavy: { roundId: null, status: null }
  }
  const otherSource = { light: 0, heavy: 0 }
  let installId = null
  let faults = 0
  let observerFailure = null
  let stopped = false
  let pumping = null
  const waiters = new Set()

  const heavy = { rounds: [], idle: [], failure: null, sends: 0 }
  const light = { rounds: [], failure: null, sends: 0 }
  let heavyLoopRun = null
  let lightRunning = false

  async function readOnce() {
    const text = await call(readLaneObserverExpression(config, since), 'lane observer read')
    const read = parseLaneObserverRead(text, config, since, installId ?? undefined)
    if (!read.ok)
      throw laneError(`lane observer read refused: ${read.reason}`, 'T2_LIVE_LANE_OBSERVER', {
        reason: read.reason
      })
    for (const lane of LANES) {
      const laneRead = read.lanes[lane]
      if (laneRead.lost) {
        throw laneError(`lane observer lost ${lane} transitions`, 'T2_LIVE_LANE_OBSERVER', {
          reason: `${lane}_transitions_lost`
        })
      }
      for (const transition of laneRead.transitions) logs[lane].push(transition)
      if (laneRead.transitions.length > 0) {
        since[lane] = laneRead.transitions[laneRead.transitions.length - 1].seq
      }
      observed[lane] = { roundId: laneRead.roundId, status: laneRead.status }
      otherSource[lane] = laneRead.otherSource
    }
    faults = read.faults
    return read
  }

  function settleWaiters() {
    for (const waiter of [...waiters]) {
      const value = waiter.predicate(logs[waiter.lane])
      let result = null
      if (value !== null && value !== undefined) result = { value }
      else if (observerFailure !== null) result = { failure: observerFailure }
      else if (stopped) result = { failure: 'stopped' }
      else if (nowMs() > waiter.deadlineMs) result = { failure: 'unobserved' }
      if (result !== null) {
        waiters.delete(waiter)
        waiter.resolve(result)
      }
    }
  }

  /** Resolves `{ value }` once `predicate(log)` is non-null, else `{ failure }`. */
  function waitFor(lane, predicate, timeoutMs) {
    const waiter = { lane, predicate, deadlineMs: nowMs() + timeoutMs, resolve: null }
    const settled = new Promise((resolve) => {
      waiter.resolve = resolve
    })
    waiters.add(waiter)
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
    if (installId !== null) throw new Error('live lanes are already installed')
    const status = await call(installLaneObserverExpression(config), 'lane observer install')
    if (status !== 'installed') {
      throw laneError(`lane observer install answered ${String(status)}`, 'T2_LIVE_LANE_OBSERVER', {
        reason: String(status)
      })
    }
    installId = (await readOnce()).installId
    pumping = pump()
  }

  async function sendRound(lane, index) {
    const chatId = lane === 'light' ? config.lightChatId : config.heavyChatId
    const prompt = `M1 live lane ${lane} round ${index}: answer briefly.`
    const sentAtMs = nowMs()
    try {
      const reply = await call(sendRoundExpression(chatId, prompt), `runEnsembleRound (${lane})`)
      const acceptedAtMs = nowMs()
      return {
        status: isPlainObject(reply) && typeof reply.status === 'string' ? reply.status : null,
        roundId: isPlainObject(reply) && typeof reply.roundId === 'string' ? reply.roundId : null,
        pageMs: isPlainObject(reply) && finiteNonNegative(reply.pageMs) ? reply.pageMs : null,
        sentAtMs,
        acceptedAtMs
      }
    } catch (error) {
      return { error: (error && error.code) || 'send_failed', sentAtMs, acceptedAtMs: nowMs() }
    }
  }

  /** Why a send's answer does not start a new round, or null. */
  function sendProblem(lane, send, rounds) {
    if (send.error) return `${lane}_send_failed`
    if (send.status === 'steered') return `${lane}_steered`
    if (
      send.status !== 'started' ||
      send.roundId === null ||
      rounds.some((round) => round.roundId === send.roundId)
    ) {
      return `${lane}_not_started`
    }
    return null
  }

  /** A lane may send only when the observer shows no round it did not see end. */
  function busyProblem(lane) {
    if (observerFailure !== null) return observerFailure
    const current = observed[lane]
    return current.status === null || isTerminal(current.status) ? null : `${lane}_busy_before_send`
  }

  async function heavyLoop() {
    let lastEndMs = null
    while (!stopped && heavy.failure === null) {
      const busy = busyProblem('heavy')
      if (busy !== null) {
        heavy.failure = busy
        break
      }
      heavy.sends += 1
      const send = await sendRound('heavy', heavy.sends)
      const problem = sendProblem('heavy', send, heavy.rounds)
      if (problem !== null) {
        heavy.failure = problem
        break
      }
      if (lastEndMs !== null) heavy.idle.push({ fromMs: lastEndMs, toMs: send.acceptedAtMs })
      const round = {
        roundId: send.roundId,
        sentAtMs: send.sentAtMs,
        acceptedAtMs: send.acceptedAtMs,
        pageMs: send.pageMs,
        endedAtMs: null,
        status: null
      }
      heavy.rounds.push(round)
      const waited = await waitFor(
        'heavy',
        (log) => roundEndIn(log, round.roundId),
        heavyRoundTimeoutMs
      )
      if (waited.failure !== undefined) {
        if (waited.failure !== 'stopped') heavy.failure = heavyFailure(waited.failure)
        break
      }
      round.endedAtMs = waited.value.atMs
      round.status = waited.value.status
      lastEndMs = round.endedAtMs
    }
  }

  function heavyFailure(reason) {
    return reason.startsWith('observer_') ? reason : `heavy_${reason}`
  }

  function lightFailure(reason) {
    return reason.startsWith('observer_') ? reason : `light_${reason}`
  }

  /** Start the heavy lane; resolves once the observer has seen its first round. */
  async function startHeavy() {
    if (installId === null) throw new Error('install the lane observer first')
    if (heavyLoopRun !== null) throw new Error('the heavy lane is already running')
    heavyLoopRun = heavyLoop()
    const seen = await waitFor(
      'heavy',
      (log) => {
        if (heavy.failure !== null) return { failure: heavy.failure }
        const first = heavy.rounds[0]
        return first
          ? (log.find((transition) => transition.roundId === first.roundId) ?? null)
          : null
      },
      heavyStartTimeoutMs
    )
    const failure = seen.failure ?? (seen.value && seen.value.failure) ?? null
    if (failure !== null) {
      throw laneError(`the heavy lane did not start: ${failure}`, 'T2_LIVE_LANE_HEAVY', {
        reason: failure
      })
    }
  }

  async function cancelLater(round) {
    const dueAtMs = round.acceptedAtMs + cancelAfterMs
    const wait = dueAtMs - nowMs()
    if (wait > 0) await sleep(wait)
    if (roundEndIn(logs.light, round.roundId) !== null) {
      return { action: 'cancel', dueAtMs, skipped: 'round_ended' }
    }
    const sentAtMs = nowMs()
    try {
      const reply = await call(cancelRoundExpression(config.lightChatId), 'cancelEnsembleRound')
      return {
        action: 'cancel',
        dueAtMs,
        sentAtMs,
        returnedAtMs: nowMs(),
        ok: isPlainObject(reply) && reply.ok === true,
        cancelled: isPlainObject(reply) && reply.cancelled === true,
        pageMs: isPlainObject(reply) && finiteNonNegative(reply.pageMs) ? reply.pageMs : null
      }
    } catch (error) {
      return {
        action: 'cancel',
        dueAtMs,
        sentAtMs,
        returnedAtMs: nowMs(),
        ok: false,
        cancelled: false,
        error: (error && error.code) || 'cancel_failed'
      }
    }
  }

  /**
   * Send light rounds one at a time until `untilMs`, then wait for the last
   * one to end. Resolves with this run's rounds; a failure stops the lane.
   */
  async function runLight({ untilMs } = {}) {
    if (installId === null) throw new Error('install the lane observer first')
    if (!Number.isFinite(untilMs)) throw new Error('runLight needs untilMs')
    if (lightRunning) throw new Error('the light lane is already running')
    lightRunning = true
    const rounds = []
    try {
      while (light.failure === null && !stopped && nowMs() < untilMs) {
        const busy = busyProblem('light')
        if (busy !== null) {
          light.failure = busy
          break
        }
        light.sends += 1
        const send = await sendRound('light', light.sends)
        const problem = sendProblem('light', send, light.rounds)
        if (problem !== null) {
          light.failure = problem
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
        light.rounds.push(round)
        rounds.push(round)
        if (cancelEvery > 0 && light.sends % cancelEvery === 0)
          round.control = await cancelLater(round)
        const waited = await waitFor(
          'light',
          (log) => roundEndIn(log, round.roundId),
          lightRoundTimeoutMs
        )
        if (waited.failure !== undefined) {
          if (waited.failure !== 'stopped') light.failure = lightFailure(waited.failure)
          break
        }
        round.endedAtMs = waited.value.atMs
        round.status = waited.value.status
        if (nowMs() >= untilMs) break
        if (lightGapMs > 0) await sleep(lightGapMs)
      }
    } finally {
      lightRunning = false
    }
    const last = rounds[rounds.length - 1]
    return {
      rounds: rounds.map((round) => ({ ...round })),
      failure: light.failure,
      drainedAtMs: last && last.endedAtMs !== null ? last.endedAtMs : null
    }
  }

  function snapshot() {
    return {
      observer: {
        installId,
        faults,
        otherSource: { ...otherSource },
        failure: observerFailure
      },
      heavy: {
        rounds: heavy.rounds.map((round) => ({ ...round })),
        idle: heavy.idle.map((interval) => ({ ...interval })),
        failure: heavy.failure
      },
      light: {
        rounds: light.rounds.map((round) => ({ ...round })),
        failure: light.failure
      }
    }
  }

  /** Stop both lanes and the pump. The app's own rounds are left to run. */
  async function stop() {
    stopped = true
    settleWaiters()
    await Promise.allSettled([pumping, heavyLoopRun].filter(Boolean))
    return snapshot()
  }

  return { install, startHeavy, runLight, snapshot, stop }
}

module.exports = {
  DEFAULT_LIVE_LANE_OPTIONS: DEFAULT_OPTIONS,
  cancelRoundExpression,
  createLiveLanes,
  sendRoundExpression
}
