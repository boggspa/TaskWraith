'use strict'

/**
 * M1 live driver, runner side (Independent Threads, slice S6).
 *
 * A live-round workload (`fixture.shape.liveSeats`, e.g.
 * `light_beside_large_live`) is driven by real Ensemble rounds rather than
 * replayed saves. Every seat runs the production Ollama adapter against the
 * harness's scripted daemon on loopback, so D1 soft flushes reach the
 * deferred journal through EnsembleOrchestrator as they do in production
 * (A1.40 Ruling 2). This module owns the runner's half of that:
 *
 * - The daemon child's lifecycle: spawn it with a config and a ready file,
 *   wait (bounded) for its address, and stop it (SIGTERM for its summary,
 *   SIGKILL after a bound). Its stdin is a pipe the daemon watches, so the
 *   daemon exits on its own if the runner dies without stopping it.
 * - The measured child's environment: operator variables that would take a
 *   round off the daemon are blanked, and the report says which were set.
 * - D1 evidence: `get-main-perf-snapshot` counters read through the page
 *   API before and after a round (`journal.deferredAppends`,
 *   `journal.unsyncedAppends`, `boundaryMix.normal`). A round that moves
 *   neither never reached D1. With barrier durability off the journal's
 *   appends take the deferred path, and with it on the unsynced one: each
 *   round and window is judged on the path its run pinned, and on no other.
 * - An unmeasured warm-up round, then one smoke round, through the
 *   renderer's own page API (`window.api.runEnsembleRound`), the same gates a
 *   user's send passes, and a verdict with its reasons.
 *
 * A round counts only when main answers `started` with a new round id, and it
 * is settled once compact renderer deliveries report that round terminal
 * through the lane observer and no scripted
 * stream is open. Every page call is bounded. The smoke is sent only after
 * the warm-up settles, so it can never land in a live round and take the
 * queue or steer path.
 */

const { spawn: defaultSpawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const {
  laneObserverConfig,
  installLaneObserverExpression,
  readLaneObserverExpression,
  uninstallLaneObserverExpression
} = require('./liveLaneObserver.cjs')

function smokeObserverConfig(chatId) {
  return {
    ...laneObserverConfig({ lightChatId: chatId, heavyChatId: 'perf-smoke-unused' }),
    globalName: '__TASKWRAITH_PERF_SMOKE__'
  }
}

const DAEMON_SCRIPT = path.join(__dirname, 'scriptedOllamaDaemon.cjs')
const DEFAULT_READY_TIMEOUT_MS = 10_000
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const DEFAULT_ROUND_TIMEOUT_MS = 180_000
const DEFAULT_POLL_MS = 500
const DEFAULT_STATE_TIMEOUT_MS = 2_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const TERMINAL_ROUND_STATUSES = new Set(['completed', 'cancelled', 'failed'])
const LIVE_ROUND_PURPOSES = Object.freeze(['warm_up', 'smoke'])
const STDERR_TAIL_BYTES = 4096
const LOOPBACK_BASE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function liveError(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** Reject with a named code when `promise` has not settled within `ms`. */
function withTimeout(promise, ms, what) {
  let timer = null
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(liveError(`${what} did not settle within ${ms} ms`, 'T2_LIVE_PAGE_CALL_TIMEOUT')),
      ms
    )
  })
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer))
}

/** The live seat a fixture declares, or a refusal for a replay workload. */
function liveSeatsOf(fixture) {
  const live =
    isPlainObject(fixture) && isPlainObject(fixture.shape) ? fixture.shape.liveSeats : null
  if (!isPlainObject(live) || live.provider !== 'ollama' || typeof live.model !== 'string') {
    throw liveError(
      'live rounds need a live-round workload (fixture.shape.liveSeats)',
      'T2_LIVE_ROUNDS_WORKLOAD'
    )
  }
  return live
}

