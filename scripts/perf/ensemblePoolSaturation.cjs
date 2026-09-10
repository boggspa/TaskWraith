'use strict'

/**
 * M1 Wall 1 — ensemble-pool saturation driver (the SECOND saturation driver).
 *
 * Scripts the Appendix A `ensemble_pool_30_join` scenario — read the pool
 * baseline, enable 30 seats, arrive a new chat as one more seat enable, drain
 * everything back to baseline — against an injected pool adapter, and records
 * what the adapter reports. Seat enables ride the validated
 * `ensemble.seat.toggle` control surface (`issueControlAction`, same result
 * contract as the control-action driver); occupancy comes from
 * `readPoolStatus()`, which must report `{ seatCount }`. Step order is fixed;
 * every adapter wait is bounded by one step timeout plus an optional overall
 * deadline; every step carries an honest outcome (completed, rejected,
 * failed, unsupported, censored, not_attempted).
 *
 * Adapter-declared refusals are recorded verbatim (a capped pool refusing the
 * 31st enable as `pool_full` is saturation evidence, not a driver failure);
 * anything else fails closed as `adapter_invalid_result`; a throw records
 * `adapter_threw`, never the payload. `saturationObserved` is strict: the
 * fill must land exactly `poolTarget` seats above baseline AND the arrival
 * must settle (completed or rejected-verbatim). A pool that refuses below
 * target, or a status read that cannot be used, fails the run with a note —
 * never a reshaped claim. The driver emits no evidence-v1 block. A timer
 * cannot preempt synchronously blocking adapter work.
 *
 * WHAT THIS DRIVER DOES NOT DO: no provider runs; no host-native admission
 * (that driver is scripts/perf/hostNativeSaturation.cjs). Attached adapters
 * over the real Ensemble surface arrive with production binding (B1/M2).
 */

const MAX_TIMER_MS = 2 ** 31 - 1
const DEFAULT_POOL_TARGET = 30

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(label + ' must be a positive integer')
  }
  return value
}

function duration(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(label + ' must be a finite positive timer duration')
  }
  return value
}

