#!/usr/bin/env node
'use strict'

/**
 * Outcome 5/11 evidence instrument — decision core.
 *
 * WHAT THIS FILE IS FOR. Outcomes 5 and 11 claim that a ten-minute packaged
 * session holds A/V sync over variable-frame-rate media, that audio behaves,
 * and that nothing leaks. Every one of those is a claim a hopeful instrument
 * could fake, so the judgements live here as pure functions with executable
 * controls rather than inline in a launcher where nothing can reach them.
 *
 * WHY THIS FILE IS PARANOID. Its first version passed 29 controls and still
 * accepted four separate forged-evidence shapes, the worst being a receipt with
 * a twenty-second gap between the two clocks and a hand-written `err=0`. It was
 * advertised as classifying "from the operands" while actually trusting the
 * summary field. Every rule below therefore recomputes what it can and refuses
 * what it cannot: absent, unknown and unsupported are Red, never Green.
 *
 * THE ONE THING THIS FILE REFUSES TO DO. It never reports physical acoustic
 * audibility as proven. ScreenCaptureKit window audio proves the Studio window
 * EMITTED samples; CoreAudio route health proves the sink is CONFIGURED.
 * Neither proves a speaker moved air, and no post-mix/sink-energy or external
 * metering seam exists in this repository.
 */

/** The sample plan is a contract, not a tuning knob. */
const SAMPLE_COUNT = 21
const NOMINAL_CADENCE_SECONDS = 30
const MIN_ELAPSED_SECONDS = 600

/**
 * ITU-R BT.1359 detectability thresholds, ASYMMETRIC and widely mis-implemented
 * as a symmetric window. Mirrored exactly from the authoritative product source
 * (StudioAvSyncMeter.audioDelayedToleranceMilliseconds / audioAdvanced...).
 */
const AUDIO_DELAYED_TOLERANCE_MS = 125
const AUDIO_ADVANCED_TOLERANCE_MS = 45

/**
 * Inherited from the accepted allocation-class contract at
 * StudioStressTests.swift:197 (growthBudgetMB: 24), whose
 * `trend.isStable(withinGrowthBytes:)` takes an ABSOLUTE budget. Inherited
 * UNSCALED on purpose: a leak grows with work, so scaling the budget with run
 * length would conceal exactly what a ten-minute run exists to expose.
 */
const FOOTPRINT_GROWTH_BUDGET_MB = 24
const MAX_RESIDENT_DECODER_GROWTH = 1

/** IOSurface IDs are UInt32 in the product's own probe. */
const MAX_IO_SURFACE_ID = 0xffffffff

/** The export prints milliseconds with `%.3f`, so agreement is at 3 decimals. */
const MILLISECOND_PRECISION = 0.001

const AV1_FIELDS = ['pf', 'ap', 'err', 'errms', 'win', 'winms', 'drawn', 'expl']
const AV1_EXPLANATIONS = new Set(['explained', 'not_explained', 'unknown'])

const isSafeInteger = (value) => Number.isSafeInteger(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

function planSamples({ startedAtMs = 0 } = {}) {
  const plan = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const plannedElapsedMs = index * NOMINAL_CADENCE_SECONDS * 1000
    plan.push({ index, plannedElapsedMs, plannedAtMs: startedAtMs + plannedElapsedMs })
  }
  return plan
}

/**
 * A run can have every sample, in order, and still not be a ten-minute run.
 * Count and duration are therefore checked independently, and a sample with no
 * timestamps at all is Red rather than skipped — silently tolerating a missing
 * field is how an incomplete run reads as complete.
 */
