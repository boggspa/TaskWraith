'use strict'

/**
 * M1 Wall 1 — control-action replay driver (the FIRST control driver).
 *
 * Drives a caller-supplied schedule of control actions (cancel,
 * approval_decision, question_answer, seat_toggle — CONTROL_ACTIONS) against
 * an injected adapter, sequentially in array order: control-plane operations
 * are ordered, so this driver never has two actions in flight. Each action is
 * timed on a guarded monotonic clock, bounded by an optional per-action
 * timeout and an optional overall deadline, and recorded with an honest
 * outcome — completed, failed, unsupported, censored (cut off by the
 * deadline), or not_attempted (the schedule stopped before it).
 *
 * The adapter owns effects: `api.issueControlAction({ seq, action, target,
 * args })` may return `{ ok: true }`, `{ ok: false, reason? }`,
 * `{ unsupported: reason }`, or throw/reject. Anything else fails closed as
 * `action_invalid_result`. Adapter-declared reasons are recorded verbatim
 * (the lanes driver's split); exception text is NOT — a throw records
 * `action_threw`, never the payload.
 *
 * The driver deliberately does NOT map actions onto Host commands itself:
 * CONTROL_ACTION_HOST_COMMANDS names the dispatched command per action
 * (verified against HostNodeDomainPorts dispatch) for the future attached
 * adapter. It also emits no evidence-v1 block: window/population shaping is
 * runner work once the remaining Wall 1 capabilities land. A timed-out or
 * deadline-cut action whose effect may still land is reported as a pending
 * effect, and its chats stay reserved until the underlying promise settles.
 *
 * WHAT THIS DRIVER DOES NOT DO: no provider runs, no Ensemble-pool or
 * Host-native saturation — each has its own driver now
 * (deterministicReplayProvider.cjs, ensemblePoolSaturation.cjs,
 * hostNativeSaturation.cjs), so interferenceMatrix.cjs declares no missing
 * capability today; that is capability existence, not executability.
 * A timer cannot preempt synchronously blocking adapter work.
 */

const { CONTROL_ACTIONS } = require('./interferenceMatrix.cjs')
const { percentileSummary } = require('./concurrentReplayLanes.cjs')

/** Control action → dispatched Host command (HostNodeDomainPorts dispatch). */
const CONTROL_ACTION_HOST_COMMANDS = Object.freeze({
  cancel: 'run.cancel',
  approval_decision: 'approval.decide',
  question_answer: 'question.answer',
  seat_toggle: 'ensemble.seat.toggle'
})

const MAX_TIMER_MS = 2 ** 31 - 1

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function duration(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(label + ' must be a finite positive timer duration')
  }
  return value
}

function makeClock(nowMs) {
  if (nowMs !== undefined && typeof nowMs !== 'function')
    throw new Error('nowMs must be a function')
  const now = nowMs || (() => require('node:perf_hooks').performance.now())
  let last = null
  return () => {
    const value = now()
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (last !== null && value < last)
    ) {
      throw new Error('nowMs must produce finite non-negative monotonic readings')
    }
    last = value
    return value
  }
}

function clearTimer(timers, timer) {
  if (timer === null) return
  try {
    timers.clearTimeout(timer)
  } catch {
    /* A cleanup seam cannot strand ownership. */
  }
}

// One control schedule at a time per target chat on one adapter: two
// concurrent runs over the same chat would interleave control-plane effects.
const activeTargets = new WeakMap()