function makeClock(nowMs) {
  if (nowMs !== undefined && typeof nowMs !== 'function') {
    throw new Error('nowMs must be a function')
  }
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

function generateEnsembleSaturationScript(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  if (!Number.isSafeInteger(options.seed)) throw new Error('seed must be a safe integer')
  const poolTarget = positiveInteger(options.poolTarget ?? DEFAULT_POOL_TARGET, 'poolTarget')
  const pad = (value, width) => String(value).padStart(width, '0')
  const seats = Array.from({ length: poolTarget }, (_, index) => ({
    participantId: `ens-sat-s${options.seed}-seat-${pad(index + 1, 2)}`
  }))
  return {
    seed: options.seed,
    poolTarget,
    seats,
    arrival: { participantId: `ens-sat-s${options.seed}-arrival-01` }
  }
}

function validateScript(script) {
  if (!isPlainObject(script)) throw new Error('script must be an object')
  if (!Array.isArray(script.seats) || script.seats.length === 0) {
    throw new Error('script seats must be a non-empty array')
  }
  for (const [index, seat] of script.seats.entries()) {
    if (!isPlainObject(seat) || typeof seat.participantId !== 'string' || !seat.participantId) {
      throw new Error(`script seats[${index}] needs a participantId string`)
    }
  }
  if (
    !isPlainObject(script.arrival) ||
    typeof script.arrival.participantId !== 'string' ||
    !script.arrival.participantId
  ) {
    throw new Error('script arrival needs a participantId string')
  }
  const ids = [...script.seats.map((seat) => seat.participantId), script.arrival.participantId]
  if (new Set(ids).size !== ids.length) {
    throw new Error('script participantIds must be unique')
  }
  return {
    seed: script.seed,
    poolTarget: script.seats.length,
    seats: script.seats.map((seat) => ({ ...seat })),
    arrival: { ...script.arrival }
  }
}

// One saturation run at a time per adapter: two concurrent runs would share
// the same pool and neither could read its own fill.
const activeApis = new WeakMap()

async function runEnsemblePoolSaturation(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  const api = options.api
  if (!isPlainObject(api)) throw new Error('api required')
  if (typeof api.issueControlAction !== 'function') {
    throw new Error('api.issueControlAction required')
  }
  if (typeof api.readPoolStatus !== 'function') throw new Error('api.readPoolStatus required')
  const hasScript = options.script !== undefined
  const hasSeed = options.seed !== undefined
  if (hasScript && hasSeed) throw new Error('pass script or seed, never both')
  if (!hasScript && !hasSeed) throw new Error('seed required without a script')
  const script = hasScript
    ? validateScript(options.script)
    : generateEnsembleSaturationScript({ seed: options.seed, poolTarget: options.poolTarget })
  const timers = options.timers ?? { setTimeout, clearTimeout }
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new Error('timers require setTimeout and clearTimeout')
  }
  const clock = makeClock(options.nowMs)
  clock() // Invalid initial clocks are refused before any seat is touched.
  if (options.actionTimeoutMs !== undefined) duration(options.actionTimeoutMs, 'actionTimeoutMs')
  const stepTimeoutMs = options.actionTimeoutMs ?? null
  if (options.deadlineMs !== undefined) duration(options.deadlineMs, 'deadlineMs')
  if (activeApis.has(api)) throw new Error('adapter owned by another saturation run')
  activeApis.set(api, true)

  const notes = []
  const pendingEffects = []
  let expired = false
  let deadline = null
  if (options.deadlineMs !== undefined) {
    deadline = timers.setTimeout(() => {
      expired = true
    }, Math.ceil(options.deadlineMs))
  }
  let seq = 0

  const wait = (promise) =>
    new Promise((resolve) => {
      let done = false
      let timer = null
      if (stepTimeoutMs !== null) {
        timer = timers.setTimeout(() => {
          if (done) return
          done = true
          resolve({ timedOut: true })
        }, Math.ceil(stepTimeoutMs))
      }
      Promise.resolve()
        .then(() => promise)
        .then(
          (value) => {
            if (done) return
            done = true
            clearTimer(timers, timer)
            resolve({ timedOut: false, value })
          },
          () => {
            if (done) return
            done = true
            clearTimer(timers, timer)
            resolve({ timedOut: false, threw: true })
          }
        )
    })

  // Same result contract as the control-action driver: { ok: true } |
  // { ok: false, reason? } | { unsupported: reason } | throw. Anything else
  // fails closed; exception text is never recorded.
  const normalizeToggle = (value) => {
    if (!isPlainObject(value)) return null
    if (value.ok === true) return { kind: 'completed' }
    if (value.ok === false) {
      return {
        kind: 'rejected',
        reason:
          typeof value.reason === 'string' && value.reason.length > 0
            ? value.reason
            : 'adapter_refused'
      }
    }
    if (typeof value.unsupported === 'string' && value.unsupported.length > 0) {
      return { kind: 'unsupported', reason: value.unsupported }
    }
    return null
  }

  const toggle = async (participantId, enabled, step) => {
    seq += 1
    const startedAtMs = clock()
    let result
    try {
      result = await wait(
        api.issueControlAction({
          seq,
          action: 'seat_toggle',
          target: { pool: 'ensemble-saturation' },
          args: { participantId, enabled }
        })
      )
    } catch {
      result = { timedOut: false, threw: true }
    }
    const elapsedMs = clock() - startedAtMs
    if (result.timedOut) {
      pendingEffects.push({ step, participantId })
      return { participantId, enabled, outcome: 'failed', reason: 'action_timeout', elapsedMs }
    }
    if (result.threw) {
      return { participantId, enabled, outcome: 'failed', reason: 'adapter_threw', elapsedMs }
    }
    const normalized = normalizeToggle(result.value)
    if (normalized === null) {
      return {
        participantId,
        enabled,
        outcome: 'failed',
        reason: 'adapter_invalid_result',
        elapsedMs
      }
    }
    if (normalized.kind === 'completed') {
      return { participantId, enabled, outcome: 'completed', elapsedMs }
    }
    if (normalized.kind === 'rejected') {
      return {
        participantId,
        enabled,
        outcome: 'rejected',
        reason: normalized.reason,
        elapsedMs
      }
    }
    return {
      participantId,
      enabled,
      outcome: 'unsupported',
      reason: normalized.reason,
      elapsedMs
    }
  }

  const readStatus = async () => {
    const startedAtMs = clock()
    let result
    try {
      result = await wait(api.readPoolStatus())
    } catch {
      result = { timedOut: false, threw: true }
    }
    const elapsedMs = clock() - startedAtMs
    if (result.timedOut) return { outcome: 'failed', reason: 'status_timeout', elapsedMs }
    if (result.threw) return { outcome: 'failed', reason: 'adapter_threw', elapsedMs }
    if (
      !isPlainObject(result.value) ||
      !Number.isSafeInteger(result.value.seatCount) ||
      result.value.seatCount < 0
    ) {
      return { outcome: 'failed', reason: 'pool_status_invalid', elapsedMs }
    }
    return { outcome: 'completed', seatCount: result.value.seatCount, elapsedMs }
  }

  try {
    // Phase 0 — baseline: the fill reads relative to pre-existing occupancy.
    const baseline = await readStatus()
    const fills = script.seats.map((seat) => ({ ...seat }))
    let stopped = baseline.outcome !== 'completed'
    if (!stopped) {
      // Phase 1 — fill: enable every scripted seat in order.
      for (let index = 0; index < fills.length; index += 1) {
        if (expired) {
          for (let rest = index; rest < fills.length; rest += 1) {
            fills[rest] = { ...fills[rest], outcome: 'censored' }
          }
          stopped = true
          break
        }
        const step = await toggle(fills[index].participantId, true, 'fill')
        fills[index] = { ...fills[index], ...step }
        if (step.outcome !== 'completed') {
          if (step.outcome === 'rejected') notes.push('pool_refused_below_target')
          for (let rest = index + 1; rest < fills.length; rest += 1) {
            fills[rest] = { ...fills[rest], outcome: expired ? 'censored' : 'not_attempted' }
          }
          stopped = true
          break
        }
      }
    } else {
      for (let index = 0; index < fills.length; index += 1) {
        fills[index] = { ...fills[index], outcome: 'not_attempted' }
      }
    }

    // Phase 2 — post-fill read, then arrival: the new chat joins the pool.
    let postFill = { outcome: 'not_attempted' }
    let arrival = null
    let postArrival = { outcome: 'not_attempted' }
    if (!stopped) {
      if (expired) {
        stopped = true
      } else {
        postFill = await readStatus()
        if (postFill.outcome !== 'completed') {
          stopped = true
        } else if (expired) {
          stopped = true
        } else {
          const step = await toggle(script.arrival.participantId, true, 'arrival')
          arrival = { ...script.arrival, ...step }
          if (step.outcome !== 'completed' && step.outcome !== 'rejected') {
            stopped = true
          } else {
            postArrival = await readStatus()
            if (postArrival.outcome !== 'completed') stopped = true
          }
        }
      }
    }

    const saturationObserved =
      baseline.outcome === 'completed' &&
      postFill.outcome === 'completed' &&
      postFill.seatCount - baseline.seatCount === script.poolTarget &&
      arrival !== null &&
      (arrival.outcome === 'completed' || arrival.outcome === 'rejected')

    // Phase 3 — drain: disable every seat this run enabled, in reverse, then
    // re-read. Enables that never completed are not the run's to disable.
    const enabled = [
      ...fills.filter((fill) => fill.outcome === 'completed').map((fill) => fill.participantId),
      ...(arrival !== null && arrival.outcome === 'completed' ? [arrival.participantId] : [])
    ].reverse()
    const disables = []
    for (const participantId of enabled) {
      if (expired) {
        disables.push({ participantId, outcome: 'censored' })
        continue
      }
      disables.push(await toggle(participantId, false, 'drain'))
    }
    let drain
    if (enabled.length === 0 && stopped && baseline.outcome !== 'completed') {
      drain = { outcome: 'not_attempted', disables }
    } else {
      const status = await readStatus()
      if (
        status.outcome !== 'completed' ||
        disables.some((disable) => disable.outcome !== 'completed')
      ) {
        drain = { outcome: 'failed', reason: 'drain_incomplete', disables }
        if (status.outcome === 'completed') drain.seatCount = status.seatCount
        notes.push('drain_incomplete')
      } else if (status.seatCount !== baseline.seatCount) {
        drain = { outcome: 'failed', reason: 'drain_incomplete', disables }
        drain.seatCount = status.seatCount
        notes.push('drain_incomplete')
      } else {
        drain = { outcome: 'completed', seatCount: status.seatCount, disables }
      }
    }

    const failed = [...fills.map((fill) => fill.outcome), baseline.outcome]
      .concat([
        postFill.outcome,
        arrival === null ? 'none' : arrival.outcome,
        postArrival.outcome,
        drain.outcome
      ])
      .some((outcome) => ['failed', 'unsupported', 'censored', 'not_attempted'].includes(outcome))
    return {
      ok: !failed,
      diagnosticOnly: options.diagnosticOnly === true,
      seed: script.seed ?? null,
      poolTarget: script.poolTarget,
      saturationObserved,
      baseline,
      fills,
      postFill,
      arrival,
      postArrival,
      drain,
      pendingEffects,
      notes
    }
  } finally {
    clearTimer(timers, deadline)
    activeApis.delete(api)
  }
}

async function runDryRun() {
  const seats = new Set()
  const api = {
    async issueControlAction(request) {
      if (request.action !== 'seat_toggle') return { unsupported: 'only seat_toggle here' }
      if (request.args.enabled) seats.add(request.args.participantId)
      else seats.delete(request.args.participantId)
      return { ok: true }
    },
    readPoolStatus: () => ({ seatCount: seats.size })
  }
  return runEnsemblePoolSaturation({
    api,
    seed: 4242,
    actionTimeoutMs: 1000,
    deadlineMs: 30_000,
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
    process.stderr.write('usage: node scripts/perf/ensemblePoolSaturation.cjs --dry-run\n')
    process.exitCode = 2
  }
}

module.exports = {
  DEFAULT_POOL_TARGET,
  generateEnsembleSaturationScript,
  runEnsemblePoolSaturation,
  runDryRun
}
