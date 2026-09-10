'use strict'

/**
 * M1 Wall 1 — host-native saturation driver (the FIRST saturation driver).
 *
 * Scripts the Appendix A `host_queue_16_active_1_queued` scenario — hold 16
 * active Host-native run admissions, arrive a 17th start, probe Desktop
 * persistence while it queues, release one lease, observe the arrival admit,
 * drain everything — against an injected admission adapter, and records what
 * the adapter reports. Step order is fixed; per-step waits are bounded by one
 * step timeout plus an optional overall deadline; every step carries an
 * honest outcome (completed, rejected, failed, unsupported, censored,
 * not_attempted, cancelled).
 *
 * The adapter owns effects and mirrors the HostNodeRunAdmission shape:
 * `acquire({ commandId, threadId })`, `inflightCount()`, `queuedCount()`,
 * `cancelQueued({ threadId, commandId? })`, and the optional `persistProbe()`
 * alongside-persistence hook. Acquire results must be
 * `{ kind: 'admitted', lease }` (with a callable `lease.release`) or
 * `{ kind: 'rejected', errorCode, errorMessage }`. Adapter-declared rejection
 * codes are recorded verbatim; anything else fails closed as
 * `adapter_invalid_result`; a throw records `adapter_threw`, never the
 * payload. A missing `persistProbe` records `persist_probe_unavailable` and
 * fails the run: the S3 scenario requires the alongside observation.
 *
 * `saturationObserved` is strict and has exactly two halves: the arrival
 * must PEND while the adapter reports a non-empty queue, AND it must then
 * settle (admitted, or refused with a verbatim code). An arrival that
 * settles without queueing, a pending arrival the adapter never shows
 * queued, and one that is cancelled or left unresolved are all recorded as
 * observed facts — never reshaped into saturation. Both halves carry their
 * own regression test; the sibling ensemble driver's flag is a WEAKER claim
 * (occupancy reached, no queue), so read them per driver. The
 * driver emits no evidence-v1 block and claims no durability: the M2
 * `HostQueuedStartInterference` regression (real Desktop persist durable
 * before release, QUEUE wait measured separately) still needs the real Host
 * out of process. A timer cannot preempt synchronously blocking adapter work.
 *
 * WHAT THIS DRIVER DOES NOT DO: no Ensemble-pool saturation (that driver is
 * scripts/perf/ensemblePoolSaturation.cjs). No provider runs. No T2 runner
 * imports this file yet. Production admission is bound through
 * `bindHostNodeRunAdmissionForSaturation` (`src/host-node/HostNodeRunAdmissionSaturationAdapter.ts`);
 * `persistProbe` remains injected because a live Desktop persist against an
 * out-of-process Host is the M2 HostQueuedStartInterference regression.
 */

const MAX_TIMER_MS = 2 ** 31 - 1
const DEFAULT_ACTIVE_TARGET = 16
const DEFAULT_QUEUED_TARGET = 1

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

function generateHostSaturationScript(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  if (!Number.isSafeInteger(options.seed)) throw new Error('seed must be a safe integer')
  const activeTarget = positiveInteger(
    options.activeTarget ?? DEFAULT_ACTIVE_TARGET,
    'activeTarget'
  )
  const queuedTarget = positiveInteger(
    options.queuedTarget ?? DEFAULT_QUEUED_TARGET,
    'queuedTarget'
  )
  const pad = (value, width) => String(value).padStart(width, '0')
  const holds = Array.from({ length: activeTarget }, (_, index) => ({
    commandId: `host-sat-s${options.seed}-hold-${pad(index + 1, 2)}`,
    threadId: `host-sat-s${options.seed}-thread-${pad(index + 1, 2)}`
  }))
  const arrivals = Array.from({ length: queuedTarget }, (_, index) => ({
    commandId: `host-sat-s${options.seed}-arrival-${pad(index + 1, 2)}`,
    threadId: `host-sat-s${options.seed}-arrival-thread-${pad(index + 1, 2)}`
  }))
  return { seed: options.seed, activeTarget, queuedTarget, holds, arrivals }
}

