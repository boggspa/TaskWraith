'use strict'

/**
 * M1 A1.2 — concurrent per-chat replay lanes driver (the FIRST B2 driver).
 *
 * Runs N per-chat replay schedules CONCURRENTLY against one attached
 * instance's page adapter, so a light chat's save path is measured WHILE a
 * heavy chat's save path hammers the same process — the light-alone vs
 * light-beside pairing G-X reads its §1.1 deltas from.
 *
 * Determinism: per-lane event order is always preserved (per-thread
 * ordering is a programme invariant — a lane never has two events in
 * flight); the CROSS-lane start order is seeded (mulberry32 via
 * fixtureGenerator's createPrng), so the same seed + same fake/real adapter
 * timing replays the same interleaving. Each cell runs the fixed
 * MATRIX_SAMPLING window (120 s) three times; a window that ends before a
 * lane's schedule completes censors that lane (`censored: true`), never
 * silently truncates it.
 *
 * Output is the run-descriptor shape pairRuns/validateInterferenceReport
 * (d1172804c) consume: `signals` carries ONLY light-lane percentiles so the
 * alone/beside runs of a pair present identical signal sets; heavy-lane
 * detail lives in `lanes`, not in the compared signals.
 *
 * WHAT THIS DRIVER DOES NOT DO (still declared missing capabilities in
 * interferenceMatrix.cjs): no provider runs (replay exercises the save/hydrate
 * path only), no Ensemble-pool or Host-native saturation. Control actions
 * (cancel/approval/answer/seat toggle) have their own driver now
 * (scripts/perf/controlActionReplay.cjs, M1 Wall 1). A cell run through this
 * driver alone is NOT a measured Appendix A cell. Qualified pairs require report schema v2
 * and versioned per-window coverage. Old descriptors remain diagnostic data.
 * A timer cannot preempt synchronously blocking adapter or event-loop work.
 */

const { applyReplayEvent } = require('./replayDriver.cjs')
const { createPrng } = require('./fixtureGenerator.cjs')
const {
  MATRIX_SAMPLING,
  RUN_EVIDENCE_VERSION,
  cellName,
  validateRunEvidence
} = require('./interferenceMatrix.cjs')

const LANE_ROLES = Object.freeze(['light', 'heavy'])
const PAIRING_ROLES = Object.freeze(['light-alone', 'light-beside'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Nearest-rank percentiles, matching the recorder's convention. */
function percentileSummary(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (q) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1))]
  return {
    count: sorted.length,
    p50: rank(50),
    p95: rank(95),
    p99: rank(99),
    max: sorted[sorted.length - 1]
  }
}

/**
 * One lane's replay ctx: the SAME shape runDeterministicReplay builds, but
 * per lane, so two chats' revision/counter state never bleed into each
 * other while they share the injected page adapter.
 */
function makeLaneContext(api, lane) {
  const chatsById = new Map()
  for (const chat of lane.chats || []) chatsById.set(chat.appChatId, chat)
  return {
    api,
    chatsById,
    unsupported: [],
    savedCounts: new Map(),
    canonicalRevisions: new Map()
  }
}

function validateLaneSpec(lane, index) {
  if (!isPlainObject(lane)) return ['lane ' + index + ' must be an object']
  const errors = []
  if (!LANE_ROLES.includes(lane.role)) errors.push('lane role must be light|heavy')
  if (typeof lane.chatId !== 'string' || !lane.chatId.trim()) errors.push('lane chatId required')
  if (!Array.isArray(lane.schedule)) errors.push('lane schedule must be an array')
  else
    for (const event of lane.schedule) {
      if (
        !isPlainObject(event) ||
        typeof event.kind !== 'string' ||
        (event.appChatId !== lane.chatId &&
          !(event.kind === 'schedule_complete' && event.appChatId === undefined))
      ) {
        errors.push('every replay event must target its own lane chat')
      }
    }
  if (lane.chats !== undefined && !Array.isArray(lane.chats)) {
    errors.push('lane chats must be an array')
  } else {
    const ids = new Set()
    for (const chat of lane.chats || []) {
      if (!isPlainObject(chat) || chat.appChatId !== lane.chatId || ids.has(chat.appChatId)) {
        errors.push('fixture chats must uniquely belong to their lane')
      }
      ids.add(chat?.appChatId)
    }
  }
  return errors
}

