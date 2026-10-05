'use strict'

/**
 * M1 live lanes, measured windows (Independent Threads, slice S5c).
 *
 * The heavy lane (S5b) keeps a round streaming on the heavy chat. Each window
 * runs the light lane for `windowMs` beside it and then gathers three kinds
 * of evidence, each read only once the lanes it covers have settled:
 *
 * - Main's spans for the window (the S3a handle, through main's inspector),
 *   read after both lanes settle, because a span is recorded when its work
 *   completes and an open span is simply absent. The light lane settles at
 *   its drain plus a fence; the heavy lane never drains, so it settles a
 *   margin after the window's end, and its spans that run past that margin
 *   are the heavy lane's loss, never the light lane's.
 * - Main's D1 counters, read only at fences (`getMainPerfSnapshot` is main
 *   work): the window is evidence only if deferred journal appends rose,
 *   i.e. real rounds reached D1 through the orchestrator.
 * - The Host's spans, from the S3b union the runner feeds as it samples,
 *   folded once at the end with a settle time per lane (S5c-1).
 *
 * - The scripted daemon's own record of each lane's model turns (every chat
 *   has its own tag), read from the harness's loopback route after the
 *   settle: a round can end `completed` with every seat failed, and the page
 *   observer can miss a round's end, so neither the statuses nor the observer
 *   alone proves the lanes did model work throughout. Each completed light
 *   round is judged on its own turns: light rounds run one at a time, so the
 *   turns started between a round's send and its end are that round's. The
 *   heavy lane is judged over the window and its settle, which it streams
 *   through.
 *
 * A window is eligible only when every one of these holds and the heavy lane
 * ran throughout it. Every reason it is not is named; a failed lane stops the
 * windows that would follow. The light lane's own page-side times (round
 * start as the page saw it, a cancel's response) are reported beside main's
 * spans: the page sees the whole round trip, main only its share.
 */

const { WORK_SPAN_KINDS } = require('./collectors/hostSpans.cjs')
const { timingsByKind } = require('./collectors/hostRecentSpanWindows.cjs')
const { awaitWithTimeout } = require('./boundedAwait.cjs')
const { barrierDurabilityAtFences } = require('./barrierDurability.cjs')