function validateSampleSequence(samples) {
  const failures = []
  const list = Array.isArray(samples) ? samples : []
  const plan = planSamples({ startedAtMs: 0 })

  if (list.length !== SAMPLE_COUNT) {
    failures.push(`sample count ${list.length}, expected ${SAMPLE_COUNT}`)
  }

  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const sample = list[i]
    if (!sample || typeof sample !== 'object') {
      failures.push(`sample at position ${i} is missing`)
      continue
    }
    if (!isSafeInteger(sample.index)) {
      failures.push(`sample at position ${i} has a non-integer index`)
    } else {
      if (seen.has(sample.index)) failures.push(`duplicate sample index ${sample.index}`)
      seen.add(sample.index)
      if (sample.index !== i) {
        failures.push(`sample order broken at position ${i}: index ${sample.index}`)
      }
    }

    const expected = plan[i]
    if (expected && sample.plannedElapsedMs !== expected.plannedElapsedMs) {
      failures.push(
        `sample ${i} departs from the declared plan: planned ` +
          `${sample.plannedElapsedMs}, contract ${expected.plannedElapsedMs}`
      )
    }

    // Absent timestamps are the shape that let an incomplete run pass. Both
    // clocks are required on EVERY sample, finite and non-negative.
    for (const field of ['actualElapsedMs', 'monotonicMs']) {
      const value = sample[field]
      if (!isFiniteNumber(value)) {
        failures.push(`sample ${i} has no finite ${field}`)
      } else if (value < 0) {
        failures.push(`sample ${i} has a negative ${field}`)
      }
    }

    if (i > 0) {
      const previous = list[i - 1]
      if (
        previous &&
        isFiniteNumber(previous.monotonicMs) &&
        isFiniteNumber(sample.monotonicMs) &&
        sample.monotonicMs <= previous.monotonicMs
      ) {
        failures.push(
          `monotonic clock did not advance at ${i}: ` +
            `${sample.monotonicMs} <= ${previous.monotonicMs}`
        )
      }
    }
  }

  const first = list[0]
  const last = list[list.length - 1]
  if (
    first &&
    last &&
    isFiniteNumber(first.actualElapsedMs) &&
    isFiniteNumber(last.actualElapsedMs)
  ) {
    const spanSeconds = (last.actualElapsedMs - first.actualElapsedMs) / 1000
    if (spanSeconds < MIN_ELAPSED_SECONDS) {
      failures.push(
        `under-duration: run spanned ${spanSeconds.toFixed(1)}s, ` +
          `endurance requires >= ${MIN_ELAPSED_SECONDS}s`
      )
    }
  } else {
    failures.push('under-duration: no measurable elapsed span')
  }

  return { ok: failures.length === 0, failures }
}

/**
 * Fail-closed parse of the product's own `av1` diagnostics export.
 *
 * RECOMPUTES RATHER THAN TRUSTS. `errorTicks` is defined by the product as
 * `presentedFrameTicks - audiblePositionTicks` (StudioAvSyncMeter.swift:193),
 * so a receipt whose `err` disagrees with its own operands is forged or
 * corrupt, not merely surprising. The first version of this parser read all
 * three and then believed `err`, which accepted a twenty-second clock gap
 * carrying a hand-written zero.
 *
 * An absent measurement window stays NULL. Zero would parse as "both clocks
 * were read together" — the strongest possible claim and the exact opposite of
 * what absence means.
 */