// Ownership survives an incomplete return until the underlying effects settle.
// Reusing another wrapper around the same remote instance is caller-owned; the
// supplied adapter object must remain the stable identity for these runs.
const activeChats = new WeakMap()
const MAX_TIMER_MS = 2 ** 31 - 1

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(label + ' must be a positive integer')
  return value
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

function reserveChats(api, lanes) {
  let owners = activeChats.get(api)
  if (!owners) activeChats.set(api, (owners = new Map()))
  if (lanes.some((lane) => owners.has(lane.chatId))) {
    throw new Error('chat still owned by another replay or unresolved effects')
  }
  const token = {}
  const pending = new Map(lanes.map((lane) => [lane.chatId, new Set()]))
  let finished = false
  const releaseIdle = (chatId) => {
    if (finished && pending.get(chatId).size === 0 && owners.get(chatId) === token)
      owners.delete(chatId)
  }
  for (const lane of lanes) owners.set(lane.chatId, token)
  return {
    add(entry) {
      pending.get(entry.state.lane.chatId).add(entry)
    },
    settled(entry) {
      const id = entry.state.lane.chatId
      pending.get(id).delete(entry)
      releaseIdle(id)
    },
    finish() {
      finished = true
      for (const id of pending.keys()) releaseIdle(id)
    },
    confirmDrained() {
      for (const [id, entries] of pending) {
        entries.clear()
        releaseIdle(id)
      }
    }
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

function boundedCleanup(hook, pending, reason, timers, timeoutMs) {
  if (typeof hook !== 'function') return Promise.resolve({ status: 'not_requested' })
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const finish = (status) => {
      if (done) return
      done = true
      clearTimer(timers, timer)
      resolve({ status })
    }
    timer = timers.setTimeout(() => finish('timed_out'), Math.ceil(timeoutMs))
    Promise.resolve()
      .then(() => hook({ reason, pending }))
      .then(
        (receipt) => finish(receipt?.effectsSettled === true ? 'confirmed_drained' : 'unconfirmed'),
        () => finish('failed')
      )
  })
}

/**
 * The deadline races RAW effect completion, never a timeout wrapper that can
 * hide an outstanding save. Completion timestamps are captured in the promise
 * settlement handler, not when a later scheduler iteration consumes the item.
 */
