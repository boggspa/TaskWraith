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
 * path only), no Ensemble-pool or Host-native saturation, no control actions
 * (cancel/approval/answer/seat toggle). A cell run through this driver alone
 * is NOT a measured Appendix A cell.
 */

const { applyReplayEventWithTimeout } = require('./replayDriver.cjs')
const { createPrng } = require('./fixtureGenerator.cjs')
const { MATRIX_SAMPLING, cellName } = require('./interferenceMatrix.cjs')

const LANE_ROLES = Object.freeze(['light', 'heavy'])
const PAIRING_ROLES = Object.freeze(['light-alone', 'light-beside'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Nearest-rank percentiles, matching the recorder's convention. */
function percentileSummary(values) {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 }
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
  const errors = []
  if (!isPlainObject(lane)) return [`lane ${index} must be an object`]
  if (!LANE_ROLES.includes(lane.role)) errors.push(`lane ${index} role must be light|heavy`)
  if (typeof lane.chatId !== 'string' || lane.chatId.length === 0) {
    errors.push(`lane ${index} chatId required`)
  }
  if (!Array.isArray(lane.schedule)) errors.push(`lane ${index} schedule must be an array`)
  if (lane.pairingRole !== undefined && !PAIRING_ROLES.includes(lane.pairingRole)) {
    errors.push(`lane ${index} pairingRole must be light-alone|light-beside`)
  }
  return errors
}

/**
 * Run one window of the seeded interleave. Returns per-lane state; the
 * caller aggregates across repetitions.
 */
async function runOneWindow(laneStates, options, prng) {
  const nowMs = options.nowMs
  const maxInFlight = options.maxInFlight
  const windowMs = options.windowMs
  const windowStart = nowMs()
  /** @type {Set<Promise<object>>} */
  const pending = new Set()

  const startNext = (state) => {
    const eventIndex = state.nextIndex
    const event = state.lane.schedule[eventIndex]
    state.nextIndex += 1
    const startedAtMs = nowMs()
    // The promise STAYS in `pending` after settling; only the race branch
    // below removes it. Deleting on settle would let a finished event vanish
    // unrecorded and pin its lane as forever-in-flight.
    const application = Promise.resolve()
      .then(() =>
        applyReplayEventWithTimeout(
          state.ctx,
          event,
          { eventNumber: eventIndex + 1, totalEvents: state.lane.schedule.length, startedAtMs },
          options
        )
      )
      .then(
        (result) => ({ state, startedAtMs, result }),
        (error) => ({ state, startedAtMs, error })
      )
    pending.add(application)
    return application
  }

  while (true) {
    // The window fence is checked before ANY new start: an expired window
    // censors instead of launching more work.
    const windowEnded = nowMs() - windowStart >= windowMs
    const eligible = laneStates.filter(
      (state) => state.nextIndex < state.lane.schedule.length && !state.inFlightBy
    )
    if (!windowEnded && eligible.length > 0 && pending.size < maxInFlight) {
      const pick = eligible[Math.floor(prng() * eligible.length)]
      // Invariant: one in-flight event per lane — per-lane order is never
      // reordered by the scheduler, only interleaved across lanes.
      pick.inFlightBy = startNext(pick)
      continue
    }
    if (pending.size > 0) {
      const settled = await Promise.race(pending)
      pending.delete(settled.state.inFlightBy)
      settled.state.inFlightBy = null
      const latencyMs = Math.max(0, nowMs() - settled.startedAtMs)
      if (settled.error) {
        settled.state.failures += 1
        settled.state.errors.push(settled.error)
      } else {
        settled.state.latencies.push(latencyMs)
        settled.state.applied += 1
      }
      continue
    }
    if (windowEnded) {
      for (const state of laneStates) {
        if (state.nextIndex < state.lane.schedule.length) state.censored = true
      }
      return
    }
    if (eligible.length === 0) return
  }
}

/**
 * Run the lane set for the fixed sampling window, `repetitions` times.
 *
 * @param {object} options
 * @param {Array<object>} options.lanes lane specs:
 *   { role: 'light'|'heavy', chatId, schedule, chats?, pairingRole? }
 * @param {object} options.api page adapter (getChat/saveChat[/savePrefix])
 * @param {number} options.seed seeds the cross-lane interleave
 * @param {object} [options.cell] matrix cell descriptor for the run descriptor
 * @param {string} [options.cellName] alternative: pre-computed canonical name
 * @param {'light-alone'|'light-beside'} [options.pairingRole] derived from the
 *   lane roles when omitted (any heavy lane → light-beside)
 * @param {number} [options.windowMs] default MATRIX_SAMPLING.windowMs (120 s)
 * @param {number} [options.repetitions] default MATRIX_SAMPLING.repetitions (3)
 * @param {number} [options.maxInFlight] default lanes.length
 * @param {() => number} [options.nowMs] clock injection (tests)
 * Metadata pass-through for the run descriptor (pairRuns validates them):
 *   workload, fixtureFingerprint, fixtureVersions, buildId.
 */
async function runConcurrentReplayLanes(options) {
  const errors = []
  if (!isPlainObject(options)) throw new Error('options required')
  if (
    !options.api ||
    typeof options.api.getChat !== 'function' ||
    typeof options.api.saveChat !== 'function'
  ) {
    throw new Error('api.getChat and api.saveChat required')
  }
  if (!Array.isArray(options.lanes) || options.lanes.length === 0) {
    throw new Error('at least one lane required')
  }
  options.lanes.forEach((lane, index) => errors.push(...validateLaneSpec(lane, index)))
  if (!Number.isSafeInteger(options.seed)) throw new Error('seed must be a safe integer')
  if (errors.length > 0) throw new Error(`invalid lane specs: ${errors.join('; ')}`)

  const windowMs = options.windowMs == null ? MATRIX_SAMPLING.windowMs : options.windowMs
  const repetitions =
    options.repetitions == null ? MATRIX_SAMPLING.repetitions : options.repetitions
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive')
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error('repetitions must be a positive integer')
  }
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now
  const maxInFlight = options.maxInFlight == null ? options.lanes.length : options.maxInFlight

  const hasHeavy = options.lanes.some((lane) => lane.role === 'heavy')
  const pairingRole = options.pairingRole || (hasHeavy ? 'light-beside' : 'light-alone')
  for (const [index, lane] of options.lanes.entries()) {
    if (lane.pairingRole !== undefined && lane.pairingRole !== pairingRole) {
      throw new Error(`lane ${index} pairingRole ${lane.pairingRole} != run role ${pairingRole}`)
    }
  }

  const aggregates = options.lanes.map((lane) => ({
    lane,
    latencies: [],
    applied: 0,
    failures: 0,
    errors: [],
    censored: false,
    unsupported: []
  }))

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    // One PRNG per repetition at the SAME seed: every rep replays the same
    // cross-lane start order, so rep-to-rep deltas are timing, not schedule.
    const prng = createPrng(options.seed)
    const laneStates = aggregates.map((aggregate) => ({
      aggregate,
      lane: aggregate.lane,
      ctx: makeLaneContext(options.api, aggregate.lane),
      nextIndex: 0,
      inFlightBy: null,
      latencies: [],
      applied: 0,
      failures: 0,
      errors: [],
      censored: false
    }))
    await runOneWindow(laneStates, { ...options, nowMs, windowMs, maxInFlight }, prng)
    for (const state of laneStates) {
      const aggregate = state.aggregate
      aggregate.latencies.push(...state.latencies)
      aggregate.applied += state.applied
      aggregate.failures += state.failures
      aggregate.errors.push(...state.errors)
      aggregate.censored = aggregate.censored || state.censored
      aggregate.unsupported.push(...state.ctx.unsupported)
    }
  }

  const lanes = aggregates.map((aggregate) => ({
    role: aggregate.lane.role,
    chatId: aggregate.lane.chatId,
    eventsApplied: aggregate.applied,
    eventsTotal: aggregate.lane.schedule.length * repetitions,
    eventFailures: aggregate.failures,
    censored: aggregate.censored,
    applyLatencyMs: percentileSummary(aggregate.latencies)
  }))

  // The compared signals are LIGHT-lane only, so the alone/beside runs of a
  // pair present identical signal sets (pairRuns refuses otherwise).
  const lightLatencies = aggregates
    .filter((aggregate) => aggregate.lane.role === 'light')
    .flatMap((aggregate) => aggregate.latencies)
  const signals = { 'light.applyLatencyMs': percentileSummary(lightLatencies) }

  const resolvedCellName = options.cell ? cellName(options.cell) : options.cellName
  const run = {
    ...(resolvedCellName ? { cellName: resolvedCellName } : {}),
    role: pairingRole,
    workload: options.workload,
    seed: options.seed,
    windowMs,
    repetitions,
    ...(options.fixtureFingerprint ? { fixtureFingerprint: options.fixtureFingerprint } : {}),
    ...(options.fixtureVersions ? { fixtureVersions: options.fixtureVersions } : {}),
    ...(options.buildId ? { buildId: options.buildId } : {}),
    signals
  }

  return {
    ok: true,
    pairingRole,
    windowMs,
    repetitions,
    censored: aggregates.some((aggregate) => aggregate.censored),
    lanes,
    signals,
    run,
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
    windowMs: 60_000,
    repetitions: 2
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