function parseAvSyncExport(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty receipt' }
  }
  const parts = text.trim().split(/\s+/)
  if (parts[0] !== 'av1') {
    return { ok: false, reason: `unknown schema ${parts[0] || '(none)'}` }
  }

  const fields = new Map()
  for (const part of parts.slice(1)) {
    const separator = part.indexOf('=')
    if (separator <= 0) return { ok: false, reason: `malformed field ${part}` }
    const key = part.slice(0, separator)
    if (fields.has(key)) return { ok: false, reason: `duplicate field ${key}` }
    fields.set(key, part.slice(separator + 1))
  }
  for (const key of AV1_FIELDS) {
    if (!fields.has(key)) return { ok: false, reason: `missing operand ${key}` }
  }
  for (const key of fields.keys()) {
    if (!AV1_FIELDS.includes(key)) return { ok: false, reason: `unknown field ${key}` }
  }

  const exactInteger = (key) => {
    const raw = fields.get(key)
    if (!/^-?\d+$/.test(raw)) return null
    const value = Number(raw)
    if (!isSafeInteger(value)) return null
    return value
  }
  const exactDecimal = (key) => {
    const raw = fields.get(key)
    if (!/^-?\d+\.\d{3}$/.test(raw)) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  const presentedFrameTicks = exactInteger('pf')
  const audioPositionTicks = exactInteger('ap')
  const errorTicks = exactInteger('err')
  if (presentedFrameTicks === null || audioPositionTicks === null || errorTicks === null) {
    return { ok: false, reason: 'non-integer or unsafe operand' }
  }

  // THE INTEGRITY CHECK THIS PARSER WAS MISSING.
  if (errorTicks !== presentedFrameTicks - audioPositionTicks) {
    return {
      ok: false,
      reason:
        `err ${errorTicks} disagrees with its own operands ` +
        `(pf ${presentedFrameTicks} - ap ${audioPositionTicks} = ` +
        `${presentedFrameTicks - audioPositionTicks}); the receipt is forged or corrupt`
    }
  }

  const errorMilliseconds = exactDecimal('errms')
  if (errorMilliseconds === null) {
    return { ok: false, reason: 'errms is not a finite three-decimal value' }
  }

  const rawWindow = fields.get('win')
  const rawWindowMs = fields.get('winms')
  let measurementWindowNanoseconds = null
  let measurementWindowMilliseconds = null
  if (rawWindow === '-' || rawWindowMs === '-') {
    // Absence is all-or-nothing: a half-present window is a malformed receipt.
    if (rawWindow !== '-' || rawWindowMs !== '-') {
      return { ok: false, reason: 'measurement window is only half absent' }
    }
  } else {
    measurementWindowNanoseconds = exactInteger('win')
    if (measurementWindowNanoseconds === null || measurementWindowNanoseconds < 0) {
      // The product's own type is UInt64; a negative window cannot exist.
      return { ok: false, reason: 'measurement window is not a non-negative integer' }
    }
    measurementWindowMilliseconds = exactDecimal('winms')
    if (measurementWindowMilliseconds === null) {
      return { ok: false, reason: 'winms is not a finite three-decimal value' }
    }
    const derived = measurementWindowNanoseconds / 1_000_000
    if (Math.abs(derived - measurementWindowMilliseconds) > MILLISECOND_PRECISION) {
      return {
        ok: false,
        reason:
          `winms ${measurementWindowMilliseconds} disagrees with win ` +
          `${measurementWindowNanoseconds}ns (${derived.toFixed(3)}ms)`
      }
    }
  }

  const drawnRaw = fields.get('drawn')
  if (drawnRaw !== '0' && drawnRaw !== '1') {
    return { ok: false, reason: `malformed drawn flag ${drawnRaw}` }
  }
  const explanation = fields.get('expl')
  if (!AV1_EXPLANATIONS.has(explanation)) {
    return { ok: false, reason: `unknown explanation ${explanation}` }
  }

  return {
    ok: true,
    presentedFrameTicks,
    audioPositionTicks,
    errorTicks,
    errorMilliseconds,
    measurementWindowNanoseconds,
    measurementWindowMilliseconds,
    wasDrawn: drawnRaw === '1',
    explanation
  }
}

/**
 * Classifies one sample from the OPERANDS — and now actually does, rather than
 * claiming to. Everything derivable is recomputed against the exact timebase
 * and compared; a receipt that disagrees with itself is refused before any
 * tolerance question is asked.
 */