/** Every scripted tag a live fixture's seats use: its seat tag, then one per chat. */
function liveModelsOf(fixture) {
  const live = liveSeatsOf(fixture)
  const chatModels = Array.isArray(live.chatModels) ? live.chatModels : []
  return [...new Set([live.model, ...chatModels])]
}

/** Daemon config for a live fixture: its scripted tags and the run's seed. */
function buildScriptedDaemonConfig(fixture, options = {}) {
  const models = liveModelsOf(fixture)
  const seed = options.seed === undefined ? fixture.seed : options.seed
  if (!Number.isSafeInteger(seed)) throw new Error('scripted daemon seed must be a safe integer')
  return {
    seed,
    models: models.map((name) => ({ name })),
    ...(options.shape === undefined ? {} : { shape: options.shape })
  }
}

/**
 * Spawn the scripted daemon as this runner's own child and wait for the ready
 * file it writes once listening. Refuses a ready file that names another pid
 * or a non-loopback address.
 */
async function startScriptedDaemonChild(options) {
  if (!isPlainObject(options) || typeof options.dir !== 'string' || !options.config) {
    throw new Error('startScriptedDaemonChild needs { dir, config }')
  }
  const spawn = options.spawn || defaultSpawn
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  fs.mkdirSync(options.dir, { recursive: true })
  const configPath = path.join(options.dir, 'scripted-ollama-config.json')
  const readyPath = path.join(options.dir, 'scripted-ollama-ready.json')
  const summaryPath = path.join(options.dir, 'scripted-ollama-summary.json')
  for (const stale of [readyPath, summaryPath]) fs.rmSync(stale, { force: true })
  fs.writeFileSync(configPath, JSON.stringify(options.config), { mode: 0o600 })

  const child = spawn(
    options.nodePath || process.execPath,
    [
      DAEMON_SCRIPT,
      `--config=${configPath}`,
      `--ready-file=${readyPath}`,
      `--summary-file=${summaryPath}`,
      '--exit-on-stdin-close'
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )
  let stderrTail = ''
  child.stderr?.on('data', (part) => {
    stderrTail = (stderrTail + String(part)).slice(-STDERR_TAIL_BYTES)
  })
  let exit = null
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    })
  })

  const kill = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const deadline = nowMs() + readyTimeoutMs
  let ready = null
  while (ready === null) {
    if (exit) {
      throw liveError(
        `scripted Ollama daemon exited before it was ready (code ${exit.code}, signal ${exit.signal})`,
        'T2_LIVE_DAEMON_EXITED',
        { stderrTail }
      )
    }
    try {
      ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'))
    } catch {
      if (nowMs() > deadline) {
        kill()
        throw liveError(
          `scripted Ollama daemon was not ready within ${readyTimeoutMs} ms`,
          'T2_LIVE_DAEMON_READY_TIMEOUT',
          { stderrTail }
        )
      }
      await sleep(25)
    }
  }
  if (
    !isPlainObject(ready) ||
    ready.pid !== child.pid ||
    typeof ready.baseUrl !== 'string' ||
    !LOOPBACK_BASE_URL.test(ready.baseUrl)
  ) {
    kill()
    throw liveError(
      'scripted Ollama daemon ready file does not describe this child on loopback',
      'T2_LIVE_DAEMON_READY_MISMATCH'
    )
  }

  let stopping = null
  return {
    pid: child.pid,
    baseUrl: ready.baseUrl,
    stop() {
      if (stopping) return stopping
      stopping = (async () => {
        if (!exit) {
          try {
            child.kill('SIGTERM')
          } catch {
            // Exited between the check and the signal.
          }
          let timer = null
          const settled = await Promise.race([
            exited,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), stopTimeoutMs)
            })
          ])
          clearTimeout(timer)
          if (!settled) {
            kill()
            await exited
          }
        }
        let summary = null
        try {
          summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        } catch {
          summary = null
        }
        return { exit, forced: exit?.signal === 'SIGKILL', summary, stderrTail }
      })()
      return stopping
    }
  }
}

