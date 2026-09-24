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
 *   `boundaryMix.normal`). A round that moves neither never reached D1.
 * - An unmeasured warm-up round, then one smoke round, through the
 *   renderer's own page API (`window.api.runEnsembleRound`), the same gates a
 *   user's send passes, and a verdict with its reasons.
 *
 * A round counts only when main answers `started` with a new round id, and it
 * is settled once main reports that round terminal (`getChat` of the one
 * light chat, read down to its active round's id and status) and no scripted
 * stream is open. Every page call is bounded. The smoke is sent only after
 * the warm-up settles, so it can never land in a live round and take the
 * queue or steer path.
 */

const { spawn: defaultSpawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

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

/** Daemon config for a live fixture: its one scripted tag and the run's seed. */
function buildScriptedDaemonConfig(fixture, options = {}) {
  const live = liveSeatsOf(fixture)
  const seed = options.seed === undefined ? fixture.seed : options.seed
  if (!Number.isSafeInteger(seed)) throw new Error('scripted daemon seed must be a safe integer')
  return {
    seed,
    models: [{ name: live.model }],
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
  'normalSaves: persistence.boundaryMix ? persistence.boundaryMix.normal : null }; }); })()'

async function readD1Counters(page, options = {}) {
  const value = await withTimeout(
    page.evaluate(D1_COUNTERS_EXPRESSION),
    options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    'getMainPerfSnapshot'
  )
  if (
    !isPlainObject(value) ||
    !Number.isSafeInteger(value.deferredAppends) ||
    !Number.isSafeInteger(value.normalSaves)
  ) {
    return null
  }
  return { deferredAppends: value.deferredAppends, normalSaves: value.normalSaves }
}

function d1Delta(before, after) {
  if (!before || !after) return null
  return {
    deferredAppends: after.deferredAppends - before.deferredAppends,
    normalSaves: after.normalSaves - before.normalSaves
  }
}

/**
 * Page-evaluated read of one chat's active round, reduced in the page to its
 * id and status: no content crosses to the runner.
 */
function roundStateExpression(chatId) {
  return (
    `Promise.resolve(window.api.getChat(${JSON.stringify(chatId)})).then(function(chat){ ` +
    'var round = chat && chat.ensemble && chat.ensemble.activeRound; ' +
    'return round ? { roundId: round.roundId, status: round.status } : null; })'
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
      'getChat'
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
}

/**
 * Why a live-round run is not evidence, or none. Each round must have been
 * started by main, settled as `completed`, and streamed at least one scripted
 * turn; the smoke must also move both D1 counters.
 */
function liveRoundsVerdict(rounds) {
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
      if (!(delta.deferredAppends > 0)) reasons.push('smoke: no deferred journal append')
      if (!(delta.normalSaves > 0)) reasons.push('smoke: no normal-boundary save')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * The warm-up round (a model's first use writes settings on main), then the
 * smoke round, each sent only once the one before it settled.
 */
async function runLiveRoundSequence(options) {
  const runRound = options.runRound || runLiveSmokeRound
  const rounds = []
  let previousRoundId = null
  for (const purpose of LIVE_ROUND_PURPOSES) {
    const round = await runRound({
      ...options.roundOptions,
      prompt: `M1 live ${purpose} round: answer briefly.`,
      previousRoundId
    })
    rounds.push({ ...round, purpose })
    if (typeof options.onRound === 'function') options.onRound(purpose, round)
    if (round.outcome !== 'settled') break
    previousRoundId = round.roundId
  }
  return { rounds, verdict: liveRoundsVerdict(rounds) }
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
  daemonStopFailures,
  liveRoundsVerdict,
  liveSeatsOf,
  neutralizeOllamaEnvironmentOnSpawnPlan,
  readD1Counters,
  readScriptedDaemonState,
  roundStateExpression,
  runLiveRoundSequence,
  runLiveSmokeRound,
  startScriptedDaemonChild,
  t2RunOk,
  withDaemonStopFailures
}
