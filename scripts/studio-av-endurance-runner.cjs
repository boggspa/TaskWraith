#!/usr/bin/env node
'use strict'

/**
 * Outcome 5/11 evidence instrument — decision core.
 *
 * WHAT THIS FILE IS FOR. Outcomes 5 and 11 claim that a ten-minute packaged
 * session stays in A/V sync over variable-frame-rate media, that audio behaves,
 * and that nothing leaks. Every one of those is a claim a hopeful instrument
 * could fake, so the judgements live here as pure functions with executable
 * controls rather than inline in a launcher where nothing can reach them.
 *
 * THE ONE THING THIS FILE REFUSES TO DO. It never reports physical acoustic
 * audibility as proven. ScreenCaptureKit window audio proves the Studio window
 * EMITTED samples; CoreAudio route health proves the sink is CONFIGURED.
 * Neither proves a speaker moved air, and no post-mix/sink-energy or external
 * metering seam exists in this repository. Challenge1 flagged precisely this as
 * the false green to avoid, so `physicalAudibility` is a fixed `blocked` with
 * the exact missing proof named, and the terminal verdict cannot be green while
 * it stands. An instrument that read the audio engine it had just configured
 * would prove we ASKED for sound, not that sound arrived.
 */

/** The sample plan is a contract, not a tuning knob. */
const SAMPLE_COUNT = 21
const NOMINAL_CADENCE_SECONDS = 30
const MIN_ELAPSED_SECONDS = 600

/**
 * ITU-R BT.1359 detectability thresholds, ASYMMETRIC and widely mis-implemented
 * as a symmetric window. Mirrored exactly from the authoritative product source
 * (StudioAvSyncMeter.audioDelayedToleranceMilliseconds / audioAdvanced...), so
 * a drift there is a visible disagreement here rather than a silent one.
 */
const AUDIO_DELAYED_TOLERANCE_MS = 125
const AUDIO_ADVANCED_TOLERANCE_MS = 45

/**
 * Inherited from the accepted allocation-class contract at
 * StudioStressTests.swift:197 (growthBudgetMB: 24). That contract's
 * `trend.isStable(withinGrowthBytes:)` takes an ABSOLUTE budget, not a
 * per-cycle one, and it is inherited unscaled on purpose: a leak grows with
 * work, so scaling the budget with run length would conceal exactly what a
 * ten-minute run exists to expose. If a packaged run legitimately needs more,
 * that is a finding to escalate with evidence — not a number to raise here.
 */
const FOOTPRINT_GROWTH_BUDGET_MB = 24

/**
 * The shared-decoder contract asserted throughout StudioPumpAdoptionTests is
 * one resident decoder per distinct asset. One extra tolerates a transient
 * lease during a route change; anything beyond that is the accumulation shape
 * this arc has already had to fix once.
 */
const MAX_RESIDENT_DECODER_GROWTH = 1

const AV1_FIELDS = ['pf', 'ap', 'err', 'errms', 'win', 'winms', 'drawn', 'expl']
const AV1_EXPLANATIONS = new Set(['explained', 'not_explained', 'unknown'])

/** Bounded plan: first sample at zero, then a fixed cadence to the ceiling. */
function planSamples({ startedAtMs = 0 } = {}) {
  const plan = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const plannedElapsedMs = index * NOMINAL_CADENCE_SECONDS * 1000
    plan.push({
      index,
      plannedElapsedMs,
      plannedAtMs: startedAtMs + plannedElapsedMs
    })
  }
  return plan
}

/**
 * The endurance claim lives here. A run can have every sample, in order, and
 * still not be a ten-minute run — that is the shape a "fast" run would take and
 * the reason duration is checked separately from count.
 */