/** The daemon's live counts from its harness-only route, read with a bound. */
async function readScriptedDaemonState(baseUrl, options = {}) {
  if (typeof baseUrl !== 'string' || !LOOPBACK_BASE_URL.test(baseUrl)) {
    throw new Error('readScriptedDaemonState needs the daemon loopback base URL')
  }
  const fetchImpl = options.fetch || fetch
  let response = null
  let body = null
  try {
    response = await fetchImpl(`${baseUrl}/_scripted/state`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_STATE_TIMEOUT_MS)
    })
    body = response.ok ? await response.json() : null
  } catch (error) {
    throw liveError(
      `scripted Ollama daemon state read failed: ${String(error?.message || error)}`,
      'T2_LIVE_DAEMON_STATE'
    )
  }
  if (
    !isPlainObject(body) ||
    !Number.isSafeInteger(body.inFlight) ||
    !Number.isSafeInteger(body.turnsDone)
  ) {
    throw liveError(
      `scripted Ollama daemon state read failed (HTTP ${response.status})`,
      'T2_LIVE_DAEMON_STATE'
    )
  }
  return { inFlight: body.inFlight, turnsDone: body.turnsDone }
}

const ACTIVITY_FIELDS = Object.freeze(['started', 'done', 'busyMs', 'maxQuietMs'])

/**
 * One scripted tag's turns over [fromMs, toMs) from the daemon's harness-only
 * route: how many started, how many of those completed, how long one was
 * streaming, and the longest stretch in which none was. Read with a bound.
 */
async function readScriptedDaemonActivity(baseUrl, options) {
  if (typeof baseUrl !== 'string' || !LOOPBACK_BASE_URL.test(baseUrl)) {
    throw new Error('readScriptedDaemonActivity needs the daemon loopback base URL')
  }
  const { model, fromMs, toMs } = isPlainObject(options) ? options : {}
  if (
    typeof model !== 'string' ||
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    fromMs < 0 ||
    toMs <= fromMs
  ) {
    throw new Error('readScriptedDaemonActivity needs a tag and a range of whole milliseconds')
  }
  const fetchImpl = options.fetch || fetch
  const query = `model=${encodeURIComponent(model)}&from=${fromMs}&to=${toMs}`
  let response = null
  let body = null
  try {
    response = await fetchImpl(`${baseUrl}/_scripted/activity?${query}`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_STATE_TIMEOUT_MS)
    })
    body = response.ok ? await response.json() : null
  } catch (error) {
    throw liveError(
      `scripted Ollama daemon activity read failed: ${String(error?.message || error)}`,
      'T2_LIVE_DAEMON_STATE'
    )
  }
  const span = toMs - fromMs
  if (
    !isPlainObject(body) ||
    body.model !== model ||
    body.fromMs !== fromMs ||
    body.toMs !== toMs ||
    ACTIVITY_FIELDS.some((field) => !Number.isSafeInteger(body[field]) || body[field] < 0) ||
    body.done > body.started ||
    body.busyMs > span ||
    body.maxQuietMs > span
  ) {
    throw liveError(
      `scripted Ollama daemon activity read failed (HTTP ${response.status})`,
      'T2_LIVE_DAEMON_STATE'
    )
  }
  return {
    started: body.started,
    done: body.done,
    busyMs: body.busyMs,
    maxQuietMs: body.maxQuietMs
  }
}

const TURN_OUTCOMES = Object.freeze(['streaming', 'done', 'aborted', 'fault-omit-done'])

/** One turn of the daemon's answer, or null when it is not a turn of the range. */
function scriptedTurnOf(value, fromMs, toMs) {
  if (!isPlainObject(value)) return null
  const { model, startedAtMs, endedAtMs, outcome } = value
  if (typeof model !== 'string' || !TURN_OUTCOMES.includes(outcome)) return null
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || startedAtMs >= toMs) return null
  // Only a turn still streaming has no end.
  if ((endedAtMs === null) !== (outcome === 'streaming')) return null
  if (endedAtMs !== null) {
    if (!Number.isSafeInteger(endedAtMs) || endedAtMs < startedAtMs || endedAtMs < fromMs) {
      return null
    }
  }
  return { model, startedAtMs, endedAtMs, outcome }
}