function classifyAvSample({ parsed, timebase }) {
  const red = (reason) => ({ status: 'red', withinTolerance: false, reason })

  if (!parsed || parsed.ok !== true) {
    return red(`unreadable receipt: ${(parsed && parsed.reason) || 'absent'}`)
  }
  if (
    !timebase ||
    !isSafeInteger(timebase.timescale) ||
    timebase.timescale <= 0 ||
    !isSafeInteger(timebase.frameDurationTicks) ||
    timebase.frameDurationTicks <= 0
  ) {
    return red('no exact timebase (timescale and frameDurationTicks are both required)')
  }

  const errorMs = (parsed.errorTicks / timebase.timescale) * 1000
  if (Math.abs(errorMs - parsed.errorMilliseconds) > MILLISECOND_PRECISION) {
    return red(
      `errms ${parsed.errorMilliseconds} disagrees with err ${parsed.errorTicks} ticks ` +
        `at timescale ${timebase.timescale} (${errorMs.toFixed(3)}ms)`
    )
  }

  // Rederive the explanation exactly as the product does
  // (StudioAvSyncMeter.errorIsExplainedByMeasurementWindow): only a NEGATIVE
  // error can be explained by the window, because the audio playhead is read
  // last. A receipt claiming otherwise is not describing this product.
  let expectedExplanation
  if (parsed.measurementWindowNanoseconds === null) {
    expectedExplanation = 'unknown'
  } else {
    const quantisationMs = (timebase.frameDurationTicks / timebase.timescale) * 1000
    const explained =
      errorMs < 0 && -errorMs <= parsed.measurementWindowMilliseconds + quantisationMs
    expectedExplanation = explained ? 'explained' : 'not_explained'
  }
  if (parsed.explanation !== expectedExplanation) {
    return red(
      `explanation "${parsed.explanation}" is not what these operands produce ` +
        `("${expectedExplanation}"); the receipt is inconsistent or cross-read`
    )
  }

  if (!parsed.wasDrawn) {
    return red('frame not drawn — the sample is evidence about nothing')
  }
  if (parsed.measurementWindowNanoseconds === null) {
    return red(
      'absent measurement window — the two operands may be a cross-read rather ' +
        'than a simultaneous one'
    )
  }

  const withinTolerance =
    errorMs >= 0 ? errorMs <= AUDIO_DELAYED_TOLERANCE_MS : -errorMs <= AUDIO_ADVANCED_TOLERANCE_MS

  return {
    status: withinTolerance ? 'green' : 'red',
    withinTolerance,
    errorMilliseconds: errorMs,
    direction: errorMs >= 0 ? 'audio-delayed' : 'audio-advanced',
    explanation: parsed.explanation,
    reason: withinTolerance
      ? 'current error within the asymmetric BT.1359 bound'
      : `current error ${errorMs.toFixed(3)}ms exceeds the ` +
        `${errorMs >= 0 ? AUDIO_DELAYED_TOLERANCE_MS : AUDIO_ADVANCED_TOLERANCE_MS}ms bound`
  }
}

const SILENCE_RMS_CEILING = 0.005
const SILENCE_PEAK_CEILING = 0.02
const SILENCE_FRACTION_CEILING = 0.01
const POSITIVE_RMS_FLOOR = 0.02
const POSITIVE_NON_SILENT_FRACTION_FLOOR = 0.5

function audioReceiptIsComplete(receipt) {
  if (!receipt || typeof receipt !== 'object') return false
  for (const field of ['rms', 'peak', 'nonSilentFraction']) {
    const value = receipt[field]
    if (!isFiniteNumber(value) || value < 0 || value > 1) return false
  }
  return true
}

/**
 * Separates three DIFFERENT claims that are easy to collapse into one:
 *   windowEmission     — the Studio window produced samples
 *   routeState         — the selected output device is configured and usable
 *   physicalAudibility — sound actually reached a listener
 *
 * Only the first two are measurable here. The third is BLOCKED, permanently,
 * until a post-mix/sink-energy or external metering seam exists.
 */