function validateScript(script) {
  if (!isPlainObject(script)) throw new Error('script must be an object')
  for (const key of ['holds', 'arrivals']) {
    if (!Array.isArray(script[key]) || script[key].length === 0) {
      throw new Error(`script ${key} must be a non-empty array`)
    }
    for (const [index, step] of script[key].entries()) {
      if (
        !isPlainObject(step) ||
        typeof step.commandId !== 'string' ||
        step.commandId.length === 0 ||
        typeof step.threadId !== 'string' ||
        step.threadId.length === 0
      ) {
        throw new Error(`script ${key}[${index}] needs commandId and threadId strings`)
      }
    }
  }
  const commandIds = [...script.holds, ...script.arrivals].map((step) => step.commandId)
  const threadIds = [...script.holds, ...script.arrivals].map((step) => step.threadId)
  if (new Set(commandIds).size !== commandIds.length) {
    throw new Error('script commandIds must be unique')
  }
  // A repeated thread would trip the admission thread_busy rule and break the
  // scenario before any saturation is observable: refuse it at the boundary.
  if (new Set(threadIds).size !== threadIds.length) {
    throw new Error('script threadIds must be unique')
  }
  return {
    seed: script.seed,
    activeTarget: script.holds.length,
    queuedTarget: script.arrivals.length,
    holds: script.holds.map((step) => ({ ...step })),
    arrivals: script.arrivals.map((step) => ({ ...step }))
  }
}

// One saturation run at a time per adapter: two concurrent runs would share
// the same admission capacity and neither could read its own queue.
const activeApis = new WeakMap()