/**
 * Every scripted tag's turns that were streaming at some moment of
 * [fromMs, toMs), in start order, from the daemon's harness-only route: each
 * as its tag, when it began and ended, and how. Read with a bound.
 */
async function readScriptedDaemonTurns(baseUrl, options) {
  if (typeof baseUrl !== 'string' || !LOOPBACK_BASE_URL.test(baseUrl)) {
    throw new Error('readScriptedDaemonTurns needs the daemon loopback base URL')
  }
  const { fromMs, toMs } = isPlainObject(options) ? options : {}
  if (
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    fromMs < 0 ||
    toMs <= fromMs
  ) {
    throw new Error('readScriptedDaemonTurns needs a range of whole milliseconds')
  }
  const fetchImpl = options.fetch || fetch
  let response = null
  let body = null
  try {
    response = await fetchImpl(`${baseUrl}/_scripted/turns?from=${fromMs}&to=${toMs}`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_STATE_TIMEOUT_MS)
    })
    body = response.ok ? await response.json() : null
  } catch (error) {
    throw liveError(
      `scripted Ollama daemon turns read failed: ${String(error?.message || error)}`,
      'T2_LIVE_DAEMON_STATE'
    )
  }
  const turns =
    isPlainObject(body) && body.fromMs === fromMs && body.toMs === toMs && Array.isArray(body.turns)
      ? body.turns.map((turn) => scriptedTurnOf(turn, fromMs, toMs))
      : null
  if (
    !turns ||
    turns.includes(null) ||
    turns.some((turn, index) => index > 0 && turn.startedAtMs < turns[index - 1].startedAtMs)
  ) {
    throw liveError(
      `scripted Ollama daemon turns read failed (HTTP ${response.status})`,
      'T2_LIVE_DAEMON_STATE'
    )
  }
  return turns
}

/**
 * Operator variables the app reads that would take a live round off the
 * scripted daemon: a Cloud key sends the Host's catalog refresh to
 * ollama.com, and a declared model ceiling arms main's local admission gate.
 * Both readers take an empty value as unset.
 */
const NEUTRALIZED_OLLAMA_ENV_KEYS = Object.freeze(['OLLAMA_API_KEY', 'OLLAMA_MAX_LOADED_MODELS'])

/**
 * Blank those variables for the measured child, which layers its plan env
 * over the runner's own. The record names each key and whether the runner
 * had it set, never a value.
 */
function neutralizeOllamaEnvironmentOnSpawnPlan(spawnPlan, inheritedEnv) {
  if (
    !isPlainObject(spawnPlan) ||
    !isPlainObject(spawnPlan.env) ||
    typeof spawnPlan.shellCommand !== 'string'
  ) {
    throw new Error('spawn plan with an env and a shellCommand is required')
  }
  const blanked = {}
  const neutralized = []
  for (const key of NEUTRALIZED_OLLAMA_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(spawnPlan.env, key)) {
      throw new Error(`spawn plan already sets ${key}`)
    }
    blanked[key] = ''
    const value = isPlainObject(inheritedEnv) ? inheritedEnv[key] : undefined
    neutralized.push({ key, inherited: typeof value === 'string' && value.trim() !== '' })
  }
  return {
    spawnPlan: {
      ...spawnPlan,
      env: { ...spawnPlan.env, ...blanked },
      shellCommand: `env ${NEUTRALIZED_OLLAMA_ENV_KEYS.map((key) => `${key}=`).join(' ')} ${spawnPlan.shellCommand}`
    },
    record: { neutralized }
  }
}

