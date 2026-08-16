#!/usr/bin/env node
'use strict'

/**
 * Outcome 5/11 evidence instrument — decision core.
 *
 * WHY THIS FILE IS PARANOID. Its first version passed 29 controls and accepted
 * a receipt with a twenty-second gap between the two clocks and a hand-written
 * `err=0`. Its second passed 57 and still let a caller hand-build a "parsed"
 * object to skip the parser entirely. Both were advertised as stricter than
 * they were. Every rule below therefore recomputes what it can, refuses what it
 * cannot, and treats absent/unknown/unsupported as Red.
 *
 * THE SEMANTIC CORRECTION THAT MATTERS MOST. The `av1` line published at
 * StudioViewerWindow.swift:849 is `syncMeter.peakSample.diagnosticsExportText`
 * — the RETAINED WORST SAMPLE since the last seek, not the live reading. The
 * current error lives separately in `StudioAvSyncMeter.currentErrorTicks` and
 * only reaches a surface through `summaryText`. Treating the peak as "current"
 * both misclassifies a legitimately explained outlier (the measured -1088.5ms
 * peak) as a live failure AND fails to prove live drift at all. Peak and
 * current are modelled here as different kinds, and a peak can never satisfy a
 * requirement for a current sample.
 *
 * THE ONE THING THIS FILE REFUSES TO DO. It never reports physical acoustic
 * audibility as proven, and `summarizeOutcome5` has no Green return at all in
 * this repository.
 */

const SAMPLE_COUNT = 21
const NOMINAL_CADENCE_SECONDS = 30
const MIN_ELAPSED_SECONDS = 600

/**
 * ITU-R BT.1359 detectability thresholds, ASYMMETRIC and widely mis-implemented
 * as a symmetric window. Mirrored from StudioAvSyncMeter.
 */
const AUDIO_DELAYED_TOLERANCE_MS = 125
const AUDIO_ADVANCED_TOLERANCE_MS = 45

/**
 * Inherited unscaled from the accepted allocation-class contract at
 * StudioStressTests.swift:197. A leak grows with work, so scaling the budget
 * with run length would conceal what a ten-minute run exists to expose.
 */
const FOOTPRINT_GROWTH_BUDGET_MB = 24
const MAX_RESIDENT_DECODER_GROWTH = 1
const MAX_IO_SURFACE_ID = 0xffffffff

/**
 * The export prints milliseconds with `%.3f`, so a faithful receipt rounds to
 * the canonical form. Half a unit is the most a correct rounding can differ;
 * a full unit out is a different number, not a rounding artefact.
 */
const MILLISECOND_AGREEMENT = 0.0005 + 1e-9

/**
 * The two sample kinds are not interchangeable. `av1` carries the RETAINED
 * PEAK; a current reading is a different measurement with a different contract,
 * so the kind is required at every boundary rather than inferred from shape.
 */
const PEAK_SAMPLE_KIND = 'peak'
const CURRENT_SAMPLE_KIND = 'current'

const AV1_FIELDS = ['pf', 'ap', 'err', 'errms', 'win', 'winms', 'drawn', 'expl']
const AV1_EXPLANATIONS = new Set(['explained', 'not_explained', 'unknown'])