async function runControlActionReplay(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  const api = options.api
  if (!isPlainObject(api) || typeof api.issueControlAction !== 'function') {
    throw new Error('api.issueControlAction required')
  }
  const schedule = options.schedule
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new Error('schedule must be a non-empty array')
  }
  const seqs = new Set()
  schedule.forEach((event, index) => {
    if (!isPlainObject(event)) throw new Error(`schedule entry ${index} must be an object`)
    if (!Number.isSafeInteger(event.seq) || seqs.has(event.seq)) {
      throw new Error('schedule seqs must be unique safe integers')
    }
    seqs.add(event.seq)
    if (!CONTROL_ACTIONS.includes(event.action)) {
      throw new Error(`schedule action must be one of ${CONTROL_ACTIONS.join('|')}`)
    }
    if (
      !isPlainObject(event.target) ||
      typeof event.target.chatId !== 'string' ||
      event.target.chatId.trim().length === 0
    ) {
      throw new Error('schedule target.chatId required')
    }
    if (event.args !== undefined && !isPlainObject(event.args)) {
      throw new Error('schedule args must be an object')
    }
  })
  if (options.actionTimeoutMs !== undefined) duration(options.actionTimeoutMs, 'actionTimeoutMs')
  if (options.deadlineMs !== undefined) duration(options.deadlineMs, 'deadlineMs')
  const timers = options.timers ?? { setTimeout, clearTimeout }
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new Error('timers require setTimeout and clearTimeout')
  }
  if (options.diagnosticOnly !== undefined && typeof options.diagnosticOnly !== 'boolean') {
    throw new Error('diagnosticOnly must be boolean')
  }
  const clock = makeClock(options.nowMs)

  const chatIds = [...new Set(schedule.map((event) => event.target.chatId))]
  let owners = activeTargets.get(api)
  if (!owners) activeTargets.set(api, (owners = new Map()))
  if (chatIds.some((chatId) => owners.has(chatId))) {
    throw new Error('control target still owned by another replay')
  }
  const token = {}
  for (const chatId of chatIds) owners.set(chatId, token)
  const release = () => {
    for (const chatId of chatIds) if (owners.get(chatId) === token) owners.delete(chatId)
  }

  let fenceReason = null
  let clockFailed = false
  let resolveFence
  const fence = new Promise((resolve) => {
    resolveFence = resolve
  })
  const stop = (reason) => {
    if (fenceReason !== null) return
    fenceReason = reason
    resolveFence({ fence: true })
  }
  const readTime = () => {
    try {
      return clock()
    } catch {
      clockFailed = true
      stop('clock_invalid')
      return null
    }
  }

  const actions = []
  const cutAttempts = []
  let deadlineTimer = null
  const startedAtMs = readTime()
  const deadlineAtMs =
    startedAtMs === null || options.deadlineMs === undefined
      ? null
      : startedAtMs + options.deadlineMs
  if (startedAtMs !== null && options.deadlineMs !== undefined) {
    try {
      deadlineTimer = timers.setTimeout(() => stop('deadline'), Math.ceil(options.deadlineMs))
    } catch {
      clockFailed = true
      stop('deadline_timer_failed')
    }
  }

  const recordNotAttempted = (event) => {
    actions.push({
      seq: event.seq,
      action: event.action,
      chatId: event.target.chatId,
      target: JSON.parse(JSON.stringify(event.target)),
      outcome: 'not_attempted',
      latencyMs: null,
      reason: fenceReason,
      apiCalls: 0,
      pendingEffect: false
    })
  }

  try {
    for (const event of schedule) {
      if (fenceReason !== null) {
        recordNotAttempted(event)
        continue
      }
      const started = readTime()
      if (started === null) {
        recordNotAttempted(event)
        continue
      }
      if (deadlineAtMs !== null && started >= deadlineAtMs) {
        stop('deadline')
        recordNotAttempted(event)
        continue
      }
      const record = {
        seq: event.seq,
        action: event.action,
        chatId: event.target.chatId,
        target: JSON.parse(JSON.stringify(event.target)),
        outcome: null,
        latencyMs: null,
        reason: null,
        apiCalls: 1,
        pendingEffect: false
      }
      actions.push(record)
      const attempt = new Promise((resolve) => {
        let actionTimer = null
        record.clearActionTimer = () => clearTimer(timers, actionTimer)
        if (options.actionTimeoutMs !== undefined) {
          try {
            actionTimer = timers.setTimeout(
              () => stop('action_timeout'),
              Math.ceil(options.actionTimeoutMs)
            )
          } catch {
            resolve({ type: 'timer_failed' })
            return
          }
        }
        let result
        try {
          result = api.issueControlAction({
            seq: event.seq,
            action: event.action,
            target: event.target,
            ...(event.args === undefined ? {} : { args: event.args })
          })
        } catch {
          resolve({ type: 'threw' })
          return
        }
        Promise.resolve(result).then(
          (value) => resolve({ type: 'settled', value }),
          () => resolve({ type: 'rejected' })
        )
      })
      const raced = await Promise.race([attempt, fence.then(() => ({ type: 'fenced' }))])
      record.clearActionTimer()
      delete record.clearActionTimer
      if (raced.type === 'settled') {
        const finished = readTime()
        const value = raced.value
        if (finished === null) {
          // The effect happened but the measurement is gone: completed
          // without a latency, and the run still fails on the clock.
          record.outcome = 'completed'
        } else if (isPlainObject(value) && value.ok === true) {
          record.outcome = 'completed'
          record.latencyMs = finished - started
        } else if (isPlainObject(value) && typeof value.unsupported === 'string') {
          record.outcome = 'unsupported'
          record.reason = value.unsupported
        } else if (isPlainObject(value) && value.ok === false) {
          record.outcome = 'failed'
          record.reason =
            typeof value.reason === 'string' && value.reason ? value.reason : 'action_failed'
        } else {
          record.outcome = 'failed'
          record.reason = 'action_invalid_result'
        }
      } else if (raced.type === 'threw') {
        record.outcome = 'failed'
        record.reason = 'action_threw'
      } else if (raced.type === 'rejected') {
        record.outcome = 'failed'
        record.reason = 'action_rejected'
      } else if (raced.type === 'timer_failed') {
        record.outcome = 'failed'
        record.reason = 'action_timer_failed'
        stop('action_timer_failed')
      } else {
        // Cut by a fence while the effect may still land: conservative and
        // explicit. The reservation below survives until it settles.
        cutAttempts.push(attempt)
        record.pendingEffect = true
        if (fenceReason === 'action_timeout') {
          record.outcome = 'failed'
          record.reason = 'action_timeout'
        } else {
          record.outcome = 'censored'
          record.reason = fenceReason
        }
      }
    }
  } finally {
    clearTimer(timers, deadlineTimer)
    if (cutAttempts.length === 0) {
      release()
    } else {
      Promise.allSettled(cutAttempts).then(release)
    }
  }

  const endedAtMs = readTime()
  const failed = clockFailed || actions.some((action) => action.outcome === 'failed')
  const unsupported = actions.some((action) => action.outcome === 'unsupported')
  const incomplete = actions.some((action) => action.pendingEffect)
  const censored = actions.some(
    (action) => action.outcome === 'censored' || action.outcome === 'not_attempted'
  )
  const status = failed
    ? 'failed'
    : unsupported
      ? 'unsupported'
      : incomplete
        ? 'incomplete'
        : censored
          ? 'censored'
          : options.diagnosticOnly === true
            ? 'diagnostic'
            : 'complete'
  const completedLatencies = actions
    .filter((action) => action.outcome === 'completed' && action.latencyMs !== null)
    .map((action) => action.latencyMs)
  return {
    ok: status === 'complete',
    status,
    reason: fenceReason,
    startedAtMs,
    endedAtMs,
    elapsedMs: startedAtMs === null || endedAtMs === null ? null : endedAtMs - startedAtMs,
    actions,
    completedActions: actions.filter((action) => action.outcome === 'completed').length,
    failedActions: actions.filter((action) => action.outcome === 'failed').length,
    unsupportedActions: actions.filter((action) => action.outcome === 'unsupported').length,
    censoredActions: actions.filter((action) => action.outcome === 'censored').length,
    notAttemptedActions: actions.filter((action) => action.outcome === 'not_attempted').length,
    latencies: percentileSummary(completedLatencies),
    unsupported: actions
      .filter((action) => action.outcome === 'unsupported')
      .map((action) => action.reason),
    pendingEffects: actions
      .filter((action) => action.pendingEffect)
      .map((action) => ({ seq: action.seq, action: action.action, chatId: action.chatId }))
  }
}

/**
 * `--dry-run`: exercise the driver against a scripted in-memory adapter.
 * No Host, no Electron, no providers — proof the driver works, not a
 * measurement.
 */
async function runDryRun() {
  const api = {
    async issueControlAction() {
      return { ok: true }
    }
  }
  return runControlActionReplay({
    api,
    schedule: CONTROL_ACTIONS.map((action, index) => ({
      seq: index + 1,
      action,
      target: { chatId: 'dry-control-chat' }
    })),
    actionTimeoutMs: 1000,
    deadlineMs: 5000,
    diagnosticOnly: true
  })
}

if (require.main === module) {
  if (process.argv.includes('--dry-run')) {
    runDryRun().then(
      (result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      },
      (error) => {
        process.stderr.write(
          `dry-run failed: ${String(error && error.stack ? error.stack : error)}\n`
        )
        process.exitCode = 1
      }
    )
  } else {
    process.stderr.write('usage: node scripts/perf/controlActionReplay.cjs --dry-run\n')
    process.exitCode = 2
  }
}

module.exports = {
  CONTROL_ACTION_HOST_COMMANDS,
  runControlActionReplay,
  runDryRun
}