/** Page-evaluated read of main's D1 counters; null when the section is absent. */
const D1_COUNTERS_EXPRESSION =
  '(function(){ return Promise.resolve(window.api.getMainPerfSnapshot()).then(function(snapshot){ ' +
  'var persistence = snapshot && snapshot.sections && snapshot.sections.incrementalChatPersistence; ' +
  'if (!persistence) return null; ' +
  'return { deferredAppends: persistence.journal ? persistence.journal.deferredAppends : null, ' +
  'unsyncedAppends: persistence.journal ? persistence.journal.unsyncedAppends : null, ' +
  'normalSaves: persistence.boundaryMix ? persistence.boundaryMix.normal : null }; }); })()'

/**
 * D1 counters as read, or null without the two every build counts. A build
 * from before barrier durability counts no unsynced appends: null there.
 */
function d1CountersOf(value) {
  if (
    !isPlainObject(value) ||
    !Number.isSafeInteger(value.deferredAppends) ||
    !Number.isSafeInteger(value.normalSaves)
  ) {
    return null
  }
  return {
    deferredAppends: value.deferredAppends,
    unsyncedAppends: Number.isSafeInteger(value.unsyncedAppends) ? value.unsyncedAppends : null,
    normalSaves: value.normalSaves
  }
}

async function readD1Counters(page, options = {}) {
  const value = await withTimeout(
    page.evaluate(D1_COUNTERS_EXPRESSION),
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    'getMainPerfSnapshot'
  )
  return d1CountersOf(value)
}

function d1Delta(before, after) {
  if (!before || !after) return null
  return {
    deferredAppends: after.deferredAppends - before.deferredAppends,
    unsyncedAppends:
      Number.isSafeInteger(before.unsyncedAppends) && Number.isSafeInteger(after.unsyncedAppends)
        ? after.unsyncedAppends - before.unsyncedAppends
        : null,
    normalSaves: after.normalSaves - before.normalSaves
  }
}

/**
 * The journal's two paths: deferred appends with barrier durability off,
 * unsynced appends with it on. Each names its counter and the other path.
 */
const JOURNAL_PATHS = Object.freeze({
  deferred: { counter: 'deferredAppends', other: 'unsynced' },
  unsynced: { counter: 'unsyncedAppends', other: 'deferred' }
})
/** Each journal path reason, as the smoke's verdict says it. */
const JOURNAL_PATH_WORDS = Object.freeze({
  no_deferred_append: 'no deferred journal append',
  no_unsynced_append: 'no unsynced journal append',
  deferred_append: 'deferred journal appends with barrier durability on',
  unsynced_append: 'unsynced journal appends with barrier durability off',
  deferred_appends_uncounted: 'deferred journal appends not counted',
  unsynced_appends_uncounted: 'unsynced journal appends not counted'
})

/** The journal path a run's pinned barrier durability sends its appends down. */
function journalPathFor(barrierDurability) {
  if (barrierDurability === 'on') return 'unsynced'
  if (barrierDurability === 'off') return 'deferred'
  throw new Error("barrier durability must be pinned 'on' or 'off'")
}

/**
 * Why a D1 delta does not show its journal path: no append on it, or one on
 * the other path, which proves that path was off.
 */
function journalPathReasons(delta, journalPath) {
  const reasons = []
  const own = JOURNAL_PATHS[journalPath]
  const ownCount = delta[own.counter]
  const otherCount = delta[JOURNAL_PATHS[own.other].counter]
  if (!Number.isSafeInteger(ownCount)) reasons.push(`${journalPath}_appends_uncounted`)
  else if (!(ownCount > 0)) reasons.push(`no_${journalPath}_append`)
  if (!Number.isSafeInteger(otherCount)) reasons.push(`${own.other}_appends_uncounted`)
  else if (otherCount !== 0) reasons.push(`${own.other}_append`)
  return reasons
}

