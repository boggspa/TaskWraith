'use strict'

const { PROGRAMME_ROLLOUT_FLAGS, validateRolloutFlagRecord } = require('./rolloutFlags.cjs')
const { parseCellName } = require('./interferenceMatrix.cjs')
const { RULES } = require('./collectors/mainGapProfileAttribution.cjs')
const ZERO_COUNTERS = Object.freeze([
  'hardBoundFsyncs',
  'failedFsyncEscalations',
  'acknowledgedRevisionGapReanchors',
  'forcedSynchronousCheckpoints',
  'preparationRefusals',
  'promptWorkerDisables',
  'bytesOverCap'
])
const COUNTED_COUNTERS = Object.freeze([
  'strictRunEventFsyncs',
  'd2d3Durability',
  'syncDependencyFlushes',
  'baselineVerifies',
  'fallbackMaterializations',
  'conflictRebasedMaterializations',
  'oversizeMaterializations',
  'unacknowledgedRevisionGapReanchors',
  'conflictRecoveryReanchors',
  'conflictRecoveryReads',
  'shadowReconcileParses',
  'promptWorkerTimeouts',
  'orphanReclaims'
])
const finite = (n) => Number.isFinite(n) && n >= 0
const median = (values) => [...values].sort((a, b) => a - b)[1]
const EXEMPT_REASONS = [
  'd2_d3',
  'strict_run_event',
  'sync_dependency',
  'baseline_verify',
  'in_memory_fallback',
  'in_memory_conflict',
  'in_memory_oversize'
]
const RESIDUAL_OWNERS = ['mutation-derivation', 'conflict-recovery-read', 'shadow-reconcile-parse']
const LISTED_OWNERS = Object.freeze(
  RULES.filter((rule) => rule[1] === 'owner').map((rule) => rule[0])
)