function classifyAudioEvidence({ windowAudio, silenceWindow, routeHealth, priorRouteHealth }) {
  const failures = []

  let windowEmission
  if (!audioReceiptIsComplete(windowAudio)) {
    windowEmission = 'unknown'
    failures.push('positive window receipt is incomplete or out of range')
  } else if (
    windowAudio.rms >= POSITIVE_RMS_FLOOR &&
    windowAudio.nonSilentFraction >= POSITIVE_NON_SILENT_FRACTION_FLOOR
  ) {
    windowEmission = 'proven'
  } else {
    windowEmission = 'absent'
    failures.push('positive window carried no measurable signal')
  }

  // Without this, a stuck meter reporting signal forever would pass the
  // positive test and prove nothing at all. RMS alone is not enough: a mostly
  // silent window with one loud transient averages low, so peak and
  // non-silent fraction are checked too.
  let intentionalSilence
  if (!audioReceiptIsComplete(silenceWindow)) {
    intentionalSilence = 'unknown'
    failures.push('intentional-silence receipt is incomplete or out of range')
  } else if (
    silenceWindow.rms <= SILENCE_RMS_CEILING &&
    silenceWindow.peak <= SILENCE_PEAK_CEILING &&
    silenceWindow.nonSilentFraction <= SILENCE_FRACTION_CEILING
  ) {
    intentionalSilence = 'proven'
  } else {
    intentionalSilence = 'violated'
    failures.push('intentional-silence window was not silent')
  }

  let routeState
  if (!routeHealth || typeof routeHealth !== 'object') {
    routeState = 'unknown'
  } else if (
    !isNonEmptyString(routeHealth.deviceId) ||
    !isNonEmptyString(routeHealth.deviceUid) ||
    !isFiniteNumber(routeHealth.sampleRate) ||
    routeHealth.sampleRate <= 0 ||
    routeHealth.alive !== true ||
    routeHealth.running !== true ||
    routeHealth.hasOutputStream !== true ||
    !isSafeInteger(routeHealth.outputChannelCount) ||
    routeHealth.outputChannelCount <= 0
  ) {
    routeState = 'unknown'
  } else if (routeHealth.muted === true) {
    routeState = 'muted'
    failures.push('output route is muted')
  } else if (routeHealth.muted !== false) {
    // Unsupported is NOT the same as fine. An unreadable field is UNKNOWN.
    routeState = 'unknown'
  } else if (routeHealth.volume !== undefined && routeHealth.volume !== null) {
    // Where volume IS supported, zero is silence by another name.
    routeState =
      isFiniteNumber(routeHealth.volume) && routeHealth.volume > 0 ? 'candidate' : 'unknown'
    if (routeState === 'unknown') failures.push('output route volume is zero or unreadable')
  } else {
    routeState = 'candidate'
  }

  if (routeState === 'candidate') {
    // Stability is a claim about TWO readings. Without a prior identity there
    // is nothing to compare, so it cannot be asserted.
    if (!priorRouteHealth || typeof priorRouteHealth !== 'object') {
      routeState = 'unknown'
      failures.push('no prior route reading, so route stability cannot be claimed')
    } else if (
      priorRouteHealth.deviceUid !== routeHealth.deviceUid ||
      priorRouteHealth.deviceId !== routeHealth.deviceId ||
      priorRouteHealth.sampleRate !== routeHealth.sampleRate
    ) {
      routeState = 'changed'
      failures.push('output device identity or sample rate changed mid-run')
    } else {
      routeState = 'healthy'
    }
  }
  if (routeState === 'unknown') {
    failures.push('output route health could not be established')
  }

  return {
    // Fixed, not computed. There is no input to this function that could make
    // it anything else, and that is deliberate.
    physicalAudibility: 'blocked',
    missingProof:
      'no post-mix/sink-energy tap or external metering seam exists; window ' +
      'audio proves Studio-attributable emission and route health proves ' +
      'routing state, neither proves acoustic output. Requires owner/hardware ' +
      'confirmation or a new sink-layer instrument.',
    windowEmission,
    intentionalSilence,
    routeState,
    failures,
    status: failures.length > 0 ? 'red' : 'blocked'
  }
}