/** Main's barrier switch in one fence's read of its section, or null when the read cannot say. */
function barrierEnabledIn(read) {
  return isPlainObject(read) &&
    read.ok === true &&
    isPlainObject(read.section) &&
    typeof read.section.enabled === 'boolean'
    ? read.section.enabled
    : null
}

/**
 * Why a measured window's D1 counters do not show the journal path its run
 * pinned. Main's barrier section, read at the window's two fences, says
 * which path main took: a section that cannot say, or that says other than
 * the pin, fails the window, and its counters are not judged.
 */
function windowJournalPathReasons({ d1, barrierBefore, barrierAfter, barrierDurability }) {
  const pinned = journalPathFor(barrierDurability)
  if (d1 === null) return ['d1_counters_unavailable']
  const enabled = barrierEnabledIn(barrierBefore)
  if (enabled === null || barrierEnabledIn(barrierAfter) !== enabled) {
    return ['d1_path_unconfirmed']
  }
  if (enabled !== (pinned === 'unsynced')) {
    return [`barrier_switch_${enabled ? 'on' : 'off'}_in_main`]
  }
  return journalPathReasons(d1, pinned).map((reason) => `d1_${reason}`)
}

/**
 * Page-evaluated read of one chat's active round, reduced in the page to its
 * id and status: no content crosses to the runner.
 */
function roundStateExpression(chatId) {
  const expression = readLaneObserverExpression(smokeObserverConfig(chatId))
  return (
    `Promise.resolve(${expression}).then(function(raw){ ` +
    'if (!raw) return null; var state = JSON.parse(raw); var lane = state.lanes.light; ' +
    'if (state.faults || lane.firstRetainedSeq !== 1) throw new Error("Smoke observer censored"); ' +
    'return { roundId: lane.roundId, status: lane.status }; })'
  )
}

/**
 * Send one Ensemble round through the page API and wait for main to report
 * it terminal with no scripted stream open.
 *
 * @param {{
 *   page: { evaluate(expression: string): Promise<unknown> },
 *   chatId: string,
 *   prompt: string,
 *   readDaemonState: () => Promise<{ inFlight: number, turnsDone: number }>,
 *   previousRoundId?: string | null,
 *   nowMs?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   callTimeoutMs?: number
 * }} options
 */