/** Explicit evidence contract; existing diagnostic reports cannot fill absent X2/X3. */
function compareM5FlagPair(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, reasons: ['malformed comparator input'] }
  const { captures, changedFlags = [] } = input
  try {
    JSON.stringify(captures)
  } catch {
    return { ok: false, reasons: ['unserializable captures'] }
  }
  const reasons = []
  const fail = (reason) => reasons.push(reason)
  if (!Array.isArray(captures) || captures.length !== 6)
    return { ok: false, reasons: ['six interleaved captures required'] }
  if (captures.some((capture) => !capture || typeof capture !== 'object' || Array.isArray(capture)))
    return { ok: false, reasons: ['malformed capture'] }
  if (!Array.isArray(changedFlags)) return { ok: false, reasons: ['malformed changed flags'] }
  if (
    !changedFlags.length ||
    changedFlags.some((flag) => !PROGRAMME_ROLLOUT_FLAGS.includes(flag)) ||
    new Set(changedFlags).size !== changedFlags.length
  )
    fail('declared changed flags invalid')
  const pin = JSON.stringify(captures[0].identity)
  const ids = new Set()
  const owner = { off: [], on: [] }
  const caps = []
  for (let index = 0; index < captures.length; index++) {
    const capture = captures[index]
    const state = index % 2 ? 'on' : 'off'
    const repetition = Math.floor(index / 2)
    const identity = capture.identity || {}
    if (
      !/^[a-f0-9]{64}$/.test(identity.buildOutputSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(identity.provenance?.sourceSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(identity.provenance?.dirtyTreeFingerprint || '')
    )
      fail('exact build/source digests required')
    if (capture.gates?.gCorrect !== true || capture.gates?.gCap !== true)
      fail('correctness and capacity qualification required')
    if (
      identity.provenance?.authoritativeBaseline !== true ||
      identity.provenance?.dirty !== false ||
      identity.provenance?.isolatedWorktree !== true ||
      identity.provenance?.gitSha !== identity.gitSha
    )
      fail('qualified source provenance required')
    try {
      parseCellName(identity.cell)
    } catch {
      fail('canonical cell required')
    }
    if (
      identity.workload !== 'light_beside_large_live' ||
      !Number.isSafeInteger(identity.seed) ||
      typeof identity.buildId !== 'string' ||
      !identity.buildId.trim()
    )
      fail('invalid build/workload/seed')
    if (capture.state !== state || capture.repetition !== repetition) fail('ABAB order required')
    if (JSON.stringify(identity) !== pin) fail('capture identity differs')
    if (
      !/^[a-f0-9]{40}$/.test(identity.gitSha || '') ||
      !identity.buildId ||
      !/^[a-f0-9]{64}$/.test(identity.fixtureFingerprint || '') ||
      !identity.workload ||
      identity.seed === undefined ||
      !identity.cell ||
      identity.windowMs !== 120000 ||
      !identity.provenance
    )
      fail('complete build/fixture/provenance identity required')
    if (validateRolloutFlagRecord(capture.rolloutFlags).length)
      fail('complete rollout pins required')
    if (
      JSON.stringify(capture.rolloutFlags?.inheritedOverridden) !==
      JSON.stringify(captures[0].rolloutFlags?.inheritedOverridden)
    )
      fail('inherited rollout environment differs')
    if (capture.i7?.complete !== true || capture.i7?.runtimeFlagInventoryMatched !== true)
      fail('I7 runtime flag inventory incomplete')
    if (
      !Number.isFinite(capture.startedAtMs) ||
      !Number.isFinite(capture.endedAtMs) ||
      capture.endedAtMs <= capture.startedAtMs ||
      (index > 0 && capture.startedAtMs < captures[index - 1].endedAtMs)
    )
      fail('nonoverlapping chronological ABAB captures required')
    for (const flag of PROGRAMME_ROLLOUT_FLAGS) {
      const expected = changedFlags.includes(flag)
        ? state
        : captures[0].rolloutFlags?.effective?.[flag]
      if (capture.rolloutFlags?.effective?.[flag] !== expected) fail('undeclared flag difference')
    }
    const window = capture.window || {}
    if (
      capture.endedAtMs - capture.startedAtMs < 120000 ||
      window.startedAtMs !== capture.startedAtMs ||
      window.endedAtMs !== capture.endedAtMs
    )
      fail('actual window interval must cover nominal 120000ms')
    if (!window.id || ids.has(window.id)) fail('unique window identity required')
    ids.add(window.id)
    if (
      window.role !== 'light-beside' ||
      window.repetition !== repetition ||
      window.censored !== false ||
      window.durationMs !== identity.windowMs
    )
      fail('uncensored beside window required')
    const x = window.evidence || {}
    if (x.x2?.attributionEligible !== true || x.x2?.censored !== false)
      fail('X2 attribution explicitly eligible and uncensored required')
    if (x.x2?.clockId !== x.x1b?.clockId || typeof x.x2?.clockId !== 'string' || !x.x2.clockId)
      fail('shared monotonic gap/profile clock required')
    if (state === 'on' && x.x2?.ownerAbsenceProven !== true) fail('listed-owner absence unproven')
    if (x.x1?.expectedEndAtMs !== window.startedAtMs + identity.windowMs)
      fail('nominal fixed-window deadline mismatch')
    if (x.x1?.startedAtMs !== window.startedAtMs || x.x1?.endedAtMs !== window.endedAtMs)
      fail('X1 interval differs')
    const gaps = x.x1b?.gaps
    const attribution = x.x2?.gapCoverage
    const intervalNative = x.x2?.exact === false && Array.isArray(x.x2?.intervals)
    if (intervalNative) {
      if (
        x.x2.coverage?.complete !== true ||
        x.x2.coverage?.sampledWindowMsBounds?.lower < window.endedAtMs - window.startedAtMs ||
        !Array.isArray(x.x2.unresolvedAttribution) ||
        x.x2.unresolvedAttribution.length ||
        x.x2.calibration?.qualified !== true ||
        x.x2.calibration?.exact !== false ||
        x.x2.sourceProvenance?.complete !== true ||
        x.x2.windowId !== window.id ||
        x.x2.startedAtMs !== window.startedAtMs ||
        x.x2.endedAtMs !== window.endedAtMs
      )
        fail('conservative interval coverage incomplete')
      if (!finite(x.x2.blockedMsBounds?.upper) || x.x2.blockedMsBounds.upper !== x.x1b?.blockedMs)
        fail('interval blocking differs from gap artifact')
      for (const interval of x.x2.intervals) {
        if (
          !interval ||
          interval.exact !== false ||
          !Array.isArray(interval.sourceEvidence) ||
          !interval.sourceEvidence.length ||
          interval.sourceEvidence.some((source) => source.unmapped) ||
          !finite(interval.clippedOverlap?.upperMs) ||
          !finite(interval.clippedOverlap?.lowerMs) ||
          interval.clippedOverlap.lowerMs !== interval.clippedOverlap.upperMs
        )
          fail('uncertain or unbound interval attribution')
      }
    }
    if (
      !/^[a-f0-9]{64}$/.test(x.x2?.profileSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(x.x2?.gapArtifactSha256 || '')
    )
      fail('X2 source artifact digests required')
    if (
      !intervalNative &&
      (!Array.isArray(gaps) ||
        !Array.isArray(attribution) ||
        gaps.length !== attribution.length ||
        x.x2?.windowId !== window.id ||
        x.x2?.startedAtMs !== window.startedAtMs ||
        x.x2?.endedAtMs !== window.endedAtMs)
    )
      fail('exact X2 window/gap coverage required')
    else if (!intervalNative) {
      let sum = 0
      let ownerSum = 0
      for (let n = 0; n < gaps.length; n++) {
        const gap = gaps[n],
          row = attribution[n]
        if (
          !gap ||
          !row ||
          !finite(gap.startedAtMs) ||
          !finite(gap.endedAtMs) ||
          gap.endedAtMs - gap.startedAtMs < 25 ||
          gap.startedAtMs < window.startedAtMs ||
          gap.endedAtMs > window.endedAtMs ||
          (n && (!gaps[n - 1] || gap.startedAtMs < gaps[n - 1].endedAtMs)) ||
          row.complete !== true ||
          row.startedAtMs !== gap.startedAtMs ||
          row.endedAtMs !== gap.endedAtMs ||
          !Array.isArray(row.frames)
        )
          fail('invalid or incomplete gap attribution')
        else {
          sum += gap.endedAtMs - gap.startedAtMs
          let cursor = gap.startedAtMs
          for (const frame of row.frames) {
            if (
              !frame ||
              frame.startedAtMs !== cursor ||
              !finite(frame.endedAtMs) ||
              frame.endedAtMs <= cursor ||
              frame.endedAtMs > gap.endedAtMs ||
              !['listed', 'residual', 'exempt'].includes(frame.classification) ||
              typeof frame.owner !== 'string' ||
              !frame.owner ||
              (frame.classification === 'listed' && !LISTED_OWNERS.includes(frame.owner)) ||
              (frame.classification === 'exempt' && !LISTED_OWNERS.includes(frame.owner)) ||
              (frame.classification === 'exempt' &&
                (!Array.isArray(frame.exemptionReasons) ||
                  !frame.exemptionReasons.length ||
                  frame.exemptionReasons.some((reason) => !EXEMPT_REASONS.includes(reason)))) ||
              (frame.classification === 'residual' && !RESIDUAL_OWNERS.includes(frame.owner))
            ) {
              fail('gap frame coverage incomplete')
              continue
            }
            cursor = frame.endedAtMs
            if (frame.classification === 'listed') {
              ownerSum += frame.endedAtMs - frame.startedAtMs
              if (state === 'on') fail('nonexempt listed owner in loop gap')
            }
          }
          if (cursor !== gap.endedAtMs) fail('gap frame coverage incomplete')
        }
      }
      if (sum !== x.x1b.blockedMs) fail('gap blocked-time sum differs')
      if (ownerSum !== x.x2.listedOwnerMs) fail('owner time differs from gap frames')
    }
    if (!x.x1 || !finite(x.x1.p95Ms) || x.x1.status !== 'complete' || x.x1.id !== window.id)
      fail('X1 missing or invalid')
    if (
      !x.x1b ||
      !finite(x.x1b.blockedMs) ||
      x.x1b.complete !== true ||
      x.x1b.appSuspensionPrevented !== true ||
      x.x1b.definition !== 'expected_timer_gap_at_least_25ms'
    )
      fail('X1b missing or invalid')
    if (
      !x.x2 ||
      (!intervalNative && !finite(x.x2.listedOwnerMs)) ||
      x.x2.complete !== true ||
      (!intervalNative && x.x2.gapAttributed !== true) ||
      (!intervalNative && x.x2.overflow !== 0) ||
      (!intervalNative && !Array.isArray(x.x2.nonExemptOwnerGaps))
    )
      fail('X2 missing or invalid')
    if (!Array.isArray(x.x2?.owners) || LISTED_OWNERS.some((owner) => !x.x2.owners.includes(owner)))
      fail('X2 listed-owner coverage incomplete')
    if (
      !x.x3 ||
      x.x3.complete !== true ||
      [...ZERO_COUNTERS, ...COUNTED_COUNTERS].some(
        (key) => !Number.isSafeInteger(x.x3.counters?.[key]) || x.x3.counters[key] < 0
      )
    )
      fail('X3 missing or invalid')
    const bounds = x.x2?.listedOwnerMsBounds
    if (finite(bounds?.lower) && finite(bounds?.upper) && bounds.lower <= bounds.upper)
      owner[state].push(state === 'on' ? bounds.upper : bounds.lower)
    else fail('owner time bounds unavailable')
    if (state === 'on') {
      if (x.x1?.p95Ms >= 25) fail('X1 lag bound exceeded')
      const cap = finite(x.x1b?.blockedMs) && x.x1b.blockedMs <= identity.windowMs * 0.02
      caps.push(cap)
      if (!cap) fail('2% blocked-time cap exceeded or missing')
      if (x.x2?.nonExemptOwnerGaps?.length) fail('nonexempt listed owner in loop gap')
      if (ZERO_COUNTERS.some((key) => x.x3?.counters?.[key] !== 0))
        fail('zero-required counter nonzero or missing')
    }
  }
  const offMedian = owner.off.length === 3 ? median(owner.off) : null
  const onMedian = owner.on.length === 3 ? median(owner.on) : null
  if (offMedian === null || onMedian === null) fail('owner medians unavailable')
  else {
    const offUpper = captures
      .filter((capture) => capture.state === 'off')
      .map((capture) => capture.window?.evidence?.x2?.listedOwnerMsBounds?.upper)
    if (!offUpper.every(finite) || (median(offUpper) >= 100 && onMedian > offMedian * 0.2))
      fail('80% conservative owner reduction not achieved')
  }
  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    offOwnerMedianMs: offMedian,
    onOwnerMedianMs: onMedian,
    absoluteCaps: caps,
    acceptance: reasons.length ? 'not-qualified' : 'x6-contract-satisfied'
  }
}

module.exports = { compareM5FlagPair, ZERO_COUNTERS, COUNTED_COUNTERS, LISTED_OWNERS }