async function runOneWindow(laneStates, options, prng, ownership, repetition) {
  const { clock, timers, windowMs, maxInFlight } = options
  let fenceReason = null
  let accepting = true
  let collecting = true
  let clockFailed = false
  let resolveFence
  const fence = new Promise((resolve) => {
    resolveFence = resolve
  })
  const stop = (reason) => {
    if (fenceReason !== null) return
    accepting = false
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
  const startedAtMs = readTime()
  const deadlineAtMs = startedAtMs === null ? null : startedAtMs + windowMs
  // Addition and subtraction can round differently for fractional readings.
  // Require the same actual elapsed calculation the report validator checks.
  const reachedDeadline = (at) => at >= deadlineAtMs && at - startedAtMs >= windowMs
  const pending = new Set()
  const allEntries = []
  // Timers wake on libuv's millisecond clock, which can lead this clock. Only
  // a validated measurement-clock reading may establish the actual deadline.
  // After the initial wake, at most eight positive-delay retries (<=10ms each)
  // permit small skew without hanging on a stopped or unusably slow clock.
  let deadline = null
  let deadlineActive = true
  let deadlineArm = 0
  let deadlineRearms = 0
  let previousWakeAtMs = startedAtMs
  const armDeadline = (delayMs) => {
    if (!deadlineActive || fenceReason !== null) return
    const arm = ++deadlineArm
    try {
      const handle = timers.setTimeout(
        () => {
          if (!deadlineActive || fenceReason !== null || arm !== deadlineArm) return
          deadline = null
          const at = readTime()
          if (at === null) return
          if (reachedDeadline(at)) {
            stop('deadline')
            return
          }
          if (at <= previousWakeAtMs || deadlineRearms >= 8) {
            clockFailed = true
            stop('deadline_clock_unusable')
            return
          }
          previousWakeAtMs = at
          deadlineRearms += 1
          const remainingMs = Math.max(deadlineAtMs - at, windowMs - (at - startedAtMs))
          armDeadline(Math.min(10, remainingMs))
        },
        Math.max(1, Math.ceil(delayMs))
      )
      // Also contain a misbehaving injected timer that invokes synchronously:
      // never overwrite a newer arm's handle with the retired arm's handle.
      if (deadlineActive && fenceReason === null && arm === deadlineArm) deadline = handle
      else clearTimer(timers, handle)
    } catch {
      clockFailed = true
      stop('deadline_timer_failed')
    }
  }
  armDeadline(windowMs)

  const guardApi = (state) => {
    const adapter = {}
    for (const name of ['getChat', 'saveChat', 'savePrefix', 'selectChat']) {
      if (typeof options.api[name] !== 'function') continue
      adapter[name] = (...args) => {
        const target = name === 'getChat' || name === 'selectChat' ? args[0] : args[0]?.appChatId
        if (!accepting || target !== state.lane.chatId) {
          throw new Error('replay effect is outside its owned chat/window')
        }
        const entry = state.inFlightBy
        entry.apiCalls += 1
        entry.apiPending += 1
        for (const other of allEntries) {
          if (other.apiPending === 0 || other === entry) continue
          if (entry.state.lane.role === 'light' && other.state.lane.role === 'heavy')
            entry.overlapped = true
          if (other.state.lane.role === 'light' && entry.state.lane.role === 'heavy')
            other.overlapped = true
        }
        let result
        try {
          result = options.api[name](...args)
        } catch (error) {
          entry.apiPending -= 1
          throw error
        }
        return Promise.resolve(result).finally(() => {
          entry.apiPending -= 1
        })
      }
    }
    return adapter
  }
  for (const state of laneStates) state.ctx = makeLaneContext(guardApi(state), state.lane)

  const launch = (state) => {
    const at = readTime()
    if (at === null || reachedDeadline(at)) {
      stop('deadline')
      return
    }
    const index = state.nextIndex++
    const entry = {
      state,
      index,
      startedAtMs: at,
      finishedAtMs: null,
      settled: false,
      consumed: false,
      apiCalls: 0,
      apiPending: 0,
      overlapped: false,
      unsupportedBefore: state.ctx.unsupported.length,
      timeout: null
    }
    // Arm before owning an effect: a broken injected timer must not create a
    // phantom unresolved entry for work that was never dispatched.
    if (options.eventTimeoutMs !== undefined) {
      entry.timeout = timers.setTimeout(
        () => stop('event_timeout'),
        Math.ceil(options.eventTimeoutMs)
      )
    }
    state.inFlightBy = entry
    pending.add(entry)
    allEntries.push(entry)
    ownership.add(entry)
    const settle = (outcome, value) => {
      entry.outcome = outcome
      entry.value = value
      entry.finishedAtMs = collecting ? readTime() : null
      entry.settled = true
      clearTimer(timers, entry.timeout)
      ownership.settled(entry)
      return entry
    }
    entry.promise = Promise.resolve()
      .then(() => applyReplayEvent(state.ctx, state.lane.schedule[index]))
      .then(
        (value) => settle('returned', value),
        (error) => settle('failed', error)
      )
  }

  const consume = (entry) => {
    if (entry.consumed) return
    entry.consumed = true
    pending.delete(entry)
    const state = entry.state
    state.inFlightBy = null
    if (entry.finishedAtMs === null || entry.finishedAtMs > deadlineAtMs) {
      state.lateEvents += 1
      return
    }
    state.completedEvents += 1
    if (entry.outcome === 'failed' || entry.value?.runPresent === false) {
      state.failures += 1
    } else if (
      entry.value?.ok !== true ||
      entry.value.delegated === true ||
      state.ctx.unsupported.length > entry.unsupportedBefore
    ) {
      state.unsupportedEvents += 1
    } else {
      state.applied += 1
      if (entry.apiCalls > 0) {
        state.latencies.push(entry.finishedAtMs - entry.startedAtMs)
        if (state.lane.role === 'light' && entry.overlapped) state.overlappedLightSamples += 1
      }
    }
  }

  if (laneStates.some((state) => state.lane.schedule.length === 0)) stop('empty_population')
  try {
    while (fenceReason === null) {
      const at = readTime()
      if (at === null) break
      if (reachedDeadline(at)) {
        stop('deadline')
        break
      }
      const eligible = laneStates.filter(
        (state) => state.nextIndex < state.lane.schedule.length && state.inFlightBy === null
      )
      if (eligible.length && pending.size < maxInFlight) {
        launch(eligible[Math.floor(prng() * eligible.length)])
        continue
      }
      if (pending.size === 0 && options.diagnosticOnly) {
        stop('diagnostic_complete')
        break
      }
      const settled = await Promise.race([fence, ...[...pending].map((entry) => entry.promise)])
      if (settled.fence) break
      consume(settled)
    }
  } finally {
    accepting = false
    deadlineActive = false
    deadlineArm += 1
    clearTimer(timers, deadline)
    for (const entry of allEntries) clearTimer(timers, entry.timeout)
  }
  // Keep all completions observed at the fence, including results that settled
  // together before Promise.race resumed. Late or unresolved effects are censored.
  for (const entry of [...pending]) if (entry.settled) consume(entry)
  const endedAtMs = readTime()
  collecting = false
  const lanes = laneStates.map((state) => ({
    role: state.lane.role,
    chatId: state.lane.chatId,
    plannedEvents: state.lane.schedule.length,
    startedEvents: state.nextIndex,
    completedEvents: state.completedEvents,
    failedEvents: state.failures,
    unsupportedEvents: state.unsupportedEvents,
    pendingEvents: [...pending].filter((entry) => entry.state === state).length,
    lateEvents: state.lateEvents,
    measuredSamples: state.latencies.length,
    overlappedLightSamples: state.overlappedLightSamples
  }))
  const elapsedMs = startedAtMs === null || endedAtMs === null ? null : endedAtMs - startedAtMs
  const failed = clockFailed || lanes.some((lane) => lane.failedEvents > 0)
  const unsupported = lanes.some((lane) => lane.unsupportedEvents > 0)
  const incomplete = lanes.some((lane) => lane.pendingEvents > 0)
  const censored =
    fenceReason === 'event_timeout' ||
    lanes.some((lane) => lane.completedEvents !== lane.plannedEvents || lane.lateEvents > 0)
  const outcome = failed
    ? 'failed'
    : unsupported
      ? 'unsupported'
      : incomplete
        ? 'incomplete'
        : censored
          ? 'censored'
          : options.diagnosticOnly
            ? 'diagnostic'
            : elapsedMs !== null &&
                elapsedMs >= windowMs &&
                lanes.every((lane) => lane.measuredSamples > 0)
              ? 'complete'
              : 'incomplete'
  return {
    repetition,
    startedAtMs,
    endedAtMs,
    elapsedMs,
    outcome,
    reason: fenceReason,
    lanes,
    failed,
    unsupported,
    incomplete,
    censored,
    pending: [...pending]
      .filter((entry) => !entry.settled)
      .map((entry) => ({
        chatId: entry.state.lane.chatId,
        eventIndex: entry.index,
        kind: entry.state.lane.schedule[entry.index].kind
      }))
  }
}

/**
 * Measurement mode observes the whole requested window even when its finite
 * schedule finishes early. Diagnostic mode may return early and NEVER qualifies
 * a pair. A fence with unresolved effects ends the run: no next repetition.
 *
 * cancelPending is an explicit caller-owned cancellation/drain hook, not a
 * default app shutdown. Only {effectsSettled:true} confirms that effects cannot
 * continue. Its wait is bounded by cleanupTimeoutMs. Otherwise chat ownership is
 * retained until raw effects settle; later calls using this adapter cannot reuse
 * those chats. Reported windows stay detached from late settlements.
 */
async function runConcurrentReplayLanes(options) {
  if (!isPlainObject(options)) throw new Error('options required')
  if (
    !options.api ||
    typeof options.api.getChat !== 'function' ||
    typeof options.api.saveChat !== 'function'
  ) {
    throw new Error('api.getChat and api.saveChat required')
  }
  if (!Array.isArray(options.lanes) || options.lanes.length === 0)
    throw new Error('at least one lane required')
  const errors = options.lanes.flatMap(validateLaneSpec)
  if (!Number.isSafeInteger(options.seed)) throw new Error('seed must be a safe integer')
  if (options.diagnosticOnly !== undefined && typeof options.diagnosticOnly !== 'boolean') {
    errors.push('diagnosticOnly must be boolean')
  }
  const ids = options.lanes.map((lane) => lane?.chatId)
  if (new Set(ids).size !== ids.length) errors.push('lane chatIds must be unique')
  if (options.lanes.filter((lane) => lane?.role === 'light').length !== 1)
    errors.push('exactly one light lane required')
  const hasHeavy = options.lanes.some((lane) => lane?.role === 'heavy')
  const pairingRole = options.pairingRole ?? (hasHeavy ? 'light-beside' : 'light-alone')
  if (!PAIRING_ROLES.includes(pairingRole) || (pairingRole === 'light-beside') !== hasHeavy)
    errors.push('pairingRole contradicts heavy-lane presence')
  for (const lane of options.lanes)
    if (lane?.pairingRole !== undefined && lane.pairingRole !== pairingRole) {
      errors.push('lane pairingRole contradicts run role')
    }
  if (errors.length) throw new Error('invalid lane specs: ' + errors.join('; '))
  const windowMs = duration(options.windowMs ?? MATRIX_SAMPLING.windowMs, 'windowMs')
  const repetitions = positiveInteger(
    options.repetitions ?? MATRIX_SAMPLING.repetitions,
    'repetitions'
  )
  const maxInFlight = positiveInteger(
    options.maxInFlight === undefined ? options.lanes.length : options.maxInFlight,
    'maxInFlight'
  )
  if (options.eventTimeoutMs !== undefined) duration(options.eventTimeoutMs, 'eventTimeoutMs')
  const cleanupTimeoutMs = duration(options.cleanupTimeoutMs ?? 1000, 'cleanupTimeoutMs')
  if (options.cancelPending !== undefined && typeof options.cancelPending !== 'function') {
    throw new Error('cancelPending must be an explicit caller-owned hook')
  }
  const timers = options.timers ?? { setTimeout, clearTimeout }
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new Error('timers require setTimeout and clearTimeout')
  }
  const clock = makeClock(options.nowMs)
  clock() // Invalid initial clocks are refused before any chat is owned or mutated.
  const lanes = options.lanes.map((lane) => ({
    ...lane,
    schedule: lane.schedule.map((event) => ({ ...event })),
    chats: [...(lane.chats || [])]
  }))
  const ownership = reserveChats(options.api, lanes)
  const aggregates = lanes.map((lane) => ({
    lane,
    latencies: [],
    applied: 0,
    failures: 0,
    unsupported: [],
    censored: false
  }))
  const windows = []
  let cleanup = { status: 'not_needed' }
  try {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const states = aggregates.map((aggregate) => ({
        aggregate,
        lane: aggregate.lane,
        nextIndex: 0,
        inFlightBy: null,
        latencies: [],
        applied: 0,
        failures: 0,
        completedEvents: 0,
        unsupportedEvents: 0,
        lateEvents: 0,
        overlappedLightSamples: 0
      }))
      const window = await runOneWindow(
        states,
        { ...options, clock, timers, windowMs, maxInFlight },
        createPrng(options.seed),
        ownership,
        repetition
      )
      for (const state of states) {
        state.aggregate.latencies.push(...state.latencies)
        state.aggregate.applied += state.applied
        state.aggregate.failures += state.failures
        state.aggregate.unsupported.push(...state.ctx.unsupported)
        state.aggregate.censored ||= window.censored || window.incomplete
      }
      const { pending, ...observed } = window
      windows.push(observed)
      if (pending.length) {
        cleanup = await boundedCleanup(
          options.cancelPending,
          pending,
          window.reason,
          timers,
          cleanupTimeoutMs
        )
        if (cleanup.status === 'confirmed_drained') ownership.confirmDrained()
      }
      if (window.outcome !== 'complete' && window.outcome !== 'diagnostic') break
    }
  } finally {
    ownership.finish()
  }
  const summaries = aggregates.map((aggregate) => ({
    role: aggregate.lane.role,
    chatId: aggregate.lane.chatId,
    eventsApplied: aggregate.applied,
    eventsTotal: aggregate.lane.schedule.length * repetitions,
    eventFailures: aggregate.failures,
    censored: aggregate.censored,
    applyLatencyMs: percentileSummary(aggregate.latencies)
  }))
  const light = aggregates.find((aggregate) => aggregate.lane.role === 'light')
  const signals = { 'light.applyLatencyMs': percentileSummary(light.latencies) }
  const failed = windows.some((window) => window.failed)
  const unsupported = windows.some((window) => window.unsupported)
  const censored = windows.some((window) => window.censored)
  const incomplete =
    windows.length !== repetitions || windows.some((window) => window.outcome === 'incomplete')
  const status = failed
    ? 'failed'
    : unsupported
      ? 'unsupported'
      : incomplete
        ? 'incomplete'
        : censored
          ? 'censored'
          : options.diagnosticOnly
            ? 'diagnostic'
            : 'complete'
  const run = {
    ...(options.cell || options.cellName
      ? { cellName: options.cell ? cellName(options.cell) : options.cellName }
      : {}),
    role: pairingRole,
    workload: options.workload,
    seed: options.seed,
    windowMs,
    repetitions,
    fixtureFingerprint: options.fixtureFingerprint,
    fixtureVersions: options.fixtureVersions,
    buildId: options.buildId,
    signals,
    failed,
    censored,
    unsupported,
    incomplete,
    diagnosticOnly: options.diagnosticOnly === true,
    evidence: {
      schemaVersion: RUN_EVIDENCE_VERSION,
      status,
      diagnosticOnly: options.diagnosticOnly === true,
      lightChatId: light.lane.chatId,
      populations: lanes.map((lane) => ({ role: lane.role, chatId: lane.chatId })),
      windows
    }
  }
  const evidenceErrors = validateRunEvidence(run)
  return {
    ok: !failed && !unsupported && !censored && !incomplete,
    evidenceEligible: evidenceErrors.length === 0,
    evidenceErrors,
    pairingRole,
    windowMs,
    repetitions,
    censored,
    failed,
    incomplete,
    lanes: summaries,
    signals,
    run,
    cleanup,
    unsupported: aggregates.flatMap((aggregate) => aggregate.unsupported)
  }
}