function validateSampleSequence(samples) {
  const failures = []
  const list = Array.isArray(samples) ? samples : []

  if (list.length !== SAMPLE_COUNT) {
    failures.push(`sample count ${list.length}, expected ${SAMPLE_COUNT}`)
  }

  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const sample = list[i]
    if (!sample || typeof sample.index !== 'number') {
      failures.push(`sample at position ${i} has no index`)
      continue
    }
    if (seen.has(sample.index)) {
      failures.push(`duplicate sample index ${sample.index}`)
    }
    seen.add(sample.index)
    if (sample.index !== i) {
      failures.push(`sample order broken at position ${i}: index ${sample.index}`)
    }
    if (i > 0) {
      const previous = list[i - 1]
      if (
        previous &&
        typeof previous.monotonicMs === 'number' &&
        typeof sample.monotonicMs === 'number' &&
        sample.monotonicMs < previous.monotonicMs
      ) {
        failures.push(
          `monotonic clock went backwards at ${i}: ` +
            `${sample.monotonicMs} < ${previous.monotonicMs}`
        )
      }
    }
  }

  const first = list[0]
  const last = list[list.length - 1]
  if (first && last && typeof first.actualElapsedMs === 'number') {
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
 * An absent measurement window serialises as `-` and MUST stay null. Zero would
 * parse as "both clocks were read together" — the strongest possible claim and
 * the exact opposite of what absence means.
 */
function parseAvSyncExport(text) {
  if (typeof text !== 'string' || text.length === 0) {
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
    fields.set(part.slice(0, separator), part.slice(separator + 1))
  }
  for (const key of AV1_FIELDS) {
    if (!fields.has(key)) return { ok: false, reason: `missing operand ${key}` }
  }

  const integer = (key) => {
    const raw = fields.get(key)
    if (!/^-?\d+$/.test(raw)) return null
    return Number.parseInt(raw, 10)
  }
  const optionalInteger = (key) => {
    const raw = fields.get(key)
    if (raw === '-') return null
    if (!/^-?\d+$/.test(raw)) return undefined
    return Number.parseInt(raw, 10)
  }

  const presentedFrameTicks = integer('pf')
  const audioPositionTicks = integer('ap')
  const errorTicks = integer('err')
  if (presentedFrameTicks === null || audioPositionTicks === null || errorTicks === null) {
    return { ok: false, reason: 'non-integer operand' }
  }
  const measurementWindowNanoseconds = optionalInteger('win')
  if (measurementWindowNanoseconds === undefined) {
    return { ok: false, reason: 'malformed measurement window' }
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
    errorMilliseconds: Number.parseFloat(fields.get('errms')),
    measurementWindowNanoseconds,
    wasDrawn: drawnRaw === '1',
    explanation
  }
}

/**
 * Classifies one sample from the OPERANDS, never from a headline number.
 *
 * The distinction matters: a peak magnitude can be explained away by a wide
 * measurement window, but the CURRENT error cannot. Explanation covers the
 * outlier; it never excuses a live out-of-bound reading.
 */
function classifyAvSample({ parsed, timescale }) {
  if (!parsed || parsed.ok !== true) {
    return {
      status: 'red',
      withinTolerance: false,
      reason: `unreadable receipt: ${parsed && parsed.reason}`
    }
  }
  if (!Number.isFinite(timescale) || timescale <= 0) {
    return { status: 'red', withinTolerance: false, reason: 'no exact timebase' }
  }
  if (!parsed.wasDrawn) {
    return {
      status: 'red',
      withinTolerance: false,
      reason: 'frame not drawn — the sample is evidence about nothing'
    }
  }
  if (parsed.measurementWindowNanoseconds === null) {
    return {
      status: 'red',
      withinTolerance: false,
      reason:
        'absent measurement window — the two operands may be a cross-read ' +
        'rather than a simultaneous one'
    }
  }

  const errorMs = (parsed.errorTicks / timescale) * 1000
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
const POSITIVE_RMS_FLOOR = 0.02
const POSITIVE_NON_SILENT_FRACTION_FLOOR = 0.5

/**
 * Separates three DIFFERENT claims that are easy to collapse into one:
 *   windowEmission  — the Studio window produced samples
 *   routeState      — the selected output device is configured and usable
 *   physicalAudibility — sound actually reached a listener
 *
 * Only the first two are measurable here. The third is BLOCKED, permanently,
 * until a post-mix/sink-energy or external metering seam exists.
 */
function classifyAudioEvidence({ windowAudio, silenceWindow, routeHealth, priorRouteHealth }) {
  const failures = []

  const windowEmission =
    windowAudio &&
    windowAudio.rms >= POSITIVE_RMS_FLOOR &&
    windowAudio.nonSilentFraction >= POSITIVE_NON_SILENT_FRACTION_FLOOR
      ? 'proven'
      : 'absent'
  if (windowEmission !== 'proven') {
    failures.push('positive window carried no measurable signal')
  }

  // Without this, a stuck meter reporting signal forever would pass the
  // positive test and prove nothing at all.
  const intentionalSilence =
    silenceWindow && silenceWindow.rms <= SILENCE_RMS_CEILING ? 'proven' : 'violated'
  if (intentionalSilence !== 'proven') {
    failures.push('intentional-silence window was not silent')
  }

  let routeState
  if (!routeHealth) {
    routeState = 'unknown'
  } else if (
    priorRouteHealth &&
    (priorRouteHealth.deviceUid !== routeHealth.deviceUid ||
      priorRouteHealth.deviceId !== routeHealth.deviceId)
  ) {
    routeState = 'changed'
    failures.push('output device identity changed mid-run')
  } else if (routeHealth.muted === true) {
    routeState = 'muted'
    failures.push('output route is muted')
  } else if (
    routeHealth.muted === null ||
    routeHealth.muted === undefined ||
    routeHealth.alive !== true ||
    routeHealth.running !== true ||
    routeHealth.hasOutputStream !== true ||
    !(routeHealth.outputChannelCount > 0)
  ) {
    // Unsupported is NOT the same as fine. An unreadable field is UNKNOWN.
    routeState = 'unknown'
  } else {
    routeState = 'healthy'
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

function classifyResourceGrowth({ first, last, droppedFrames }) {
  const failures = []
  if (!first || !last) {
    return { status: 'red', failures: ['missing resource samples'] }
  }

  const growthMb = (last.footprintBytes - first.footprintBytes) / 1_048_576
  if (growthMb > FOOTPRINT_GROWTH_BUDGET_MB) {
    failures.push(
      `footprint grew ${growthMb.toFixed(1)}MB over the run, ` +
        `exceeding the accepted ${FOOTPRINT_GROWTH_BUDGET_MB}MB allocation-class budget`
    )
  }
  if (last.residentDecoderCount - first.residentDecoderCount > MAX_RESIDENT_DECODER_GROWTH) {
    failures.push(
      `resident decoder count grew ${first.residentDecoderCount} -> ` +
        `${last.residentDecoderCount}; the shared-decoder contract allows at most ` +
        `+${MAX_RESIDENT_DECODER_GROWTH}`
    )
  }
  if (Number.isFinite(droppedFrames) && droppedFrames > 0) {
    failures.push(`${droppedFrames} dropped frames`)
  }

  return { status: failures.length > 0 ? 'red' : 'green', failures, footprintGrowthMb: growthMb }
}

/**
 * Terminal verdict.
 *
 * `blocked` and `red` are kept DISTINCT on purpose. Blocked means the evidence
 * we can gather is sound but insufficient; red means something measurably
 * failed. Laundering a failure into the softer word is how an arc talks itself
 * into shipping.
 */
function summarizeOutcome5({ sequence, avSamples, audio, resources }) {
  const failures = []
  const blockers = []

  if (!sequence || sequence.ok !== true) {
    failures.push(...((sequence && sequence.failures) || ['sequence not validated']))
  }
  const redSamples = (avSamples || []).filter((sample) => sample && sample.status === 'red')
  if (redSamples.length > 0) {
    failures.push(`${redSamples.length} A/V sample(s) out of tolerance`)
  }
  if (audio && audio.status === 'red') {
    failures.push(...(audio.failures || ['audio evidence failed']))
  }
  if (resources && resources.status === 'red') {
    failures.push(...(resources.failures || ['resource growth failed']))
  }

  if (!audio || audio.physicalAudibility !== 'proven') {
    blockers.push(
      'physical audibility is not proven: ' + ((audio && audio.missingProof) || 'no audio evidence')
    )
  }

  if (failures.length > 0) {
    return { status: 'red', failures, blockers }
  }
  if (blockers.length > 0) {
    return { status: 'blocked', failures, blockers }
  }
  return { status: 'green', failures, blockers }
}

module.exports = {
  AUDIO_ADVANCED_TOLERANCE_MS,
  AUDIO_DELAYED_TOLERANCE_MS,
  FOOTPRINT_GROWTH_BUDGET_MB,
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