const isSafeInteger = (value) => Number.isSafeInteger(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const canonicalMs = (value) => Number(value.toFixed(3))
const agreesToThreeDecimals = (actual, canonical) =>
  isFiniteNumber(actual) && Math.abs(actual - canonical) <= MILLISECOND_AGREEMENT

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
 * BOTH clocks must span the duration: a run that reports 600s of elapsed time
 * while its monotonic clock advanced 20ms is a bunched run wearing a costume.
 */
function validateSampleSequence(samples) {
  const failures = []
  const list = Array.isArray(samples) ? samples : []
  const plan = planSamples({ startedAtMs: 0 })
  const cadenceMs = NOMINAL_CADENCE_SECONDS * 1000

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

    for (const field of ['actualElapsedMs', 'monotonicMs']) {
      const value = sample[field]
      if (!isFiniteNumber(value)) {
        failures.push(`sample ${i} has no finite ${field}`)
      } else if (value < 0) {
        failures.push(`sample ${i} has a negative ${field}`)
      }
    }

    // Bunching guard, derived from the declared cadence rather than invented:
    // a sample may run late by at most one nominal interval, and may never run
    // EARLY, because early means the plan was not honoured at all.
    if (expected && isFiniteNumber(sample.actualElapsedMs)) {
      const lateness = sample.actualElapsedMs - expected.plannedElapsedMs
      if (lateness < 0) {
        failures.push(`sample ${i} fired ${-lateness}ms EARLY, before its planned instant`)
      } else if (lateness > cadenceMs) {
        failures.push(`sample ${i} fired ${lateness}ms late, over one ${cadenceMs}ms cadence`)
      }
    }

    if (i > 0) {
      const previous = list[i - 1]
      for (const field of ['actualElapsedMs', 'monotonicMs']) {
        if (
          previous &&
          isFiniteNumber(previous[field]) &&
          isFiniteNumber(sample[field]) &&
          sample[field] <= previous[field]
        ) {
          failures.push(`${field} did not advance at ${i}: ${sample[field]} <= ${previous[field]}`)
        }
      }
    }

    // PER-SAMPLE agreement, not just endpoint agreement. Nineteen samples
    // bunched near 580s with a final jump to 600s produces matching endpoint
    // spans AND a strictly rising clock, so only a per-sample comparison of the
    // two elapsed measurements can see it. Both fields measure the SAME
    // interval from the anchor, so they must agree; the allowance is the
    // declared cadence, the coarsest unit already present in this contract.
    const anchorSample = list[0]
    if (
      anchorSample &&
      isFiniteNumber(anchorSample.actualElapsedMs) &&
      isFiniteNumber(anchorSample.monotonicMs) &&
      isFiniteNumber(sample.actualElapsedMs) &&
      isFiniteNumber(sample.monotonicMs)
    ) {
      const reportedFromAnchor = sample.actualElapsedMs - anchorSample.actualElapsedMs
      const monotonicFromAnchor = sample.monotonicMs - anchorSample.monotonicMs
      const drift = Math.abs(reportedFromAnchor - monotonicFromAnchor)
      if (drift > cadenceMs) {
        failures.push(
          `sample ${i} clocks disagree by ${drift}ms from the anchor ` +
            `(reported ${reportedFromAnchor}ms, monotonic ${monotonicFromAnchor}ms); ` +
            'the samples are bunched rather than spread across the run'
        )
      }
    }
  }

  const first = list[0]
  const last = list[list.length - 1]
  const spanOf = (field) =>
    first && last && isFiniteNumber(first[field]) && isFiniteNumber(last[field])
      ? (last[field] - first[field]) / 1000
      : null

  if (first && first.actualElapsedMs !== 0) {
    failures.push('the first sample must anchor elapsed time at zero')
  }

  const actualSpan = spanOf('actualElapsedMs')
  const monotonicSpan = spanOf('monotonicMs')
  for (const [label, span] of [
    ['reported elapsed', actualSpan],
    ['monotonic', monotonicSpan]
  ]) {
    if (span === null) {
      failures.push(`under-duration: no measurable ${label} span`)
    } else if (span < MIN_ELAPSED_SECONDS) {
      failures.push(
        `under-duration: ${label} span was ${span.toFixed(1)}s, ` +
          `endurance requires >= ${MIN_ELAPSED_SECONDS}s`
      )
    }
  }
  if (actualSpan !== null && monotonicSpan !== null) {
    const disagreementSeconds = Math.abs(actualSpan - monotonicSpan)
    if (disagreementSeconds > NOMINAL_CADENCE_SECONDS) {
      failures.push(
        `the reported elapsed span and the monotonic span disagree by ` +
          `${disagreementSeconds.toFixed(1)}s, over one cadence`
      )
    }
  }

  return { ok: failures.length === 0, failures }
}

/**
 * Recomputes EVERY relationship a receipt asserts about itself.
 *
 * Deliberately independent of any `ok` flag. The second version of this file
 * let a caller hand-build `{ ok: true, pf: 600000, ap: 0, err: 0 }` and skip
 * the parser entirely, so "refused again at classification" was a claim rather
 * than an implementation. This is the implementation.
 */
function operandIntegrityFailure(receipt, timebase) {
  if (!receipt || typeof receipt !== 'object') return 'no receipt'
  if (
    !timebase ||
    !isSafeInteger(timebase.timescale) ||
    timebase.timescale <= 0 ||
    !isSafeInteger(timebase.frameDurationTicks) ||
    timebase.frameDurationTicks <= 0
  ) {
    return 'no exact timebase (timescale and frameDurationTicks are both required)'
  }

  const { presentedFrameTicks: pf, audioPositionTicks: ap, errorTicks: err } = receipt
  if (!isSafeInteger(pf) || !isSafeInteger(ap) || !isSafeInteger(err)) {
    return 'operands are not exact safe integers'
  }
  if (err !== pf - ap) {
    return (
      `err ${err} disagrees with its own operands (pf ${pf} - ap ${ap} = ${pf - ap}); ` +
      'the receipt is forged or corrupt'
    )
  }

  const derivedErrorMs = canonicalMs((err / timebase.timescale) * 1000)
  if (!agreesToThreeDecimals(receipt.errorMilliseconds, derivedErrorMs)) {
    return (
      `errms ${receipt.errorMilliseconds} is not the canonical ` +
      `${derivedErrorMs.toFixed(3)} for err ${err} at timescale ${timebase.timescale}`
    )
  }

  const win = receipt.measurementWindowNanoseconds
  if (win === null || win === undefined) {
    if (
      receipt.measurementWindowMilliseconds !== null &&
      receipt.measurementWindowMilliseconds !== undefined
    ) {
      return 'measurement window is only half absent'
    }
  } else {
    if (!isSafeInteger(win) || win < 0) return 'measurement window is not a non-negative integer'
    const derivedWindowMs = canonicalMs(win / 1_000_000)
    if (!agreesToThreeDecimals(receipt.measurementWindowMilliseconds, derivedWindowMs)) {
      return (
        `winms ${receipt.measurementWindowMilliseconds} is not the canonical ` +
        `${derivedWindowMs.toFixed(3)} for win ${win}ns`
      )
    }
  }

  if (typeof receipt.wasDrawn !== 'boolean') return 'drawn flag is not a boolean'

  // Rederived exactly as StudioAvSyncMeter.errorIsExplainedByMeasurementWindow
  // does: only a NEGATIVE error can be explained by the window, because the
  // audio playhead is the operand read LAST.
  let expectedExplanation
  if (win === null || win === undefined) {
    expectedExplanation = 'unknown'
  } else {
    const errorMs = (err / timebase.timescale) * 1000
    const quantisationMs = (timebase.frameDurationTicks / timebase.timescale) * 1000
    expectedExplanation =
      errorMs < 0 && -errorMs <= win / 1_000_000 + quantisationMs ? 'explained' : 'not_explained'
  }
  if (receipt.explanation !== expectedExplanation) {
    return (
      `explanation "${receipt.explanation}" is not what these operands produce ` +
      `("${expectedExplanation}"); the receipt is inconsistent or cross-read`
    )
  }

  return null
}