function ioSurfaceSet(ids) {
  if (!Array.isArray(ids)) return null
  const set = new Set()
  for (const id of ids) {
    if (!isSafeInteger(id) || id < 0 || id > MAX_IO_SURFACE_ID) return null
    set.add(id)
  }
  return set
}

const isStrictSuperset = (later, earlier) => {
  if (later.size <= earlier.size) return false
  for (const id of earlier) if (!later.has(id)) return false
  return true
}

/**
 * Aligned allocation-class trend, mirroring StudioMemoryTrend rather than
 * approximating it with two endpoints.
 *
 * Endpoints alone cannot see the shape that matters: a footprint that grows on
 * EVERY sample is a leak even when the total lands inside budget, and a live
 * IOSurface set that strictly accumulates three times running is the surface
 * leak the Swift contract already refuses. Identity is compared, not just
 * count, because a stable count can hide a full turnover.
 */
function classifyResourceGrowth({ readings, droppedFrames, ioSurfaceCapacity }) {
  const failures = []
  const list = Array.isArray(readings) ? readings : []
  if (list.length < 2) {
    return { status: 'red', failures: ['fewer than two aligned resource readings'] }
  }

  const surfaceSets = []
  for (let i = 0; i < list.length; i += 1) {
    const reading = list[i]
    if (!reading || typeof reading !== 'object') {
      failures.push(`resource reading ${i} is missing`)
      continue
    }
    for (const field of ['footprintBytes', 'mallocBytes', 'residentDecoderCount']) {
      const value = reading[field]
      if (!isFiniteNumber(value) || !isSafeInteger(value) || value < 0) {
        failures.push(`resource reading ${i} has no finite non-negative ${field}`)
      }
    }
    const set = ioSurfaceSet(reading.liveIoSurfaceIds)
    if (set === null) {
      failures.push(`resource reading ${i} has no valid live IOSurface identity set`)
    } else {
      surfaceSets.push(set)
      if (isSafeInteger(ioSurfaceCapacity) && set.size > ioSurfaceCapacity) {
        failures.push(
          `resource reading ${i} holds ${set.size} live IOSurfaces, ` +
            `over the renderer capacity of ${ioSurfaceCapacity}`
        )
      }
    }
  }
  if (failures.length > 0) return { status: 'red', failures }
  if (surfaceSets.length !== list.length) {
    return { status: 'red', failures: ['IOSurface evidence is not aligned with the readings'] }
  }
  if (!isSafeInteger(ioSurfaceCapacity) || ioSurfaceCapacity <= 0) {
    return { status: 'red', failures: ['no declared renderer IOSurface capacity to compare'] }
  }

  const first = list[0]
  const last = list[list.length - 1]
  const budgetBytes = FOOTPRINT_GROWTH_BUDGET_MB * 1_048_576

  const footprintGrowth = last.footprintBytes - first.footprintBytes
  if (footprintGrowth > budgetBytes) {
    failures.push(
      `footprint grew ${(footprintGrowth / 1_048_576).toFixed(1)}MB, ` +
        `exceeding the accepted ${FOOTPRINT_GROWTH_BUDGET_MB}MB allocation-class budget`
    )
  }
  const mallocGrowth = last.mallocBytes - first.mallocBytes
  if (mallocGrowth > budgetBytes) {
    failures.push(
      `malloc grew ${(mallocGrowth / 1_048_576).toFixed(1)}MB, ` +
        `exceeding the accepted ${FOOTPRINT_GROWTH_BUDGET_MB}MB allocation-class budget`
    )
  }

  let grewEveryStep = true
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].footprintBytes <= list[i - 1].footprintBytes) grewEveryStep = false
  }
  if (grewEveryStep) {
    failures.push('footprint grew on every sample — a leak shape regardless of the total')
  }

  let accumulatingRun = 0
  for (let i = 1; i < surfaceSets.length; i += 1) {
    if (isStrictSuperset(surfaceSets[i], surfaceSets[i - 1])) {
      accumulatingRun += 1
      if (accumulatingRun >= 3) {
        failures.push('live IOSurface identities strictly accumulated three samples running')
        break
      }
    } else {
      accumulatingRun = 0
    }
  }

  if (last.residentDecoderCount - first.residentDecoderCount > MAX_RESIDENT_DECODER_GROWTH) {
    failures.push(
      `resident decoder count grew ${first.residentDecoderCount} -> ` +
        `${last.residentDecoderCount}; the shared-decoder contract allows at most ` +
        `+${MAX_RESIDENT_DECODER_GROWTH}`
    )
  }

  if (!isSafeInteger(droppedFrames)) {
    failures.push('droppedFrames is missing or not an exact integer')
  } else if (droppedFrames !== 0) {
    failures.push(`${droppedFrames} dropped frames`)
  }

  return {
    status: failures.length > 0 ? 'red' : 'green',
    failures,
    footprintGrowthMb: footprintGrowth / 1_048_576,
    mallocGrowthMb: mallocGrowth / 1_048_576
  }
}