/** Global the S3a handle installs in main (`perfWorkSpanHandle.ts`); keep in lockstep. */
const MAIN_WORK_SPANS_GLOBAL = '__TASKWRAITH_PERF_WORK_SPANS__'
const RING_FIELDS = Object.freeze(['recorded', 'dropped', 'sampledOut', 'rejected', 'degraded'])
const LANE_LABELS = Object.freeze(['light', 'heavy'])
const KIND_SET = new Set(WORK_SPAN_KINDS)
const DEFAULT_OPTIONS = Object.freeze({
  windows: 3,
  windowMs: 120_000,
  fenceMs: 2_000,
  // Light work on the Host can queue behind heavy commits (capture-01's heavy
  // durable_commit p95 was about 10 s), so the light lane gets the same margin.
  lightSettleMarginMs: 30_000,
  heavySettleMarginMs: 30_000,
  // Between two heavy rounds: an observer poll plus a send on a 45 MiB chat.
  maxHeavyIdleMs: 10_000,
  // The longest stretch inside a window with no heavy seat streaming.
  maxHeavyQuietMs: 30_000,
  hostCaptureWaitMs: 7_000
})
const LANE_ACTIVITY_FIELDS = Object.freeze(['started', 'done', 'busyMs', 'maxQuietMs'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** X1b eligibility is separate from the legacy M4 span/Host verdict. */
function mainLoopGapEvidence(mainWindow) {
  const gaps = mainWindow?.loopGaps
  if (!isPlainObject(gaps))
    return { eligible: false, reasons: ['main_gap_evidence_unavailable'], evidence: null }
  const valid =
    gaps.intervalMs === 5 &&
    gaps.thresholdMs === 25 &&
    finiteNonNegative(gaps.startedAtMs) &&
    finiteNonNegative(gaps.endedAtMs) &&
    gaps.startedAtMs === mainWindow.startedAtMs &&
    gaps.endedAtMs === mainWindow.endedAtMs &&
    gaps.observedForMs === gaps.endedAtMs - gaps.startedAtMs &&
    gaps.observedForMs > 0 &&
    finiteNonNegative(gaps.blockedMs) &&
    gaps.blockedMs <= gaps.observedForMs &&
    gaps.blockedFraction === gaps.blockedMs / gaps.observedForMs &&
    Array.isArray(gaps.gaps) &&
    gaps.gaps.length <= 65536 &&
    gaps.gaps.every(
      (gap, index, rows) =>
        isPlainObject(gap) &&
        finiteNonNegative(gap.expectedAtMs) &&
        finiteNonNegative(gap.observedAtMs) &&
        gap.durationMs === gap.observedAtMs - gap.expectedAtMs &&
        gap.durationMs >= 25 &&
        gap.expectedAtMs >= gaps.startedAtMs &&
        gap.observedAtMs <= gaps.endedAtMs &&
        (index === 0 || gap.expectedAtMs >= rows[index - 1].observedAtMs)
    ) &&
    gaps.dropped === 0 &&
    gaps.censored === false &&
    Array.isArray(gaps.reasons) &&
    gaps.reasons.length === 0 &&
    gaps.suspensionProtection?.type === 'prevent-app-suspension' &&
    gaps.suspensionProtection.heldThroughout === true &&
    gaps.gaps.reduce((sum, gap) => sum + gap.durationMs, 0) === gaps.blockedMs
  return {
    eligible: valid,
    reasons: valid ? [] : ['main_gap_evidence_censored_or_invalid'],
    evidence: gaps
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Main-side expression: one S3a read, stringified inside main. */
function mainWorkSpanWindowExpression(query) {
  return (
    `(function(){ var read = globalThis[${JSON.stringify(MAIN_WORK_SPANS_GLOBAL)}]; ` +
    "if (typeof read !== 'function') return null; " +
    `return JSON.stringify(read(${JSON.stringify(query)})); })()`
  )
}

function spanProblem(span) {
  if (!isPlainObject(span)) return 'span_invalid'
  if (!KIND_SET.has(span.kind)) return 'span_kind_invalid'
  if (!finiteNonNegative(span.startedAt) || !finiteNonNegative(span.durationMs)) {
    return 'span_time_invalid'
  }
  if (typeof span.resource !== 'string' || !finiteNonNegative(span.bytes)) return 'span_invalid'
  if (typeof span.fallback !== 'boolean') return 'span_invalid'
  if (span.reason !== undefined && typeof span.reason !== 'string') return 'span_invalid'
  return null
}

/**
 * Validate one S3a read for the two lanes. `{ ok: true, window }` or
 * `{ ok: false, reason }`; a refusal keeps the handle's own reason.
 */
function parseMainWorkSpanWindow(text) {
  if (text === null || text === undefined) return { ok: false, reason: 'main_handle_absent' }
  let value = null
  try {
    value = typeof text === 'string' ? JSON.parse(text) : null
  } catch {
    value = null
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'main_read_invalid' }
  if (typeof value.refused === 'string') {
    return { ok: false, reason: `main_read_refused_${value.refused}` }
  }
  if (!finiteNonNegative(value.sinceMs) || !finiteNonNegative(value.untilMs)) {
    return { ok: false, reason: 'main_read_invalid' }
  }
  if (typeof value.censored !== 'boolean' || !isPlainObject(value.ring)) {
    return { ok: false, reason: 'main_read_invalid' }
  }
  const ring = {}
  for (const field of RING_FIELDS) {
    if (!Number.isSafeInteger(value.ring[field]) || value.ring[field] < 0) {
      return { ok: false, reason: 'main_read_invalid' }
    }
    ring[field] = value.ring[field]
  }
  if (!isPlainObject(value.lanes)) return { ok: false, reason: 'main_read_invalid' }
  const lanes = {}
  for (const label of LANE_LABELS) {
    const lane = value.lanes[label]
    if (!isPlainObject(lane) || !Array.isArray(lane.spans)) {
      return { ok: false, reason: 'main_read_invalid' }
    }
    for (const span of lane.spans) {
      const problem = spanProblem(span)
      if (problem !== null) return { ok: false, reason: `main_read_${problem}` }
    }
    lanes[label] = lane.spans.map((span) => ({
      kind: span.kind,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      bytes: span.bytes,
      fallback: span.fallback,
      ...(span.reason === undefined ? {} : { reason: span.reason })
    }))
  }
  return {
    ok: true,
    window: {
      sinceMs: value.sinceMs,
      untilMs: value.untilMs,
      censored: value.censored,
      ring,
      lanes
    }
  }
}

/** Nearest-rank timings over page-measured durations, or null for none. */
function pageTimings(values) {
  const sorted = values.filter(finiteNonNegative).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const rank = (q) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1))]
  return {
    count: sorted.length,
    p50Ms: rank(50),
    p95Ms: rank(95),
    p99Ms: rank(99),
    maxMs: sorted[sorted.length - 1]
  }
}

function overlapMs(fromMs, toMs, startMs, endMs) {
  return Math.max(0, Math.min(toMs, endMs) - Math.max(fromMs, startMs))
}

/**
 * How long inside [startMs, endMs) the heavy lane had no round streaming: its
 * closed idle intervals, an end not yet followed by a send, and the whole
 * window when no heavy round had been accepted before it ended.
 */
function heavyIdleWithin(heavy, startMs, endMs) {
  const rounds = heavy.rounds.filter((round) => round.acceptedAtMs < endMs)
  if (rounds.length === 0) return endMs - startMs
  let idle = 0
  for (const interval of heavy.idle)
    idle += overlapMs(interval.fromMs, interval.toMs, startMs, endMs)
  const last = heavy.rounds[heavy.rounds.length - 1]
  if (last.endedAtMs !== null) idle += overlapMs(last.endedAtMs, endMs, startMs, endMs)
  return idle
}

function positiveOption(options, name) {
  const value = options[name] === undefined ? DEFAULT_OPTIONS[name] : options[name]
  if (!finiteNonNegative(value) || value === 0) throw new Error(`${name} must be positive`)
  return value
}

/**
 * Run measured windows over installed, started lanes.
 *
 * @param {{
 *   lanes: { runLight(o: { untilMs: number }): Promise<any>, snapshot(): any },
 *   lightChatId: string, heavyChatId: string,
 *   readMainWindow: (query: object) => Promise<unknown>,
 *   readD1Counters: () => Promise<{ deferredAppends: number, normalSaves: number } | null>,
 *   readBarrierDurability?: () => Promise<{ ok: boolean, section?: object, reason?: string }>,
 *   readLaneActivity: (lane: 'light' | 'heavy', range: { fromMs: number, toMs: number }) =>
 *     Promise<{ started: number, done: number, busyMs: number, maxQuietMs: number }>,
 *   hostUnion?: { evaluate(windows: object[], lanes: object): any } | null,
 *   nowMs?: () => number, sleep?: (ms: number) => Promise<void>,
 *   onWindow?: (window: object) => void,
 *   windows?: number, windowMs?: number, fenceMs?: number,
 *   lightSettleMarginMs?: number, heavySettleMarginMs?: number,
 *   maxHeavyIdleMs?: number, maxHeavyQuietMs?: number, hostCaptureWaitMs?: number
 * }} options
 */
async function runLiveLaneWindows(options) {
  if (!isPlainObject(options) || !isPlainObject(options.lanes)) {
    throw new Error('runLiveLaneWindows needs lanes')
  }
  const { lanes, readMainWindow, readD1Counters, readLaneActivity } = options
  if (
    typeof readMainWindow !== 'function' ||
    typeof readD1Counters !== 'function' ||
    typeof readLaneActivity !== 'function'
  ) {
    throw new Error('runLiveLaneWindows needs main window, D1 and lane activity readers')
  }
  const laneChats = { light: options.lightChatId, heavy: options.heavyChatId }
  const count = options.windows === undefined ? DEFAULT_OPTIONS.windows : options.windows
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('windows must be positive')
  const windowMs = positiveOption(options, 'windowMs')
  const fenceMs = positiveOption(options, 'fenceMs')
  const lightSettleMarginMs = positiveOption(options, 'lightSettleMarginMs')
  const heavySettleMarginMs = positiveOption(options, 'heavySettleMarginMs')
  const maxHeavyIdleMs = positiveOption(options, 'maxHeavyIdleMs')
  const maxHeavyQuietMs = positiveOption(options, 'maxHeavyQuietMs')
  const hostCaptureWaitMs = positiveOption(options, 'hostCaptureWaitMs')
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const hostUnion = options.hostUnion || null
  const onWindow = typeof options.onWindow === 'function' ? options.onWindow : null
  const probeMain = async (request) => {
    if (typeof options.readMainPerfWindow !== 'function') {
      return { status: 'unavailable', reason: 'main_window_probe_absent' }
    }
    try {
      const result = await awaitWithTimeout(
        Promise.resolve().then(() => options.readMainPerfWindow(request)),
        options.mainProbeTimeoutMs ?? 5_000,
        'main window probe'
      )
      return isPlainObject(result)
        ? result
        : { status: 'unavailable', reason: 'main_probe_invalid' }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: error?.code === 'CAPTURE_TIMEOUT' ? 'main_unresponsive' : 'main_probe_failed'
      }
    }
  }

  const sleepUntil = async (atMs) => {
    const wait = atMs - nowMs()
    if (wait > 0) await sleep(wait)
  }
  const readMain = async (sinceMs, untilMs) => {
    try {
      return parseMainWorkSpanWindow(await readMainWindow({ lanes: laneChats, sinceMs, untilMs }))
    } catch {
      return { ok: false, reason: 'main_read_failed' }
    }
  }
  const readActivity = async (lane, fromMs, toMs) => {
    try {
      const activity = await readLaneActivity(lane, { fromMs, toMs })
      return isPlainObject(activity) &&
        LANE_ACTIVITY_FIELDS.every(
          (field) => Number.isSafeInteger(activity[field]) && activity[field] >= 0
        )
        ? Object.fromEntries(LANE_ACTIVITY_FIELDS.map((field) => [field, activity[field]]))
        : null
    } catch {
      return null
    }
  }
  const readD1 = async () => {
    try {
      const counters = await readD1Counters()
      return isPlainObject(counters) &&
        Number.isSafeInteger(counters.deferredAppends) &&
        Number.isSafeInteger(counters.normalSaves)
        ? { deferredAppends: counters.deferredAppends, normalSaves: counters.normalSaves }
        : null
    } catch {
      return null
    }
  }
  // Barrier durability, read at the same fences as the save counters when
  // the caller can read it. It never rules a window out.
  const readBarrier = async () => {
    if (typeof options.readBarrierDurability !== 'function') return null
    try {
      const read = await options.readBarrierDurability()
      return isPlainObject(read) ? read : { ok: false, reason: 'read_invalid' }
    } catch {
      return { ok: false, reason: 'read_failed' }
    }
  }

  // The Host fold needs a read strictly before each window starts; later
  // windows have the one before's settle wait, the first gets this lead-in.
  if (hostUnion !== null) await sleep(hostCaptureWaitMs)
  const baselineAtMs = nowMs()
  const baseline = await readMain(baselineAtMs - 1, baselineAtMs)
  // Main's stride sampler never resets once engaged, so every window after
  // this would be censored `main_spans_sampled`: refuse to start them.
  if (baseline.ok && baseline.window.ring.sampledOut > 0) {
    return { windows: [], verdict: liveLaneWindowsVerdict([], count, ['main_sampler_engaged']) }
  }
  let previousRing = baseline.ok ? baseline.window.ring : null
  const windows = []
  const runReasons = []

  const repetitionIndex = options.repetitionIndex ?? 0
  if (!Number.isSafeInteger(repetitionIndex) || repetitionIndex < 0 || repetitionIndex > 2)
    throw new Error('invalid live repetition index')
  for (let offset = 0; offset < count; offset += 1) {
    const repetition = repetitionIndex + offset
    const before = lanes.snapshot()
    const stopped = before.observer.failure ?? before.light.failure ?? before.heavy.failure ?? null
    if (stopped !== null) {
      runReasons.push(`lanes_stopped:${stopped}`)
      break
    }

    const reasons = []
    const d1Before = await readD1()
    const barrierBefore = await readBarrier()
    const windowId = `light_beside_${repetition}`
    const mainWindowBegin = await probeMain({ action: 'begin', id: windowId, durationMs: windowMs })
    const startedAtMs = nowMs()
    const endedAtMs = startedAtMs + windowMs
    const light = await lanes.runLight({ untilMs: endedAtMs })
    const mainWindowEnd =
      mainWindowBegin.status === 'started'
        ? await probeMain({ action: 'end', id: windowId })
        : mainWindowBegin
    let mainWindow = null
    if (
      mainWindowBegin.status === 'started' &&
      mainWindowBegin.id === windowId &&
      mainWindowEnd.status === 'complete' &&
      mainWindowEnd.id === windowId &&
      finiteNonNegative(mainWindowEnd.startedAtMs) &&
      finiteNonNegative(mainWindowEnd.endedAtMs) &&
      mainWindowEnd.endedAtMs - mainWindowEnd.startedAtMs >= windowMs &&
      isPlainObject(mainWindowEnd.eventLoopLag) &&
      mainWindowEnd.eventLoopLag.sampling === true &&
      mainWindowEnd.eventLoopLag.observedForMs > 0 &&
      ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'meanMs', 'observedForMs'].every((name) =>
        finiteNonNegative(mainWindowEnd.eventLoopLag[name])
      )
    ) {
      mainWindow = { ...mainWindowEnd, durabilityBefore: mainWindowBegin.durability ?? null }
    } else if (typeof options.readMainPerfWindow === 'function') {
      reasons.push(mainWindowEnd.reason ?? 'main_probe_invalid')
    }
    const lightDrainedAtMs = Math.max(endedAtMs, light.drainedAtMs ?? endedAtMs)
    const lightSettledAtMs =
      light.drainedAtMs === null ? null : lightDrainedAtMs + lightSettleMarginMs
    const heavySettledAtMs = endedAtMs + heavySettleMarginMs
    await sleepUntil(Math.max(lightSettledAtMs ?? endedAtMs, heavySettledAtMs) + fenceMs)
    const main = await readMain(startedAtMs, endedAtMs)
    const d1After = await readD1()
    const barrierAfter = await readBarrier()
    // Each lane's model turns: the light lane's over its rounds, the heavy
    // lane's over the window and the settle it must have streamed through.
    const activity = {
      light: await readActivity('light', startedAtMs, lightDrainedAtMs + fenceMs),
      heavy: await readActivity('heavy', startedAtMs, heavySettledAtMs)
    }
    // And each completed light round's own: its turns started after its send
    // and before its end was seen (the end inclusive). Aligned with the
    // rounds: undefined for a round not judged, null for a failed read (a
    // range the reader refuses reads the same way).
    const roundTurns = []
    for (const round of light.rounds) {
      roundTurns.push(
        round.status === 'completed'
          ? await readActivity('light', round.sentAtMs, round.endedAtMs + 1)
          : undefined
      )
    }
    const judgedTurns = roundTurns.filter((turns) => turns !== undefined)
    const after = lanes.snapshot()

    // The lanes.
    if (light.failure !== null) reasons.push(`light_lane_failed:${light.failure}`)
    if (light.rounds.length === 0) reasons.push('light_rounds_missing')
    if (after.heavy.failure !== null) reasons.push(`heavy_lane_failed:${after.heavy.failure}`)
    const heavyIdleMs = heavyIdleWithin(after.heavy, startedAtMs, endedAtMs)
    if (heavyIdleMs > maxHeavyIdleMs) reasons.push('heavy_lane_idle')
    // A light round must complete, or end cancelled by the lane's own cancel.
    const completedLight = light.rounds.filter((round) => round.status === 'completed').length
    const roundProblems = new Set()
    for (const round of light.rounds) {
      if (round.status === 'completed') continue
      if (round.status === 'cancelled' && round.control && round.control.cancelled === true) {
        continue
      }
      roundProblems.add(`light_round_${round.status ?? 'unended'}`)
    }
    // A heavy round that ended while its window was being measured completed.
    const heavyEnded = after.heavy.rounds.filter(
      (round) =>
        round.endedAtMs !== null &&
        round.endedAtMs >= startedAtMs &&
        round.endedAtMs < heavySettledAtMs
    )
    for (const round of heavyEnded) {
      if (round.status !== 'completed') roundProblems.add(`heavy_round_${round.status}`)
    }
    reasons.push(...roundProblems)
    // The observer's own health: a fault, or a lane's chat whose changes
    // reached the page on the other channel, can hide a round's end.
    const rose = (field, lane) =>
      (lane ? after.observer[field]?.[lane] : after.observer[field]) >
      (lane ? before.observer[field]?.[lane] : before.observer[field])
    if (rose('faults')) reasons.push('observer_faults')
    if (rose('otherSource', 'light')) reasons.push('light_updates_rerouted')
    if (rose('otherSource', 'heavy')) reasons.push('heavy_updates_rerouted')

    // The daemon's record of each lane's model turns.
    if (
      activity.light === null ||
      activity.heavy === null ||
      judgedTurns.some((turns) => turns === null)
    ) {
      reasons.push('daemon_activity_unavailable')
    } else {
      if (judgedTurns.some((turns) => turns.done === 0)) reasons.push('light_turns_missing')
      if (activity.heavy.done === 0) reasons.push('heavy_turns_missing')
      if (activity.heavy.maxQuietMs > maxHeavyQuietMs) reasons.push('heavy_lane_quiet')
    }

    // D1: real rounds reached the deferred journal inside the fences.
    const d1 =
      d1Before && d1After
        ? {
            deferredAppends: d1After.deferredAppends - d1Before.deferredAppends,
            normalSaves: d1After.normalSaves - d1Before.normalSaves
          }
        : null
    if (d1 === null) reasons.push('d1_counters_unavailable')
    else if (!(d1.deferredAppends > 0)) reasons.push('d1_no_deferred_append')

    // Main's spans.
    let mainEvidence = null
    if (!main.ok) {
      reasons.push(main.reason)
    } else {
      const ring = main.window.ring
      const rise =
        previousRing === null
          ? null
          : Object.fromEntries(
              RING_FIELDS.map((field) => [field, ring[field] - previousRing[field]])
            )
      if (main.window.censored) reasons.push('main_spans_evicted')
      if (rise === null) reasons.push('main_baseline_unavailable')
      else {
        if (rise.sampledOut > 0) reasons.push('main_spans_sampled')
        if (rise.rejected > 0 || rise.degraded > 0) reasons.push('main_spans_lost')
      }
      const lightSpans = main.window.lanes.light
      const heavySpans = main.window.lanes.heavy
      if (light.rounds.length > 0 && !lightSpans.some((span) => span.kind === 'round_start')) {
        reasons.push('main_light_round_start_missing')
      }
      if (heavySpans.length === 0) reasons.push('main_heavy_spans_missing')
      mainEvidence = {
        // A span is recorded when its work completes: one still open at the
        // read is absent, so the heavy lane's timings are lower bounds.
        basis: 'spans completed by the read, after both lanes settled',
        ringRise: rise,
        lanes: { light: timingsByKind(lightSpans), heavy: timingsByKind(heavySpans) }
      }
      previousRing = ring
    }

    const controls = light.rounds.filter((round) => round.control && !round.control.skipped)
    const answered = controls.filter((round) => round.control.ok === true)
    windows.push({
      role: 'light-beside',
      repetition,
      startedAtMs,
      endedAtMs,
      laneSettledAtMs: { light: lightSettledAtMs, heavy: heavySettledAtMs },
      reasons,
      light: {
        rounds: light.rounds.length,
        completed: completedLight,
        drainedAtMs: light.drainedAtMs,
        statuses: light.rounds.map((round) => round.status),
        roundStartPage: pageTimings(light.rounds.map((round) => round.pageMs)),
        cancelPage: pageTimings(answered.map((round) => round.control.pageMs)),
        cancels: controls.length,
        cancelsFailed: controls.length - answered.length,
        // Beside `statuses`: the turns each completed round finished, null
        // for a round not judged or a read that failed.
        turnsDone: roundTurns.map((turns) => (turns ? turns.done : null))
      },
      heavy: { idleMs: heavyIdleMs, roundsEnded: heavyEnded.length },
      activity,
      d1,
      barrierDurability: barrierDurabilityAtFences(barrierBefore, barrierAfter),
      main: mainEvidence,
      mainWindow,
      mainWindowCensored: mainWindow === null,
      mainX1b: mainLoopGapEvidence(mainWindow),
      host: null
    })
    if (onWindow !== null) {
      try {
        onWindow({ ...windows[windows.length - 1], reasons: [...reasons] })
      } catch {
        // Progress only: a failing observer never costs a window.
      }
    }
  }

  // The Host's spans, folded once with a settle time per lane.
  if (windows.length > 0) {
    if (hostUnion === null) {
      for (const window of windows) window.reasons.push('host_evidence_unavailable')
    } else {
      await sleep(hostCaptureWaitMs)
      const folded = hostUnion.evaluate(
        windows.map((window) => ({
          role: window.role,
          repetition: window.repetition,
          startedAtMs: window.startedAtMs,
          endedAtMs: window.endedAtMs,
          laneSettledAtMs: {
            heavy: window.laneSettledAtMs.heavy,
            ...(window.laneSettledAtMs.light === null
              ? {}
              : { light: window.laneSettledAtMs.light })
          }
        })),
        laneChats
      )
      windows.forEach((window, index) => {
        if (!folded || !folded.ok) {
          window.reasons.push(`host_fold_refused:${folded ? folded.reason : 'no_result'}`)
          return
        }
        const evidence = folded.evidence.windows[index]
        window.host = evidence
        if (!evidence.lanes)
          window.reasons.push(...evidence.reasons.map((reason) => `host_${reason}`))
        else if (evidence.lanes.light.censored) {
          window.reasons.push(
            ...evidence.lanes.light.reasons.map((reason) => `host_light_${reason}`)
          )
        } else if (window.light.rounds > 0 && spanCount(evidence.lanes.light.byKind) === 0) {
          // A mis-keyed chat reads as an empty lane, as on main.
          window.reasons.push('host_light_spans_missing')
        }
      })
    }
  }

  return { windows, verdict: liveLaneWindowsVerdict(windows, count, runReasons) }
}

/** How many spans a lane's per-kind timings count. */
function spanCount(byKind) {
  return isPlainObject(byKind)
    ? Object.values(byKind).reduce((sum, timings) => sum + (timings?.count ?? 0), 0)
    : 0
}

/**
 * Every window run, and every one eligible; each reason names its window.
 * `runReasons` are why no window could start, listed first.
 */
function liveLaneWindowsVerdict(windows, expected, runReasons = []) {
  const reasons = [...runReasons]
  const list = Array.isArray(windows) ? windows : []
  if (list.length < expected) reasons.push(`windows_run:${list.length}/${expected}`)
  for (const window of list) {
    for (const reason of window.reasons) reasons.push(`window ${window.repetition}: ${reason}`)
  }
  return { ok: reasons.length === 0, reasons }
}

module.exports = {
  mainLoopGapEvidence,
  DEFAULT_LIVE_LANE_WINDOW_OPTIONS: DEFAULT_OPTIONS,
  MAIN_WORK_SPANS_GLOBAL,
  heavyIdleWithin,
  liveLaneWindowsVerdict,
  mainWorkSpanWindowExpression,
  pageTimings,
  parseMainWorkSpanWindow,
  runLiveLaneWindows
}
