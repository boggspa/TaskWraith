'use strict'

/**
 * M1 S3b: per-window Host span evidence from the snapshot file's recent-span
 * tails (Independent Threads Programme; the design is the "S3b design"
 * section of the local-only M1 live-driver record).
 *
 * The Host writes its newest accepted spans, each with its acceptance
 * sequence, into every snapshot (`workSpans.recentSpans`, shape-validated by
 * hostSpans.cjs). The runner accepts one read per writer capture. The tails
 * overlap, so their union is every span the Host accepted, except where an
 * accepted read's tail no longer reaches back to the previous one's: a HOLE.
 * This module unions the tails, records the holes, and cuts each lane's spans
 * per window, with nearest-rank percentiles (the recorder's own estimator).
 * A window a hole could have touched is censored and carries no percentiles,
 * so a censored window can never produce a passing p95.
 *
 * WHY A HOLE CENSORS WHAT IT CENSORS. Every tail is a suffix of the Host's
 * acceptance order that ends at the newest accepted span. So when a read's
 * tail starts above the newest sequence already seen, the missing spans were
 * all accepted after the previous tail-bearing read was captured, and each
 * started no later than this read's `omittedMaxStartedAt`. A lost span can
 * only be one of window W's if it started at or after W's start and was
 * accepted before W's lane settled (`settledAtMs`: the lane driver's claim
 * that every span of the lane that started inside W had been accepted by
 * then). So a hole censors W when `omittedMaxStartedAt >= W.start` and the
 * previous tail-bearing read was captured at or before W settled.
 *
 * BOUNDARIES ARE STRICT. A capture reads its tail, then its clock, in one
 * synchronous Host turn, so no span is accepted in between; but a span
 * accepted in the capture's millisecond may land on either side of it. So a
 * capture stamped exactly at a window's start cannot be its leading read, one
 * stamped exactly at its settle time cannot be its trailing read, and a hole
 * after a read stamped exactly at settle may hold a window span.
 *
 * A window also needs:
 *  - a read captured before its start, the baseline for the lost-span
 *    counters (`leading_capture_missing`);
 *  - a tail-bearing read captured after it settled, so every span accepted
 *    by then is in the union (`trailing_capture_missing`);
 *  - no rejected or clock-degraded span between those two reads, because
 *    either loses a span without a sequence (`spans_lost`; the counters are
 *    process-wide, so this is conservative);
 *  - no sampled-out span between them either (`spans_sampled`). The default
 *    sampler is a global 1-in-8 stride once a recorder has been offered
 *    65,536 spans, and a stride aliases with a lane's rhythm: the S3a review
 *    measured one light span per seven heavy keeping 40/40 light spans and
 *    0/280 heavy ones. A sampled window is not a thinner sample of a lane; it
 *    can be none of it;
 *  - no lane span that contradicts the settle claim by being accepted after
 *    the trailing read or ending after `settledAtMs` (`settle_violated`).
 *
 * Residuals, invisible because the settle checks see only observed spans:
 *  - a lane span accepted after its window settled AND lost to a later hole;
 *  - a lane span offered after the trailing read and then rejected or
 *    sampled out: its counters move after the bracket closes;
 *  - a span a Host path drops without counting it: `HostProjectionSerialQueue`
 *    skips a span when the clock degrades without touching `degraded`, and a
 *    receipt span with no resolvable chat id is never offered.
 *
 * One Host only: the first read pins the Host's identity and any other
 * refuses the union, because sequences restart with a Host.
 *
 * PER-LANE SETTLE (M1 S5c). A lane that never drains (the live heavy lane
 * keeps a round streaming) cannot share the light lane's settle time: its
 * spans that start inside W may end long after the light lane settles. A
 * window may therefore carry `laneSettledAtMs: { <label>: ms }`, and each
 * lane is then judged on its own settle time: its trailing read, its
 * lost-span counters, the holes that can hold its spans and its own settle
 * claim. Only what every lane shares (the window's bounds, its leading
 * read) is judged once, and a lane is censored alone, keeping its own
 * reasons. Without it, one settle time judges every lane, as above.
 */