/**
 * Terminal verdict.
 *
 * `blocked` and `red` are kept DISTINCT on purpose. Blocked means the evidence
 * we can gather is sound but insufficient; red means something measurably
 * failed OR is missing. Absent evidence is never softened into blocked —
 * laundering a hole into the gentler word is how an arc talks itself into
 * shipping.
 */
function summarizeOutcome5({ sequence, avSamples, audio, resources }) {
  const failures = []
  const blockers = []

  if (!sequence || sequence.ok !== true) {
    failures.push(...((sequence && sequence.failures) || ['sequence not validated']))
  }

  const samples = Array.isArray(avSamples) ? avSamples : null
  if (samples === null) {
    failures.push('no A/V sample verdicts')
  } else if (samples.length !== SAMPLE_COUNT) {
    failures.push(`${samples.length} A/V sample verdicts, expected exactly ${SAMPLE_COUNT}`)
  } else {
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]
      if (!sample || (sample.status !== 'green' && sample.status !== 'red')) {
        failures.push(`A/V sample ${i} has no recognised verdict`)
      } else if (sample.status === 'red') {
        failures.push(`A/V sample ${i} out of tolerance: ${sample.reason || 'unstated'}`)
      }
    }
  }

  if (!audio || typeof audio !== 'object' || typeof audio.physicalAudibility !== 'string') {
    failures.push('no audio evidence')
  } else if (audio.status === 'red') {
    failures.push(...(audio.failures || ['audio evidence failed']))
  } else if (audio.status !== 'blocked') {
    failures.push(`unrecognised audio verdict ${audio.status}`)
  }

  if (!resources || typeof resources !== 'object') {
    failures.push('no resource evidence')
  } else if (resources.status === 'red') {
    failures.push(...(resources.failures || ['resource growth failed']))
  } else if (resources.status !== 'green') {
    failures.push(`unrecognised resource verdict ${resources.status}`)
  }

  if (!audio || audio.physicalAudibility !== 'proven') {
    blockers.push(
      'physical audibility is not proven: ' + ((audio && audio.missingProof) || 'no audio evidence')
    )
  }

  if (failures.length > 0) return { status: 'red', failures, blockers }
  if (blockers.length > 0) return { status: 'blocked', failures, blockers }
  return { status: 'green', failures, blockers }
}

module.exports = {
  AUDIO_ADVANCED_TOLERANCE_MS,
  AUDIO_DELAYED_TOLERANCE_MS,
  FOOTPRINT_GROWTH_BUDGET_MB,
  MAX_IO_SURFACE_ID,
  MAX_RESIDENT_DECODER_GROWTH,
  MIN_ELAPSED_SECONDS,
  NOMINAL_CADENCE_SECONDS,
  SAMPLE_COUNT,
  classifyAudioEvidence,
  classifyAvSample,
  classifyResourceGrowth,
  parseAvSyncExport,
  planSamples,
  summarizeOutcome5,
  validateSampleSequence
}