/**
 * Fail-closed parse of the product's `av1` export.
 *
 * TAGGED AS A PEAK, because that is what it is: the publish site is
 * `syncMeter.peakSample.diagnosticsExportText`.
 */
function parseAvSyncPeakExport(text) {
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
    return isSafeInteger(value) ? value : null
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
  if (errorTicks !== presentedFrameTicks - audioPositionTicks) {
    return {
      ok: false,
      reason:
        `err ${errorTicks} disagrees with its own operands ` +
        `(pf ${presentedFrameTicks} - ap ${audioPositionTicks} = ` +
        `${presentedFrameTicks - audioPositionTicks})`
    }
  }

  const errorMilliseconds = exactDecimal('errms')
  if (errorMilliseconds === null) {
    return { ok: false, reason: 'errms is not a finite three-decimal value' }
  }
  // The full canonical check needs a timescale and therefore belongs to
  // classification. Two parts of it do NOT: zero ticks are zero milliseconds at
  // every timescale, and the sign cannot change. `err=0 errms=0.001` is caught
  // here rather than waiting for a timebase that a caller might never supply.
  if (errorTicks === 0 && errorMilliseconds !== 0) {
    return { ok: false, reason: `errms ${errorMilliseconds} is not zero for err 0` }
  }
  if (Math.sign(errorTicks) !== Math.sign(errorMilliseconds)) {
    return {
      ok: false,
      reason: `errms ${errorMilliseconds} does not share the sign of err ${errorTicks}`
    }
  }

  const rawWindow = fields.get('win')
  const rawWindowMs = fields.get('winms')
  let measurementWindowNanoseconds = null
  let measurementWindowMilliseconds = null
  if (rawWindow === '-' || rawWindowMs === '-') {
    if (rawWindow !== '-' || rawWindowMs !== '-') {
      return { ok: false, reason: 'measurement window is only half absent' }
    }
  } else {
    measurementWindowNanoseconds = exactInteger('win')
    if (measurementWindowNanoseconds === null || measurementWindowNanoseconds < 0) {
      return { ok: false, reason: 'measurement window is not a non-negative integer' }
    }
    measurementWindowMilliseconds = exactDecimal('winms')
    if (measurementWindowMilliseconds === null) {
      return { ok: false, reason: 'winms is not a finite three-decimal value' }
    }
    const derived = canonicalMs(measurementWindowNanoseconds / 1_000_000)
    if (!agreesToThreeDecimals(measurementWindowMilliseconds, derived)) {
      return {
        ok: false,
        reason: `winms ${measurementWindowMilliseconds} is not the canonical ${derived.toFixed(3)}`
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
    kind: 'peak',
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

function toleranceVerdict(errorMs) {
  const bound = errorMs >= 0 ? AUDIO_DELAYED_TOLERANCE_MS : AUDIO_ADVANCED_TOLERANCE_MS
  return { within: Math.abs(errorMs) <= bound, bound }
}

/**
 * Classifies the RETAINED PEAK.
 *
 * A peak is a diagnostic about the worst moment since the last seek, so an
 * out-of-bound peak that the measurement window explains is retained as an
 * explained diagnostic — neither a live pass nor a live failure. That is the
 * measured -1088.5ms case. An out-of-bound peak with no explanation, or one
 * that was never measured, is Red.
 */
function classifyAvPeakSample({ receipt, timebase }) {
  if (!receipt || receipt.kind !== PEAK_SAMPLE_KIND) {
    return {
      kind: 'peak',
      status: 'red',
      reason: `peak slot requires a "${PEAK_SAMPLE_KIND}" receipt, got "${receipt && receipt.kind}"`
    }
  }
  const integrity = operandIntegrityFailure(receipt, timebase)
  if (integrity) {
    return { kind: 'peak', status: 'red', reason: `unusable peak receipt: ${integrity}` }
  }
  if (!receipt.wasDrawn) {
    return { kind: 'peak', status: 'red', reason: 'peak came from a tick that drew nothing' }
  }

  const errorMs = (receipt.errorTicks / timebase.timescale) * 1000
  const { within, bound } = toleranceVerdict(errorMs)
  if (within) {
    return {
      kind: 'peak',
      status: 'green',
      errorMilliseconds: errorMs,
      reason: 'peak within bound'
    }
  }
  if (receipt.explanation === 'explained') {
    return {
      kind: 'peak',
      status: 'explained-diagnostic',
      errorMilliseconds: errorMs,
      reason:
        `peak ${errorMs.toFixed(3)}ms exceeds the ${bound}ms bound but is accounted for by ` +
        'the measurement window; it is a diagnostic, not a live verdict'
    }
  }
  return {
    kind: 'peak',
    status: 'red',
    errorMilliseconds: errorMs,
    reason: `peak ${errorMs.toFixed(3)}ms exceeds the ${bound}ms bound, unexplained`
  }
}

/**
 * Classifies a CURRENT sample.
 *
 * No explanation excuses a live out-of-bound error, and an absent measurement
 * window makes the two operands a possible cross-read rather than a
 * simultaneous reading. This is the only verdict the terminal summary accepts.
 */
function classifyAvCurrentSample({ receipt, timebase }) {
  // A RETAINED PEAK MUST NEVER SATISFY A CURRENT SLOT. The peak describes the
  // worst moment since the last seek; substituting it here would prove sync
  // held at an instant nobody measured. The kind is declared, not sniffed,
  // because two receipts with identical fields can mean different things.
  if (!receipt || receipt.kind !== CURRENT_SAMPLE_KIND) {
    return {
      kind: 'current',
      status: 'red',
      reason:
        `current slot requires a "${CURRENT_SAMPLE_KIND}" receipt, got ` +
        `"${receipt && receipt.kind}"; a retained peak cannot stand in for a live reading`
    }
  }
  const integrity = operandIntegrityFailure(receipt, timebase)
  if (integrity) {
    return { kind: 'current', status: 'red', reason: `unusable current receipt: ${integrity}` }
  }
  if (!receipt.wasDrawn) {
    return {
      kind: 'current',
      status: 'red',
      reason: 'frame not drawn — the sample is evidence about nothing'
    }
  }
  if (
    receipt.measurementWindowNanoseconds === null ||
    receipt.measurementWindowNanoseconds === undefined
  ) {
    return {
      kind: 'current',
      status: 'red',
      reason: 'absent measurement window — the operands may be a cross-read'
    }
  }

  // A CURRENT sample claims the two clocks were read together. A ten-second gap
  // between them cannot support that claim no matter how small the resulting
  // error looks — the reading is a cross-read wearing a current label. The
  // bound is the frame-duration quantisation, because a gap wider than one
  // frame can move the answer by a whole frame. The PEAK keeps its separate
  // explained-window semantics precisely because a peak is allowed to describe
  // a stall.
  const quantisationNs = (timebase.frameDurationTicks / timebase.timescale) * 1_000_000_000
  if (
    receipt.measurementWindowNanoseconds <= 0 ||
    receipt.measurementWindowNanoseconds > quantisationNs
  ) {
    return {
      kind: 'current',
      status: 'red',
      reason:
        `current read window ${receipt.measurementWindowNanoseconds}ns is outside ` +
        `(0, ${Math.round(quantisationNs)}ns]; the operands are not simultaneous`
    }
  }

  const errorMs = (receipt.errorTicks / timebase.timescale) * 1000
  const { within, bound } = toleranceVerdict(errorMs)
  return {
    kind: 'current',
    status: within ? 'green' : 'red',
    errorMilliseconds: errorMs,
    direction: errorMs >= 0 ? 'audio-delayed' : 'audio-advanced',
    reason: within
      ? 'current error within the asymmetric BT.1359 bound'
      : `current error ${errorMs.toFixed(3)}ms exceeds the ${bound}ms bound`
  }
}

/** Bounded setup allowance for a capture, mirroring the harness receipt rule. */
const AUDIO_ELAPSED_ALLOWANCE_SECONDS = 10

const SILENCE_RMS_CEILING = 0.005
const SILENCE_PEAK_CEILING = 0.02
const SILENCE_FRACTION_CEILING = 0.01
const POSITIVE_RMS_FLOOR = 0.02
const POSITIVE_NON_SILENT_FRACTION_FLOOR = 0.5

/**
 * Validates a full AudioProbeReceipt as the driver actually emits it
 * (studio-acceptance-ui-driver.swift:62-74), not three floating metrics.
 */
/**
 * Coverage floor: the captured frames must actually account for the requested
 * interval. A 600-second probe backed by one frame is not a quiet capture, it
 * is an absent one.
 */
const AUDIO_COVERAGE_FLOOR = 0.99

function audioProbeFailure(receipt, label, expectedRoute) {
  if (!receipt || typeof receipt !== 'object') return `${label} receipt is absent`
  for (const field of [
    'durationSeconds',
    'sampleBufferCount',
    'frameCount',
    'sampleValueCount',
    'channelCount'
  ]) {
    const value = receipt[field]
    if (!isSafeInteger(value) || value <= 0) return `${label} ${field} is not a positive integer`
  }
  if (!isFiniteNumber(receipt.elapsedSeconds) || receipt.elapsedSeconds <= 0) {
    return `${label} elapsedSeconds is not positive`
  }
  // A capture cannot finish before it starts, and it cannot claim 600 seconds
  // of audio gathered in a tenth of a second. Mirrors the harness receipt rule:
  // elapsed must cover the requested duration, with a bounded setup allowance.
  if (receipt.elapsedSeconds < receipt.durationSeconds) {
    return (
      `${label} claims ${receipt.durationSeconds}s of capture in ` +
      `${receipt.elapsedSeconds}s of wall clock`
    )
  }
  if (receipt.elapsedSeconds > receipt.durationSeconds + AUDIO_ELAPSED_ALLOWANCE_SECONDS) {
    return (
      `${label} took ${receipt.elapsedSeconds}s for a ${receipt.durationSeconds}s ` +
      `capture, over the ${AUDIO_ELAPSED_ALLOWANCE_SECONDS}s allowance`
    )
  }
  if (!isFiniteNumber(receipt.sampleRate) || receipt.sampleRate <= 0) {
    return `${label} sampleRate is not positive`
  }
  for (const field of ['rms', 'peak', 'nonSilentFraction']) {
    const value = receipt[field]
    if (!isFiniteNumber(value) || value < 0 || value > 1) return `${label} ${field} is out of range`
  }
  // A peak below its own RMS is physically impossible and marks a fabricated
  // or mis-scaled receipt.
  if (receipt.peak < receipt.rms) return `${label} peak is below its own RMS`

  // Sample-count algebra. Interleaved samples are frames x channels; a receipt
  // that disagrees with its own arithmetic is not describing a real capture.
  if (receipt.sampleValueCount !== receipt.frameCount * receipt.channelCount) {
    return (
      `${label} sampleValueCount ${receipt.sampleValueCount} is not ` +
      `frameCount ${receipt.frameCount} x channelCount ${receipt.channelCount}`
    )
  }

  // Captured-duration coverage. frameCount/sampleRate is how much audio was
  // ACTUALLY captured, independent of how long the probe claims to have run.
  const capturedSeconds = receipt.frameCount / receipt.sampleRate
  if (capturedSeconds < receipt.durationSeconds * AUDIO_COVERAGE_FLOOR) {
    return (
      `${label} captured only ${capturedSeconds.toFixed(3)}s of audio for a ` +
      `${receipt.durationSeconds}s request`
    )
  }
  if (capturedSeconds > receipt.durationSeconds + 1) {
    return (
      `${label} captured ${capturedSeconds.toFixed(3)}s for a ` +
      `${receipt.durationSeconds}s request, more than the interval can hold`
    )
  }

  // The embedded device is part of the Swift receipt, and it is the only thing
  // that ties this capture to the route whose health was checked. Without the
  // link, a healthy route and a capture from somewhere else read the same.
  const device = receipt.defaultOutputDevice
  if (!device || typeof device !== 'object') {
    return `${label} carries no embedded defaultOutputDevice receipt`
  }
  // Validate the embedded receipt IN ITS OWN RIGHT before comparing it to
  // anything. Equality between two absent fields is not a match.
  if (!isSafeInteger(device.id) || device.id <= 0) {
    return `${label} embedded device id is not a positive exact integer`
  }
  if (!isNonEmptyString(device.name)) return `${label} embedded device name is empty`
  if (!isNonEmptyString(device.uid)) return `${label} embedded device uid is empty`
  if (!isFiniteNumber(device.nominalSampleRate) || device.nominalSampleRate <= 0) {
    return `${label} embedded device nominalSampleRate is not positive`
  }
  if (expectedRoute) {
    if (
      device.id !== expectedRoute.id ||
      device.uid !== expectedRoute.uid ||
      device.name !== expectedRoute.name ||
      device.nominalSampleRate !== expectedRoute.nominalSampleRate
    ) {
      return `${label} was captured on a different output device than the checked route`
    }
  }
  return null
}

/** Validates an OutputDeviceReceipt plus the explicit support flags. */
function routeReceiptFailure(route, label) {
  if (!route || typeof route !== 'object') return `${label} route receipt is absent`
  if (!isSafeInteger(route.id) || route.id <= 0) {
    return `${label} device id is not a positive exact integer`
  }
  if (!isNonEmptyString(route.uid)) return `${label} device uid is empty`
  // A name absent on BOTH the route and the embedded receipt used to compare
  // equal, so "exact identity" was satisfied by two holes.
  if (!isNonEmptyString(route.name)) return `${label} device name is empty`
  if (!isFiniteNumber(route.nominalSampleRate) || route.nominalSampleRate <= 0) {
    return `${label} nominalSampleRate is not positive`
  }
  if (route.alive !== true || route.running !== true || route.hasOutputStream !== true) {
    return `${label} device is not alive/running with an output stream`
  }
  if (!isSafeInteger(route.outputChannelCount) || route.outputChannelCount <= 0) {
    return `${label} outputChannelCount is not a positive integer`
  }
  // Support must be DECLARED. A missing field is not evidence of anything, and
  // inferring "unsupported" from absence is how an unreadable route passes.
  if (typeof route.muteSupported !== 'boolean') return `${label} muteSupported is not declared`
  if (typeof route.volumeSupported !== 'boolean') return `${label} volumeSupported is not declared`
  if (!route.muteSupported) return `${label} mute state is unsupported, so it cannot be cleared`
  if (route.muted !== false) return `${label} route is muted or its mute state is unreadable`
  if (!route.volumeSupported) return `${label} volume is unsupported, so it cannot be cleared`
  if (!isFiniteNumber(route.volume) || route.volume <= 0 || route.volume > 1) {
    return `${label} volume is zero or out of range`
  }
  return null
}

/**
 * Separates three DIFFERENT claims:
 *   windowEmission     — the Studio window produced samples
 *   routeState         — the selected output device is configured and usable
 *   physicalAudibility — sound actually reached a listener
 *
 * Only the first two are measurable here. The third is BLOCKED, permanently.
 */
function classifyAudioEvidence({ windowAudio, silenceWindow, routeHealth, priorRouteHealth }) {
  const failures = []

  const positiveFailure = audioProbeFailure(windowAudio, 'positive window', routeHealth)
  let windowEmission
  if (positiveFailure) {
    windowEmission = 'unknown'
    failures.push(positiveFailure)
  } else if (
    windowAudio.rms >= POSITIVE_RMS_FLOOR &&
    windowAudio.nonSilentFraction >= POSITIVE_NON_SILENT_FRACTION_FLOOR
  ) {
    windowEmission = 'proven'
  } else {
    windowEmission = 'absent'
    failures.push('positive window carried no measurable signal')
  }

  const silenceFailure = audioProbeFailure(silenceWindow, 'intentional-silence window', routeHealth)
  let intentionalSilence
  if (silenceFailure) {
    intentionalSilence = 'unknown'
    failures.push(silenceFailure)
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

  // BOTH readings are validated in full. Comparing a complete current receipt
  // against an unvalidated prior would let a malformed prior manufacture a
  // stability claim.
  const currentRouteFailure = routeReceiptFailure(routeHealth, 'current')
  const priorRouteFailure = routeReceiptFailure(priorRouteHealth, 'prior')
  let routeState
  if (currentRouteFailure || priorRouteFailure) {
    routeState = 'unknown'
    if (currentRouteFailure) failures.push(currentRouteFailure)
    if (priorRouteFailure) failures.push(priorRouteFailure)
  } else if (
    priorRouteHealth.id !== routeHealth.id ||
    priorRouteHealth.uid !== routeHealth.uid ||
    priorRouteHealth.nominalSampleRate !== routeHealth.nominalSampleRate
  ) {
    routeState = 'changed'
    failures.push('output device identity or sample rate changed mid-run')
  } else {
    routeState = 'healthy'
  }

  return {
    // Fixed, not computed. No input to this function can make it anything else.
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
  if (!Array.isArray(ids) || ids.length === 0) return null
  const set = new Set()
  for (const id of ids) {
    if (!isSafeInteger(id) || id < 0 || id > MAX_IO_SURFACE_ID) return null
    if (set.has(id)) return null // duplicate identities are a malformed probe
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
 * Aligned allocation-class trend, mirroring StudioMemoryTrend.
 *
 * Endpoints alone cannot see what matters: a footprint that grows on EVERY
 * sample is a leak even inside budget, a live IOSurface set that strictly
 * accumulates across three readings is the surface leak the Swift contract
 * already refuses, and a decoder spike in the middle disappears entirely into
 * a green endpoint — so the PEAK is bounded, not just the last value.
 */
function classifyResourceGrowth({ readings, droppedFrames, ioSurfaceCapacity }) {
  const failures = []
  const list = Array.isArray(readings) ? readings : []
  if (list.length !== SAMPLE_COUNT) {
    return {
      status: 'red',
      failures: [`${list.length} resource readings, expected exactly ${SAMPLE_COUNT}`]
    }
  }
  if (!isSafeInteger(ioSurfaceCapacity) || ioSurfaceCapacity <= 0) {
    return { status: 'red', failures: ['no declared renderer IOSurface capacity to compare'] }
  }

  const surfaceSets = []
  for (let i = 0; i < list.length; i += 1) {
    const reading = list[i]
    if (!reading || typeof reading !== 'object') {
      failures.push(`resource reading ${i} is missing`)
      continue
    }
    for (const field of [
      'footprintBytes',
      'mallocInUseBytes',
      'residentBytes',
      'residentDecoderCount'
    ]) {
      const value = reading[field]
      if (!isSafeInteger(value) || value < 0) {
        failures.push(`resource reading ${i} has no finite non-negative ${field}`)
      }
    }
    const set = ioSurfaceSet(reading.liveIoSurfaceIds)
    if (set === null) {
      failures.push(`resource reading ${i} has no valid live IOSurface identity set`)
    } else {
      surfaceSets.push(set)
      if (set.size > ioSurfaceCapacity) {
        failures.push(
          `resource reading ${i} holds ${set.size} live IOSurfaces, ` +
            `over the renderer capacity of ${ioSurfaceCapacity}`
        )
      }
    }
  }
  if (failures.length > 0) return { status: 'red', failures }

  const first = list[0]
  const last = list[list.length - 1]
  const budgetBytes = FOOTPRINT_GROWTH_BUDGET_MB * 1_048_576

  for (const [label, field] of [
    ['footprint', 'footprintBytes'],
    ['malloc', 'mallocInUseBytes'],
    ['resident', 'residentBytes']
  ]) {
    const growth = last[field] - first[field]
    if (growth > budgetBytes) {
      failures.push(
        `${label} grew ${(growth / 1_048_576).toFixed(1)}MB, exceeding the accepted ` +
          `${FOOTPRINT_GROWTH_BUDGET_MB}MB allocation-class budget`
      )
    }
  }

  let grewEveryStep = true
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].footprintBytes <= list[i - 1].footprintBytes) grewEveryStep = false
  }
  if (grewEveryStep) {
    failures.push('footprint grew on every sample — a leak shape regardless of the total')
  }

  // Swift's rule is three ACCUMULATING SAMPLES, which is TWO transitions:
  // [1] -> [1,2] -> [1,2,3] is already the refused shape.
  let accumulatingTransitions = 0
  for (let i = 1; i < surfaceSets.length; i += 1) {
    if (isStrictSuperset(surfaceSets[i], surfaceSets[i - 1])) {
      accumulatingTransitions += 1
      if (accumulatingTransitions >= 2) {
        failures.push('live IOSurface identities strictly accumulated across three samples')
        break
      }
    } else {
      accumulatingTransitions = 0
    }
  }

  // The PEAK, not the endpoint: a mid-run decoder spike that is released before
  // the last sample is still an unbounded lease while it is held.
  const peakDecoders = list.reduce((max, r) => Math.max(max, r.residentDecoderCount), 0)
  if (peakDecoders - first.residentDecoderCount > MAX_RESIDENT_DECODER_GROWTH) {
    failures.push(
      `resident decoder count peaked at ${peakDecoders} from ${first.residentDecoderCount}; ` +
        `the shared-decoder contract allows at most +${MAX_RESIDENT_DECODER_GROWTH}`
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
    footprintGrowthMb: (last.footprintBytes - first.footprintBytes) / 1_048_576,
    mallocGrowthMb: (last.mallocInUseBytes - first.mallocInUseBytes) / 1_048_576,
    residentGrowthMb: (last.residentBytes - first.residentBytes) / 1_048_576,
    peakResidentDecoderCount: peakDecoders
  }
}
/**
 * The authoritative per-sample timebase plan.
 *
 * ONE SAMPLE CANNOT INHABIT TWO TIMEBASES. Without a shared plan, the current
 * and peak streams could each choose their own denominator for the same
 * instant: a 6,000-tick error reads 6ms Green at timescale 1,000,000 and 200ms
 * Red at the real 30,000. Exact rational time is the whole point of this
 * outcome, so the denominator is declared once per sample and every stream must
 * match it. Per-sample rather than global, because variable-frame-rate media
 * genuinely changes its local frame duration.
 */
function validateTimebasePlan(plan) {
  const failures = []
  const list = Array.isArray(plan) ? plan : null
  if (list === null) return { ok: false, failures: ['no authoritative timebase plan'], entries: [] }
  if (list.length !== SAMPLE_COUNT) {
    return {
      ok: false,
      failures: [`${list.length} timebase plan entries, expected exactly ${SAMPLE_COUNT}`],
      entries: []
    }
  }
  const entries = []
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i]
    if (!entry || typeof entry !== 'object') {
      failures.push(`timebase plan entry ${i} is missing`)
      continue
    }
    if (entry.sampleIndex !== i) {
      failures.push(`timebase plan entry ${i} claims sampleIndex ${entry.sampleIndex}`)
    }
    if (!isSafeInteger(entry.timescale) || entry.timescale <= 0) {
      failures.push(`timebase plan entry ${i} has no exact positive timescale`)
    }
    if (!isSafeInteger(entry.frameDurationTicks) || entry.frameDurationTicks <= 0) {
      failures.push(`timebase plan entry ${i} has no exact positive frameDurationTicks`)
    }
    entries.push(entry)
  }
  return { ok: failures.length === 0, failures, entries }
}

/** A stream entry must use the declared denominator, not one of its own. */
function timebaseMismatch(entry, planEntry, index, label) {
  const timebase = entry && entry.timebase
  if (!timebase || typeof timebase !== 'object') {
    return `${label} ${index} carries no timebase`
  }
  if (
    timebase.timescale !== planEntry.timescale ||
    timebase.frameDurationTicks !== planEntry.frameDurationTicks
  ) {
    return (
      `${label} ${index} uses timebase ${timebase.timescale}/${timebase.frameDurationTicks} ` +
      `but the sample's authoritative plan is ` +
      `${planEntry.timescale}/${planEntry.frameDurationTicks}`
    )
  }
  return null
}

/**
 * Cross-stream alignment.
 *
 * Length alone is not twenty-one observations: the same receipt repeated
 * twenty-one times has the same length as a real run. Every entry must name the
 * sample it belongs to AND carry the same observed monotonic instant as that
 * sample, so the streams describe one run rather than one moment counted
 * repeatedly.
 */
function alignmentFailure(entry, index, sample, label) {
  if (!entry || typeof entry !== 'object') return `${label} ${index} is missing`
  if (entry.sampleIndex !== index) {
    return `${label} ${index} claims sampleIndex ${entry.sampleIndex}`
  }
  if (!sample) return `${label} ${index} has no matching validated sample`
  if (entry.monotonicMs !== sample.monotonicMs) {
    return (
      `${label} ${index} was observed at ${entry.monotonicMs}ms but its sample ` +
      `was taken at ${sample.monotonicMs}ms`
    )
  }
  return null
}

/**
 * Terminal verdict, computed from RAW EVIDENCE.
 *
 * WHY THIS TAKES RECEIPTS RATHER THAN VERDICTS. An earlier version accepted
 * caller-supplied verdict objects, so a hand-shaped `{ status: 'green' }` and a
 * measured classification were indistinguishable — and the summary would then
 * report that every software gate had passed and only physical audibility
 * remained. That is the most expensive false statement this file can make,
 * because it is the one a promotion decision reads. It re-runs every validator
 * itself; there is no shape a caller can pass that skips the work.
 *
 * PEAK EVIDENCE IS REQUIRED, NOT OPTIONAL. Outcome 5 asks for the retained
 * worst sample as well as the live one. Omitting peaks entirely used to produce
 * a clean `blocked`, which silently dropped half the question.
 *
 * THERE IS NO GREEN RETURN IN THIS REPOSITORY.
 */
function summarizeOutcome5({
  samples,
  timebasePlan,
  currentSamples,
  peakSamples,
  audio,
  resources
}) {
  const failures = []
  const blockers = []

  const sequence = validateSampleSequence(samples)
  if (!sequence.ok) failures.push(...sequence.failures)
  const sampleList = Array.isArray(samples) ? samples : []

  const plan = validateTimebasePlan(timebasePlan)
  if (!plan.ok) failures.push(...plan.failures)

  const classifyStream = (entries, label, classifier, accept) => {
    const verdicts = []
    if (!Array.isArray(entries)) {
      failures.push(`no raw ${label} receipts`)
      return verdicts
    }
    if (entries.length !== SAMPLE_COUNT) {
      failures.push(`${entries.length} ${label} receipts, expected exactly ${SAMPLE_COUNT}`)
      return verdicts
    }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      const misalignment = alignmentFailure(entry, i, sampleList[i], label)
      if (misalignment) {
        failures.push(misalignment)
        continue
      }
      // The denominator is the plan's, not the entry's claim about itself.
      const planEntry = plan.ok ? plan.entries[i] : null
      if (planEntry) {
        const mismatch = timebaseMismatch(entry, planEntry, i, label)
        if (mismatch) {
          failures.push(mismatch)
          continue
        }
      }
      const verdict = classifier({ receipt: entry.receipt, timebase: entry.timebase })
      verdicts.push(verdict)
      if (!accept(verdict)) failures.push(`${label} ${i}: ${verdict.reason}`)
    }
    return verdicts
  }

  const avVerdicts = classifyStream(
    currentSamples,
    'current A/V',
    classifyAvCurrentSample,
    (v) => v.status === 'green'
  )
  // An explained out-of-bound peak is retained as a diagnostic; an unexplained
  // or unmeasured one is a failure.
  const peakVerdicts = classifyStream(
    peakSamples,
    'peak A/V',
    classifyAvPeakSample,
    (v) => v.status === 'green' || v.status === 'explained-diagnostic'
  )

  let audioVerdict = null
  if (!audio || typeof audio !== 'object') {
    failures.push('no raw audio evidence')
  } else {
    audioVerdict = classifyAudioEvidence({
      windowAudio: audio.windowAudio,
      silenceWindow: audio.silenceWindow,
      routeHealth: audio.routeHealth,
      priorRouteHealth: audio.priorRouteHealth
    })
    if (audioVerdict.failures.length > 0) failures.push(...audioVerdict.failures)
    if (audioVerdict.physicalAudibility !== 'blocked') {
      failures.push('audio classification did not produce the fixed audibility blocker')
    }
  }

  let resourceVerdict = null
  if (!resources || typeof resources !== 'object') {
    failures.push('no raw resource evidence')
  } else {
    const readings = Array.isArray(resources.readings) ? resources.readings : []
    if (readings.length !== SAMPLE_COUNT) {
      failures.push(`${readings.length} resource readings, expected exactly ${SAMPLE_COUNT}`)
    } else {
      for (let i = 0; i < readings.length; i += 1) {
        const misalignment = alignmentFailure(readings[i], i, sampleList[i], 'resource reading')
        if (misalignment) failures.push(misalignment)
      }
    }
    resourceVerdict = classifyResourceGrowth({
      readings: resources.readings,
      droppedFrames: resources.droppedFrames,
      ioSurfaceCapacity: resources.ioSurfaceCapacity
    })
    if (resourceVerdict.status !== 'green') failures.push(...resourceVerdict.failures)
  }

  blockers.push(
    'physical audibility is not proven: ' +
      ((audioVerdict && audioVerdict.missingProof) || 'no audio evidence') +
      ' — this outcome cannot reach Green in this repository'
  )

  const evidence = {
    sequence,
    timebasePlan: plan,
    avVerdicts,
    peakVerdicts,
    audio: audioVerdict,
    resources: resourceVerdict
  }
  if (failures.length > 0) return { status: 'red', failures, blockers, evidence }
  return { status: 'blocked', failures, blockers, evidence }
}

module.exports = {
  AUDIO_ADVANCED_TOLERANCE_MS,
  validateTimebasePlan,
  CURRENT_SAMPLE_KIND,
  PEAK_SAMPLE_KIND,
  AUDIO_ELAPSED_ALLOWANCE_SECONDS,
  AUDIO_DELAYED_TOLERANCE_MS,
  FOOTPRINT_GROWTH_BUDGET_MB,
  MAX_IO_SURFACE_ID,
  MAX_RESIDENT_DECODER_GROWTH,
  MILLISECOND_AGREEMENT,
  MIN_ELAPSED_SECONDS,
  NOMINAL_CADENCE_SECONDS,
  SAMPLE_COUNT,
  classifyAudioEvidence,
  classifyAvCurrentSample,
  classifyAvPeakSample,
  classifyResourceGrowth,
  operandIntegrityFailure,
  parseAvSyncPeakExport,
  planSamples,
  summarizeOutcome5,
  validateSampleSequence
}