async function runLiveSmokeRound(options) {
  const { page, chatId, prompt, readDaemonState } = options
  if (!page || typeof page.evaluate !== 'function' || typeof readDaemonState !== 'function') {
    throw new Error('runLiveSmokeRound needs a page adapter and a daemon state reader')
  }
  if (typeof chatId !== 'string' || !chatId || typeof prompt !== 'string' || !prompt) {
    throw new Error('runLiveSmokeRound needs a chat id and a prompt')
  }
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROUND_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const previousRoundId = options.previousRoundId ?? null

  const observerConfig = smokeObserverConfig(chatId)
  const installToken = JSON.stringify(require('node:crypto').randomUUID())
  const installExpression = `(function(){ var cancelled = window.__TASKWRAITH_SMOKE_CANCELLED__ || {}; if (cancelled[${installToken}]) return 'install_cancelled'; return ${installLaneObserverExpression(observerConfig)}; })()`
  const cleanupExpression = `(function(){ var cancelled = window.__TASKWRAITH_SMOKE_CANCELLED__ || (window.__TASKWRAITH_SMOKE_CANCELLED__ = {}); cancelled[${installToken}] = true; return ${uninstallLaneObserverExpression(observerConfig)}; })()`
  try {
    const installed = await withTimeout(
      page.evaluate(installExpression),
      callTimeoutMs,
      'install smoke observer'
    )
    if (installed !== 'installed') throw new Error('Smoke observer installation refused')
    const baseline = await readDaemonState()
    const d1Before = await readD1Counters(page, { timeoutMs: callTimeoutMs })
    const sentAtMs = nowMs()
    const started = await withTimeout(
      page.evaluate(
        `Promise.resolve(window.api.runEnsembleRound(${JSON.stringify({ chatId, prompt })}))`
      ),
      callTimeoutMs,
      'runEnsembleRound'
    )
    const acceptedAtMs = nowMs()
    const status =
      isPlainObject(started) && typeof started.status === 'string' ? started.status : null
    const roundId =
      isPlainObject(started) && typeof started.roundId === 'string' ? started.roundId : null
    const accepted = { status, roundId, sentAtMs, acceptedAtMs }
    if (status !== 'started' || roundId === null || roundId === previousRoundId) {
      const state = await readDaemonState()
      return {
        outcome: 'not_started',
        ...accepted,
        roundStatus: null,
        settledAtMs: null,
        turnsFinished: state.turnsDone - baseline.turnsDone,
        d1: { before: d1Before, after: null, delta: null }
      }
    }

    const deadline = sentAtMs + timeoutMs
    let outcome = 'timeout'
    let roundStatus = null
    let settledAtMs = null
    let state = baseline
    while (nowMs() <= deadline) {
      const round = await withTimeout(
        page.evaluate(roundStateExpression(chatId)),
        callTimeoutMs,
        'smoke observer read'
      )
      if (isPlainObject(round) && round.roundId === roundId && typeof round.status === 'string') {
        roundStatus = round.status
      }
      state = await readDaemonState()
      if (TERMINAL_ROUND_STATUSES.has(roundStatus) && state.inFlight === 0) {
        outcome = 'settled'
        settledAtMs = nowMs()
        break
      }
      await sleep(pollMs)
    }
    const d1After = await readD1Counters(page, { timeoutMs: callTimeoutMs })
    return {
      outcome,
      ...accepted,
      roundStatus,
      settledAtMs,
      turnsFinished: state.turnsDone - baseline.turnsDone,
      d1: { before: d1Before, after: d1After, delta: d1Delta(d1Before, d1After) }
    }
  } finally {
    await withTimeout(page.evaluate(cleanupExpression), callTimeoutMs, 'remove smoke observer')
  }
}

/**
 * Why a live-round run is not evidence, or none. Each round must have been
 * started by main, settled as `completed`, and streamed at least one scripted
 * turn; the smoke must also make a normal-boundary save and show its run's
 * journal path (`barrierDurability`, as the run pinned it).
 */