const { WORK_SPAN_KINDS, validateRecentSpans } = require('./hostSpans.cjs')

const HOST_RECENT_SPAN_WINDOWS_SCHEMA_VERSION = 1
const COUNTER_FIELDS = Object.freeze(['recorded', 'dropped', 'sampledOut', 'rejected', 'degraded'])
const MAX_LANES = 8
const MAX_CHAT_ID_LENGTH = 256
const LANE_LABEL = /^[a-z][a-z0-9_]{0,31}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The recorder's estimator (WorkSpanRecorder.ts nearestRank), for n >= 1. */
function nearestRank(sortedAscending, q) {
  const rank = Math.ceil((q / 100) * sortedAscending.length)
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))]
}

function sameSpan(left, right) {
  return (
    left.chatId === right.chatId &&
    left.kind === right.kind &&
    left.resource === right.resource &&
    left.startedAt === right.startedAt &&
    left.durationMs === right.durationMs &&
    left.bytes === right.bytes &&
    left.fallback === right.fallback &&
    left.reason === right.reason
  )
}

const IDENTITY_FIELDS = Object.freeze(['instanceId', 'generation', 'pid', 'bootEpoch'])

/** A comparable key for a read's Host identity: null when absent, undefined when malformed. */
function identityKey(identity) {
  if (identity === undefined) return null
  if (!isPlainObject(identity)) return undefined
  return JSON.stringify(IDENTITY_FIELDS.map((field) => identity[field] ?? null))
}

/** label → chat id, or null when any lane is malformed (as main's S3a handle). */
function readLanes(value) {
  if (!isPlainObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_LANES) return null
  const lanes = new Map()
  const chats = new Set()
  for (const [label, chatId] of entries) {
    if (!LANE_LABEL.test(label)) return null
    if (typeof chatId !== 'string' || chatId.length === 0 || chatId.length > MAX_CHAT_ID_LENGTH) {
      return null
    }
    if (chats.has(chatId)) return null
    chats.add(chatId)
    lanes.set(label, chatId)
  }
  return lanes
}

/** Per-kind timings over one lane's spans in one window, in taxonomy order. */
function timingsByKind(spans) {
  const byKind = {}
  for (const kind of WORK_SPAN_KINDS) {
    const ofKind = spans.filter((span) => span.kind === kind)
    if (ofKind.length === 0) continue
    const sorted = ofKind.map((span) => span.durationMs).sort((a, b) => a - b)
    byKind[kind] = {
      count: sorted.length,
      totalMs: sorted.reduce((sum, value) => sum + value, 0),
      p50Ms: nearestRank(sorted, 50),
      p95Ms: nearestRank(sorted, 95),
      p99Ms: nearestRank(sorted, 99),
      maxMs: sorted[sorted.length - 1],
      bytes: ofKind.reduce((sum, span) => sum + span.bytes, 0),
      fallbackCount: ofKind.filter((span) => span.fallback).length
    }
  }
  return byKind
}

/**
 * An incremental union of accepted Host reads, so the runner can fold each
 * read as it arrives instead of retaining every tail. `add` takes reads in
 * acceptance order (readHostPerfSnapshotFile results); the first refusal is
 * sticky, because a union with a contradiction in it proves nothing.
 */