async function runHostNativeSaturation(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  const api = options.api
  if (!isPlainObject(api)) throw new Error('api required')
  for (const method of ['acquire', 'inflightCount', 'queuedCount', 'cancelQueued']) {
    if (typeof api[method] !== 'function') throw new Error(`api.${method} required`)
  }
  if (api.persistProbe !== undefined && typeof api.persistProbe !== 'function') {
    throw new Error('api.persistProbe must be a function when supplied')
  }
  const hasScript = options.script !== undefined
  const hasSeed = options.seed !== undefined
  if (hasScript && hasSeed) throw new Error('pass script or seed, never both')
  if (!hasScript && !hasSeed) throw new Error('seed required without a script')
  const script = hasScript
    ? validateScript(options.script)
    : generateHostSaturationScript({
        seed: options.seed,
        activeTarget: options.activeTarget,
        queuedTarget: options.queuedTarget
      })
  const timers = options.timers ?? { setTimeout, clearTimeout }
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new Error('timers require setTimeout and clearTimeout')
  }
  const clock = makeClock(options.nowMs)
  clock() // Invalid initial clocks are refused before any admission is touched.
  if (options.acquireTimeoutMs !== undefined) duration(options.acquireTimeoutMs, 'acquireTimeoutMs')
  const stepTimeoutMs = options.acquireTimeoutMs ?? null
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
          (error) => {
            if (done) return
            done = true
            clearTimer(timers, timer)
            resolve({ timedOut: false, threw: true, error })
          }
        )
    })

  const readCounts = () => {
    let inflightCount = null
    let queuedCount = null
    try {
      inflightCount = api.inflightCount()
      queuedCount = api.queuedCount()
    } catch {
      return { ok: false }
    }
    if (
      !Number.isSafeInteger(inflightCount) ||
      inflightCount < 0 ||
      !Number.isSafeInteger(queuedCount) ||
      queuedCount < 0
    ) {
      return { ok: false }
    }
    return { ok: true, inflightCount, queuedCount }
  }

  const normalizeAcquire = (value) => {
    if (!isPlainObject(value)) return null
    if (value.kind === 'admitted') {
      if (
        !isPlainObject(value.lease) ||
        typeof value.lease.release !== 'function' ||
        typeof value.lease.commandId !== 'string' ||
        value.lease.commandId.length === 0
      ) {
        // HostNodeRunAdmissionLease types commandId as a required string and
        // `release.releasedCommandId` is reported from it: an unvalidated
        // adapter field must not reach the report.
        return null
      }
      return { kind: 'admitted', lease: value.lease }
    }
    if (value.kind === 'rejected') {
      if (typeof value.errorCode !== 'string' || value.errorCode.length === 0) return null
      return { kind: 'rejected', errorCode: value.errorCode }
    }
    return null
  }

  const leases = []
  const censorRest = (steps, from) => {
    for (let index = from; index < steps.length; index += 1) {
      steps[index] = { ...steps[index], outcome: expired ? 'censored' : 'not_attempted' }
    }
  }

  try {
    // Phase 1 — hold: fill the active set.
    const holds = script.holds.map((step) => ({ ...step }))
    let stopped = false
    for (let index = 0; index < holds.length; index += 1) {
      if (expired) {
        censorRest(holds, index)
        stopped = true
        break
      }
      const startedAtMs = clock()
      let result
      try {
        result = await wait(
          api.acquire({ commandId: holds[index].commandId, threadId: holds[index].threadId })
        )
      } catch {
        result = { timedOut: false, threw: true }
      }
      const elapsedMs = clock() - startedAtMs
      if (result.timedOut) {
        holds[index] = { ...holds[index], outcome: 'failed', reason: 'acquire_timeout', elapsedMs }
        pendingEffects.push({
          step: 'hold',
          commandId: holds[index].commandId,
          threadId: holds[index].threadId
        })
        notes.push('pending_acquire_may_hold_capacity')
        censorRest(holds, index + 1)
        stopped = true
        break
      }
      if (result.threw) {
        holds[index] = { ...holds[index], outcome: 'failed', reason: 'adapter_threw', elapsedMs }
        censorRest(holds, index + 1)
        stopped = true
        break
      }
      const normalized = normalizeAcquire(result.value)
      if (normalized === null) {
        holds[index] = {
          ...holds[index],
          outcome: 'failed',
          reason: 'adapter_invalid_result',
          elapsedMs
        }
        censorRest(holds, index + 1)
        stopped = true
        break
      }
      if (normalized.kind === 'rejected') {
        holds[index] = {
          ...holds[index],
          outcome: 'rejected',
          errorCode: normalized.errorCode,
          elapsedMs
        }
        censorRest(holds, index + 1)
        stopped = true
        break
      }
      holds[index] = { ...holds[index], outcome: 'completed', elapsedMs }
      leases.push(normalized.lease)
    }

    // Phase 2 — arrive: the 17th start. The wait IS the observation: give a
    // synchronous adapter one timer tick to settle, then read the queue.
    let arrival = null
    let arrivalPending = false
    let queueObserved = false
    let arrivalPromise = null
    if (!stopped) {
      if (expired) {
        stopped = true
      } else {
        const spec = script.arrivals[0]
        const startedAtMs = clock()
        try {
          arrivalPromise = api.acquire({ commandId: spec.commandId, threadId: spec.threadId })
        } catch {
          arrival = { ...spec, outcome: 'failed', reason: 'adapter_threw', elapsedMs: 0 }
          stopped = true
        }
        if (arrival === null) {
          let settled = null
          Promise.resolve(arrivalPromise).then(
            (value) => {
              if (settled === null) settled = { threw: false, value }
            },
            () => {
              if (settled === null) settled = { threw: true }
            }
          )
          await new Promise((resolve) => timers.setTimeout(resolve, 0))
          const elapsedMs = clock() - startedAtMs
          if (settled !== null) {
            if (settled.threw) {
              arrival = { ...spec, outcome: 'failed', reason: 'adapter_threw', elapsedMs }
              stopped = true
            } else {
              const normalized = normalizeAcquire(settled.value)
              if (normalized === null) {
                arrival = {
                  ...spec,
                  outcome: 'failed',
                  reason: 'adapter_invalid_result',
                  elapsedMs
                }
                stopped = true
              } else if (normalized.kind === 'rejected') {
                arrival = {
                  ...spec,
                  outcome: 'rejected',
                  errorCode: normalized.errorCode,
                  elapsedMs,
                  queuedBeforeAdmit: false
                }
              } else {
                arrival = {
                  ...spec,
                  outcome: 'completed',
                  elapsedMs,
                  queuedBeforeAdmit: false
                }
                leases.push(normalized.lease)
                notes.push('arrival settled without queueing')
              }
            }
          } else {
            arrivalPending = true
            const counts = readCounts()
            queueObserved = counts.ok && counts.queuedCount >= 1
            if (!queueObserved) notes.push('arrival_pending_queue_unobserved')
            arrival = {
              ...spec,
              outcome: 'pending',
              elapsedMs,
              queueObserved,
              inflightCount: counts.ok ? counts.inflightCount : null,
              queuedCount: counts.ok ? counts.queuedCount : null
            }
          }
        }
      }
    }

    // Phase 3 — probe persistence alongside the (possibly queued) arrival.
    let probe = null
    if (!stopped) {
      if (expired) {
        stopped = true
      } else if (typeof api.persistProbe !== 'function') {
        probe = { outcome: 'unsupported', reason: 'persist_probe_unavailable' }
        stopped = true
      } else {
        const whileQueued = arrivalPending && arrival !== null && arrival.outcome === 'pending'
        const startedAtMs = clock()
        let result
        try {
          result = await wait(api.persistProbe())
        } catch {
          result = { timedOut: false, threw: true }
        }
        const elapsedMs = clock() - startedAtMs
        if (result.timedOut) {
          probe = { outcome: 'failed', reason: 'probe_timeout', whileQueued, elapsedMs }
          pendingEffects.push({ step: 'probe' })
          stopped = true
        } else if (result.threw) {
          probe = { outcome: 'failed', reason: 'adapter_threw', whileQueued, elapsedMs }
          stopped = true
        } else {
          probe = { outcome: 'completed', whileQueued, elapsedMs }
        }
      }
    }

    // Phase 4 — release one lease so a queued arrival can admit.
    let release = null
    if (!stopped && arrivalPending && leases.length > 0) {
      const lease = leases.shift()
      try {
        lease.release()
        release = { outcome: 'completed', releasedCommandId: lease.commandId }
      } catch {
        release = { outcome: 'failed', reason: 'adapter_threw' }
        stopped = true
      }
    }

    // Phase 5 — complete the arrival observation.
    let saturationObserved = false
    if (arrival !== null && arrival.outcome === 'pending') {
      if (stopped) {
        let cancelled = 0
        try {
          cancelled = api.cancelQueued({
            threadId: arrival.threadId,
            commandId: arrival.commandId
          })
        } catch {
          cancelled = 0
        }
        if (cancelled > 0) {
          arrival = { ...arrival, outcome: 'cancelled', queuedBeforeAdmit: queueObserved }
          arrivalPending = false
        } else {
          arrival = { ...arrival, outcome: 'failed', reason: 'arrival_unresolved' }
          pendingEffects.push({
            step: 'arrival',
            commandId: arrival.commandId,
            threadId: arrival.threadId
          })
        }
      } else {
        const startedAtMs = clock()
        const result = await wait(arrivalPromise)
        const elapsedMs = clock() - startedAtMs
        if (result.timedOut) {
          let cancelled = 0
          try {
            cancelled = api.cancelQueued({
              threadId: arrival.threadId,
              commandId: arrival.commandId
            })
          } catch {
            cancelled = 0
          }
          arrival = {
            ...arrival,
            outcome: cancelled > 0 ? 'cancelled' : 'failed',
            ...(cancelled > 0 ? {} : { reason: 'arrival_unresolved' }),
            queuedBeforeAdmit: queueObserved,
            elapsedMs
          }
          if (cancelled === 0) {
            pendingEffects.push({
              step: 'arrival',
              commandId: arrival.commandId,
              threadId: arrival.threadId
            })
          } else {
            arrivalPending = false
          }
          stopped = true
        } else if (result.threw) {
          arrival = {
            ...arrival,
            outcome: 'failed',
            reason: 'adapter_threw',
            queuedBeforeAdmit: queueObserved,
            elapsedMs
          }
          arrivalPending = false
          stopped = true
        } else {
          const normalized = normalizeAcquire(result.value)
          if (normalized === null) {
            arrival = {
              ...arrival,
              outcome: 'failed',
              reason: 'adapter_invalid_result',
              queuedBeforeAdmit: queueObserved,
              elapsedMs
            }
            arrivalPending = false
            stopped = true
          } else if (normalized.kind === 'rejected') {
            arrival = {
              ...arrival,
              outcome: 'rejected',
              errorCode: normalized.errorCode,
              queuedBeforeAdmit: queueObserved,
              elapsedMs
            }
            arrivalPending = false
          } else {
            arrival = {
              ...arrival,
              outcome: 'completed',
              queuedBeforeAdmit: queueObserved,
              elapsedMs
            }
            leases.push(normalized.lease)
            arrivalPending = false
          }
        }
      }
      saturationObserved =
        queueObserved && (arrival.outcome === 'completed' || arrival.outcome === 'rejected')
    }

    // Phase 6 — drain: release everything held and re-read the capacity.
    const releaseFailures = []
    for (const lease of leases.splice(0, leases.length)) {
      try {
        lease.release()
      } catch {
        releaseFailures.push(lease.commandId)
      }
    }
    const drainCounts = readCounts()
    const drain =
      releaseFailures.length > 0 || !drainCounts.ok
        ? {
            outcome: 'failed',
            reason: 'adapter_threw',
            inflightCount: drainCounts.ok ? drainCounts.inflightCount : null,
            queuedCount: drainCounts.ok ? drainCounts.queuedCount : null
          }
        : drainCounts.inflightCount !== 0 || drainCounts.queuedCount !== 0
          ? {
              outcome: 'failed',
              reason: 'drain_incomplete',
              inflightCount: drainCounts.inflightCount,
              queuedCount: drainCounts.queuedCount
            }
          : {
              outcome: 'completed',
              inflightCount: drainCounts.inflightCount,
              queuedCount: drainCounts.queuedCount
            }
    if (drain.outcome === 'failed' && drain.reason === 'drain_incomplete') {
      notes.push('drain_incomplete')
    }

    const stepOutcomes = [
      ...holds.map((hold) => hold.outcome),
      arrival === null ? 'none' : arrival.outcome,
      probe === null ? 'none' : probe.outcome,
      release === null ? 'none' : release.outcome,
      drain.outcome
    ]
    const failed = stepOutcomes.some((outcome) =>
      ['failed', 'unsupported', 'censored', 'not_attempted', 'cancelled', 'pending'].includes(
        outcome
      )
    )
    return {
      ok: !failed,
      diagnosticOnly: options.diagnosticOnly === true,
      seed: script.seed ?? null,
      activeTarget: script.activeTarget,
      queuedTarget: script.queuedTarget,
      saturationObserved,
      holds,
      arrival,
      probe,
      release,
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
  const inflight = new Map()
  const waiters = []
  const flush = () => {
    while (inflight.size < 16 && waiters.length > 0) {
      const waiter = waiters.shift()
      inflight.set(waiter.commandId, waiter.threadId)
      waiter.resolve({
        kind: 'admitted',
        lease: {
          commandId: waiter.commandId,
          threadId: waiter.threadId,
          release: () => {
            if (inflight.delete(waiter.commandId)) flush()
          }
        }
      })
    }
  }
  const api = {
    async acquire(input) {
      if (inflight.size < 16) {
        inflight.set(input.commandId, input.threadId)
        return {
          kind: 'admitted',
          lease: {
            commandId: input.commandId,
            threadId: input.threadId,
            release: () => {
              if (inflight.delete(input.commandId)) flush()
            }
          }
        }
      }
      return await new Promise((resolve) => {
        waiters.push({ ...input, resolve })
      })
    },
    inflightCount: () => inflight.size,
    queuedCount: () => waiters.length,
    cancelQueued: () => 0,
    persistProbe: async () => ({ probed: true })
  }
  return runHostNativeSaturation({
    api,
    seed: 4242,
    acquireTimeoutMs: 1000,
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
    process.stderr.write('usage: node scripts/perf/hostNativeSaturation.cjs --dry-run\n')
    process.exitCode = 2
  }
}

module.exports = {
  DEFAULT_ACTIVE_TARGET,
  DEFAULT_QUEUED_TARGET,
  generateHostSaturationScript,
  runHostNativeSaturation,
  runDryRun
}