function liveRoundsVerdict(rounds, options = {}) {
  const journalPath = journalPathFor(options.barrierDurability)
  const reasons = []
  const list = Array.isArray(rounds) ? rounds : []
  for (const purpose of LIVE_ROUND_PURPOSES) {
    const round = list.find((entry) => entry && entry.purpose === purpose)
    if (!round) {
      reasons.push(`${purpose}: not sent`)
      continue
    }
    if (round.outcome === 'not_started') {
      reasons.push(`${purpose}: not started (main answered ${round.status ?? 'nothing'})`)
      continue
    }
    if (round.outcome !== 'settled') reasons.push(`${purpose}: ${round.outcome}`)
    else if (round.roundStatus !== 'completed') {
      reasons.push(`${purpose}: round ended ${round.roundStatus}`)
    }
    if (!(round.turnsFinished > 0)) reasons.push(`${purpose}: no scripted turn finished`)
    if (purpose !== 'smoke') continue
    const delta = round.d1 && round.d1.delta
    if (!delta) reasons.push('smoke: D1 counters unavailable')
    else {
      for (const reason of journalPathReasons(delta, journalPath)) {
        reasons.push(`smoke: ${JOURNAL_PATH_WORDS[reason]}`)
      }
      if (!(delta.normalSaves > 0)) reasons.push('smoke: no normal-boundary save')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * The warm-up round (a model's first use writes settings on main), then the
 * smoke round, each sent only once the one before it settled.
 */
/** The prompt of the live round sent for `purpose`, one of LIVE_ROUND_PURPOSES. */
function liveRoundPrompt(purpose) {
  return `M1 live ${purpose} round: answer briefly.`
}

async function runLiveRoundSequence(options) {
  // Checked before anything is sent: the smoke is judged on the run's path.
  journalPathFor(options.barrierDurability)
  const runRound = options.runRound || runLiveSmokeRound
  const rounds = []
  const heavyWarmups = []
  let previousRoundId = null
  for (const chatId of options.heavyChatIds || []) {
    const warm = await runRound({
      ...options.roundOptions,
      chatId,
      prompt: 'M5 heavy warm-up save: answer briefly.',
      previousRoundId: null
    })
    heavyWarmups.push({ ...warm, chatId, purpose: 'heavy_warm_up' })
    rounds.push({ ...warm, chatId, purpose: 'heavy_warm_up' })
    if (
      warm.outcome !== 'settled' ||
      warm.roundStatus !== 'completed' ||
      !(warm.turnsFinished > 0) ||
      !(warm.d1?.delta?.normalSaves > 0)
    )
      return {
        rounds,
        heavyWarmups,
        verdict: { ok: false, reasons: ['heavy warm-up save unproven'] }
      }
  }
  for (const purpose of LIVE_ROUND_PURPOSES) {
    const round = await runRound({
      ...options.roundOptions,
      prompt: liveRoundPrompt(purpose),
      previousRoundId
    })
    rounds.push({ ...round, purpose })
    if (typeof options.onRound === 'function') options.onRound(purpose, round)
    if (round.outcome !== 'settled') break
    previousRoundId = round.roundId
  }
  return {
    rounds,
    heavyWarmups,
    verdict: liveRoundsVerdict(rounds, { barrierDurability: options.barrierDurability })
  }
}

/**
 * A live-round verdict that also answers for the daemon's own record: the
 * report's per-turn hashes are evidence only from a daemon that stopped
 * cleanly and wrote its summary.
 */
function withDaemonStopFailures(verdict, failures) {
  if (!isPlainObject(verdict) || !Array.isArray(failures) || failures.length === 0) return verdict
  return {
    ok: false,
    reasons: [...verdict.reasons, ...failures.map((failure) => `daemon: ${failure}`)]
  }
}

/**
 * A T2 run's result is ok unless its live-round verdict failed. Cleanup
 * failures keep their existing channel and never change it.
 */
function t2RunOk(report) {
  const verdict = isPlainObject(report) && report.liveRounds ? report.liveRounds.verdict : undefined
  return !(isPlainObject(verdict) && verdict.ok === false)
}

/** Cleanup failures a daemon stop reports: killed, crashed, or silent. */
function daemonStopFailures(stopped) {
  const failures = []
  if (!isPlainObject(stopped)) return ['scripted Ollama daemon stop returned nothing']
  if (stopped.forced) failures.push('scripted Ollama daemon ignored SIGTERM and was killed')
  else if (stopped.exit && stopped.exit.code !== 0) {
    failures.push(
      `scripted Ollama daemon exited with code ${stopped.exit.code} (signal ${stopped.exit.signal})`
    )
  }
  if (!stopped.summary) failures.push('scripted Ollama daemon wrote no summary')
  return failures
}

module.exports = {
  D1_COUNTERS_EXPRESSION,
  LIVE_ROUND_PURPOSES,
  NEUTRALIZED_OLLAMA_ENV_KEYS,
  buildScriptedDaemonConfig,
  d1CountersOf,
  d1Delta,
  daemonStopFailures,
  journalPathFor,
  liveRoundsVerdict,
  liveModelsOf,
  liveRoundPrompt,
  liveSeatsOf,
  neutralizeOllamaEnvironmentOnSpawnPlan,
  readD1Counters,
  readScriptedDaemonActivity,
  readScriptedDaemonState,
  readScriptedDaemonTurns,
  roundStateExpression,
  runLiveRoundSequence,
  runLiveSmokeRound,
  startScriptedDaemonChild,
  t2RunOk,
  windowJournalPathReasons,
  withDaemonStopFailures
}