function createHostRecentSpanUnion() {
  /** seq → span; insertion order is ascending seq (new rows always extend it). */
  const spans = new Map()
  const holes = []
  const captures = []
  let newestSeen = 0
  let previousTailCapturedAtMs = null
  let pinnedIdentity
  let failure = null

  const fail = (reason) => {
    failure = reason
    return { ok: false, reason }
  }

  function add(sample) {
    if (failure !== null) return { ok: false, reason: failure }
    if (!isPlainObject(sample)) return fail('sample must be an object')
    const identity = identityKey(sample.identity)
    if (identity === undefined) return fail('sample.identity must be an object')
    if (pinnedIdentity === undefined) pinnedIdentity = identity
    else if (identity !== pinnedIdentity) return fail('sample.identity changed: another Host')
    const previous = captures.length > 0 ? captures[captures.length - 1] : null
    if (!Number.isSafeInteger(sample.sequence) || sample.sequence <= 0) {
      return fail('sample.sequence must be a positive integer')
    }
    if (previous && sample.sequence <= previous.sequence) {
      return fail('sample.sequence must increase')
    }
    const capturedAtMs = typeof sample.capturedAt === 'string' ? Date.parse(sample.capturedAt) : NaN
    if (!Number.isFinite(capturedAtMs)) return fail('sample.capturedAt must be an ISO timestamp')
    if (previous && capturedAtMs < previous.capturedAtMs) {
      return fail('sample.capturedAt went backwards')
    }
    const section = sample.workSpans
    if (!isPlainObject(section)) return fail('sample.workSpans must be an object')
    const counters = {}
    for (const field of COUNTER_FIELDS) {
      if (!finiteNonNegative(section[field]))
        return fail(`sample.workSpans.${field} must be finite`)
      counters[field] = section[field]
    }
    if (previous && COUNTER_FIELDS.some((field) => counters[field] < previous.counters[field])) {
      return fail('span counters went backwards: the Host recorder restarted or reset')
    }
    const capture = { sequence: sample.sequence, capturedAtMs, tail: false, toSeq: null, counters }
    const recent = section.recentSpans
    if (recent === undefined) {
      // The writer dropped the tail to fit its cap, or the Host predates it.
      // The next tail-bearing read decides whether anything accepted
      // meanwhile was lost. A tail that is present is self-describing (a
      // suffix ending at `recorded`, with its watermark), so it is used even
      // under a truncation marker.
      captures.push(capture)
      return { ok: true, tail: false }
    }
    const errors = []
    validateRecentSpans(recent, { recorded: section.recorded, dropped: section.dropped }, errors)
    if (errors.length > 0) return fail(`sample.workSpans.recentSpans: ${errors[0]}`)

    const firstInTail = recent.fromSeq === null ? section.recorded + 1 : recent.fromSeq
    const hole =
      firstInTail > newestSeen + 1
        ? {
            sequence: sample.sequence,
            capturedAtMs,
            previousCapturedAtMs: previousTailCapturedAtMs,
            missingFromSeq: newestSeen + 1,
            missingToSeq: firstInTail - 1,
            omittedMaxStartedAt: recent.omittedMaxStartedAt
          }
        : null
    const added = []
    for (const row of recent.rows) {
      const span = {
        seq: row[0],
        chatId: recent.chats[row[1]],
        kind: row[2],
        resource: row[3],
        startedAt: row[4],
        durationMs: row[5],
        bytes: row[6],
        fallback: row[7],
        reason: row[8]
      }
      const known = spans.get(span.seq)
      if (known !== undefined) {
        if (!sameSpan(known, span)) return fail(`recent span ${span.seq} differs between reads`)
        continue
      }
      // A tail's first sequence never moves backwards, so an unknown row at
      // or below the newest sequence seen means the tails contradict.
      if (span.seq <= newestSeen) return fail(`recent span ${span.seq} reappeared after a gap`)
      added.push(span)
    }
    for (const span of added) spans.set(span.seq, span)
    if (hole) holes.push(hole)
    newestSeen = Math.max(newestSeen, section.recorded)
    previousTailCapturedAtMs = capturedAtMs
    capture.tail = true
    capture.toSeq = section.recorded
    captures.push(capture)
    return { ok: true, tail: true }
  }

  /** The latest read captured strictly before `start`: the counters' baseline. */
  function leadingCapture(start) {
    return captures.filter((capture) => capture.capturedAtMs < start).pop()
  }

  /** Each lane's spans that started inside [start, end), in acceptance order. */
  function laneSpansIn(lanes, ordered, start, end) {
    const labelOf = new Map([...lanes].map(([label, chatId]) => [chatId, label]))
    const laneSpans = new Map([...lanes.keys()].map((label) => [label, []]))
    for (const span of ordered) {
      if (span.startedAt < start || span.startedAt >= end) continue
      const label = labelOf.get(span.chatId)
      if (label !== undefined) laneSpans.get(label).push(span)
    }
    return laneSpans
  }

  /**
   * Judge `spans` against one settle time: the trailing read after it, the
   * holes that can hold spans accepted by then, the counters between the
   * leading and trailing reads, and the settle claim itself. Pushes the
   * reasons it finds onto `reasons`.
   */
  function judge({ start, end, settledAtMs, leading, spans, reasons }) {
    const settled = settledAtMs !== null && settledAtMs >= end ? settledAtMs : null
    if (settled === null) reasons.push('settle_unknown')
    const trailing =
      settled === null
        ? undefined
        : captures.find((capture) => capture.tail && capture.capturedAtMs > settled)
    if (!trailing) reasons.push('trailing_capture_missing')
    const settledOrLatest = settled ?? Infinity
    if (
      holes.some(
        (hole) =>
          hole.omittedMaxStartedAt !== null &&
          hole.omittedMaxStartedAt >= start &&
          (hole.previousCapturedAtMs === null || hole.previousCapturedAtMs <= settledOrLatest)
      )
    ) {
      reasons.push('transport_hole')
    }
    let counters = null
    if (leading && trailing) {
      counters = {}
      for (const field of COUNTER_FIELDS) {
        counters[field] = trailing.counters[field] - leading.counters[field]
      }
      if (counters.rejected > 0 || counters.degraded > 0) reasons.push('spans_lost')
      if (counters.sampledOut > 0) reasons.push('spans_sampled')
    }
    if (
      spans.some(
        (span) =>
          (trailing && span.seq > trailing.toSeq) ||
          span.startedAt + span.durationMs > settledOrLatest
      )
    ) {
      reasons.push('settle_violated')
    }
    return { settled, trailing, counters }
  }

  function windowRecord(window) {
    return {
      role: window.role,
      repetition: window.repetition,
      startedAtMs: finiteOrNull(window.startedAtMs),
      endedAtMs: finiteOrNull(window.endedAtMs)
    }
  }

  function boundsUsable(record) {
    return (
      record.startedAtMs !== null &&
      record.endedAtMs !== null &&
      record.startedAtMs < record.endedAtMs
    )
  }

  /** One window, every lane judged on the window's one settle time. */
  function evaluateWindow(window, lanes, ordered) {
    const record = { ...windowRecord(window), settledAtMs: finiteOrNull(window.settledAtMs) }
    if (!boundsUsable(record)) {
      return {
        ...record,
        censored: true,
        reasons: ['window_bounds_unavailable'],
        counters: null,
        brackets: null,
        lanes: null
      }
    }
    const { startedAtMs: start, endedAtMs: end } = record
    const reasons = []
    const leading = leadingCapture(start)
    if (!leading) reasons.push('leading_capture_missing')
    const laneSpans = laneSpansIn(lanes, ordered, start, end)
    const { trailing, counters } = judge({
      start,
      end,
      settledAtMs: record.settledAtMs,
      leading,
      spans: [...laneSpans.values()].flat(),
      reasons
    })
    const censored = reasons.length > 0
    return {
      ...record,
      censored,
      reasons,
      counters,
      brackets:
        leading && trailing
          ? { leadingSequence: leading.sequence, trailingSequence: trailing.sequence }
          : null,
      lanes: censored
        ? null
        : Object.fromEntries(
            [...laneSpans].map(([label, list]) => [label, { byKind: timingsByKind(list) }])
          )
    }
  }

  /** One window, each lane judged on its own settle time (see PER-LANE SETTLE). */
  function evaluateWindowPerLane(window, lanes, ordered) {
    const record = windowRecord(window)
    if (!boundsUsable(record)) {
      return {
        ...record,
        censored: true,
        reasons: ['window_bounds_unavailable'],
        leadingSequence: null,
        lanes: null
      }
    }
    const { startedAtMs: start, endedAtMs: end } = record
    const shared = []
    const leading = leadingCapture(start)
    if (!leading) shared.push('leading_capture_missing')
    const evidence = {}
    for (const [label, spans] of laneSpansIn(lanes, ordered, start, end)) {
      const reasons = [...shared]
      const { settled, trailing, counters } = judge({
        start,
        end,
        settledAtMs: finiteOrNull(window.laneSettledAtMs[label]),
        leading,
        spans,
        reasons
      })
      const censored = reasons.length > 0
      evidence[label] = {
        settledAtMs: settled,
        censored,
        reasons,
        counters,
        trailingSequence: trailing ? trailing.sequence : null,
        byKind: censored ? null : timingsByKind(spans)
      }
    }
    return {
      ...record,
      censored: Object.values(evidence).some((lane) => lane.censored),
      reasons: shared,
      leadingSequence: leading ? leading.sequence : null,
      lanes: evidence
    }
  }

  function evaluate(windows, lanes) {
    if (failure !== null) return { ok: false, reason: failure }
    const laneMap = readLanes(lanes)
    if (!laneMap) {
      return {
        ok: false,
        reason: `lanes must map 1-${MAX_LANES} lowercase labels to distinct chat ids`
      }
    }
    if (!Array.isArray(windows)) return { ok: false, reason: 'windows must be an array' }
    const ordered = [...spans.values()]
    const evidenceWindows = []
    for (const [index, window] of windows.entries()) {
      if (!isPlainObject(window))
        return { ok: false, reason: `windows[${index}] must be an object` }
      if (typeof window.role !== 'string' || window.role.length === 0) {
        return { ok: false, reason: `windows[${index}].role must be a non-empty string` }
      }
      if (!Number.isSafeInteger(window.repetition) || window.repetition < 0) {
        return { ok: false, reason: `windows[${index}].repetition must be a non-negative integer` }
      }
      if (window.laneSettledAtMs === undefined) {
        evidenceWindows.push(evaluateWindow(window, laneMap, ordered))
        continue
      }
      const settles = window.laneSettledAtMs
      if (!isPlainObject(settles) || Object.keys(settles).some((label) => !laneMap.has(label))) {
        return {
          ok: false,
          reason: `windows[${index}].laneSettledAtMs must map measured lanes to settle times`
        }
      }
      evidenceWindows.push(evaluateWindowPerLane(window, laneMap, ordered))
    }
    return {
      ok: true,
      evidence: {
        schemaVersion: HOST_RECENT_SPAN_WINDOWS_SCHEMA_VERSION,
        basis: {
          spans: 'union of Host recent-span tails, keyed by acceptance sequence',
          percentiles: 'nearest rank over every observed span of the lane and kind',
          censoring: 'a censored window carries reasons and no percentiles'
        },
        union: {
          spans: spans.size,
          captures: captures.length,
          tailCaptures: captures.filter((capture) => capture.tail).length,
          holes: holes.map((hole) => ({ ...hole }))
        },
        windows: evidenceWindows
      }
    }
  }

  return { add, evaluate }
}

/** Fold a finished list of accepted reads; see createHostRecentSpanUnion. */
function foldHostRecentSpanWindows(options) {
  if (!isPlainObject(options)) return { ok: false, reason: 'options required' }
  if (!Array.isArray(options.samples)) return { ok: false, reason: 'samples must be an array' }
  const union = createHostRecentSpanUnion()
  for (const [index, sample] of options.samples.entries()) {
    const added = union.add(sample)
    if (!added.ok) return { ok: false, reason: `samples[${index}]: ${added.reason}` }
  }
  return union.evaluate(options.windows, options.lanes)
}

module.exports = {
  HOST_RECENT_SPAN_WINDOWS_SCHEMA_VERSION,
  createHostRecentSpanUnion,
  foldHostRecentSpanWindows,
  timingsByKind
}