/**
 * `--dry-run`: exercise the seeded scheduler against a fake in-memory
 * adapter with a tiny synthetic fixture. No Electron, no userData, no
 * providers — proof the driver works, not a measurement.
 */
async function runDryRun() {
  const store = new Map()
  const revisions = new Map()
  const api = {
    async getChat(chatId) {
      return store.get(chatId) || null
    },
    async saveChat(record) {
      // Mirror the real store: the ack revision must ADVANCE past the sent
      // revision, or replayDriver correctly treats the save as rejected.
      const sent = typeof record.persistenceRevision === 'number' ? record.persistenceRevision : 0
      const next = Math.max((revisions.get(record.appChatId) || 0) + 1, sent + 1)
      revisions.set(record.appChatId, next)
      store.set(record.appChatId, record)
      return { persistenceRevision: next }
    }
  }
  const makeLane = (role, chatId, events) => {
    const chat = {
      appChatId: chatId,
      updatedAt: 1,
      persistenceRevision: 0,
      messages: Array.from({ length: events }, (_, index) => ({
        id: `${chatId}-m${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: 'x',
        timestamp: '2026-09-08T00:00:00.000Z'
      }))
    }
    const schedule = [
      { seq: 1, kind: 'seed_chat', appChatId: chatId },
      ...Array.from({ length: events }, (_, index) => ({
        seq: index + 2,
        kind: 'append_assistant',
        appChatId: chatId,
        messageIndex: index + 1
      }))
    ]
    return { role, chatId, schedule, chats: [chat] }
  }
  const result = await runConcurrentReplayLanes({
    lanes: [makeLane('light', 'dry-light', 4), makeLane('heavy', 'dry-heavy', 4)],
    api,
    seed: 4242,
    windowMs: 100,
    repetitions: 2,
    diagnosticOnly: true
  })
  return result
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
    process.stderr.write('usage: node scripts/perf/concurrentReplayLanes.cjs --dry-run\n')
    process.exitCode = 2
  }
}

module.exports = {
  LANE_ROLES,
  percentileSummary,
  runConcurrentReplayLanes,
  runDryRun
}
