import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  AUDIO_ADVANCED_TOLERANCE_MS,
  AUDIO_DELAYED_TOLERANCE_MS,
  FOOTPRINT_GROWTH_BUDGET_MB,
  MAX_IO_SURFACE_ID,
  MIN_ELAPSED_SECONDS,
  NOMINAL_CADENCE_SECONDS,
  SAMPLE_COUNT,
  classifyAudioEvidence,
  classifyAvCurrentSample,
  classifyAvPeakSample,
  classifyResourceGrowth,
  parseAvSyncCurrentExport,
  parseAvSyncPeakExport,
  planSamples,
  summarizeOutcome5,
  validateSampleSequence
} = require('./studio-av-endurance-runner.cjs')

const TIMESCALE = 30000
const FRAME_DURATION_TICKS = 1000
const TIMEBASE = { timescale: TIMESCALE, frameDurationTicks: FRAME_DURATION_TICKS }
const QUANTISATION_MS = (FRAME_DURATION_TICKS / TIMESCALE) * 1000
const msToTicks = (ms: number) => Math.round((ms / 1000) * TIMESCALE)

function deriveExplanation(errTicks: number, winNs: number | null): string {
  if (winNs === null) return 'unknown'
  const errMs = (errTicks / TIMESCALE) * 1000
  return errMs < 0 && -errMs <= winNs / 1_000_000 + QUANTISATION_MS ? 'explained' : 'not_explained'
}

/**
 * A SELF-CONSISTENT receipt object, so forging one has to be deliberate.
 *
 * The kind is EXPLICIT and defaults to current. The previous helper hard-coded
 * kind:'peak' and was then used for every current fixture, so the suite itself
 * encoded the forbidden peak-in-a-current-slot substitution it was meant to
 * forbid. A default that quietly disagrees with the caller's intent is how a
 * test file starts lying on the product's behalf.
 */
function receipt({
  errTicks = 0,
  winNs = 1_000_000 as number | null,
  drawn = true,
  expl = null as string | null,
  pf = 600_000,
  kind = 'current' as string
} = {}) {
  return {
    ok: true,
    kind,
    presentedFrameTicks: pf,
    audioPositionTicks: pf - errTicks,
    errorTicks: errTicks,
    errorMilliseconds: Number(((errTicks / TIMESCALE) * 1000).toFixed(3)),
    measurementWindowNanoseconds: winNs,
    measurementWindowMilliseconds: winNs === null ? null : Number((winNs / 1_000_000).toFixed(3)),
    wasDrawn: drawn,
    explanation: expl ?? deriveExplanation(errTicks, winNs)
  }
}
const peakReceipt = (o: Parameters<typeof receipt>[0] = {}) => receipt({ ...o, kind: 'peak' })

function av1Text(options: Parameters<typeof receipt>[0] = {}): string {
  const r = peakReceipt(options)
  const win = r.measurementWindowNanoseconds === null ? '-' : String(r.measurementWindowNanoseconds)
  const winms =
    r.measurementWindowMilliseconds === null ? '-' : r.measurementWindowMilliseconds.toFixed(3)
  return (
    `av1 pf=${r.presentedFrameTicks} ap=${r.audioPositionTicks} err=${r.errorTicks} ` +
    `errms=${r.errorMilliseconds.toFixed(3)} win=${win} winms=${winms} ` +
    `drawn=${r.wasDrawn ? 1 : 0} expl=${r.explanation}`
  )
}

function avc1Text(options: Parameters<typeof receipt>[0] = {}): string {
  const r = receipt(options)
  const win = r.measurementWindowNanoseconds === null ? '-' : String(r.measurementWindowNanoseconds)
  const winms =
    r.measurementWindowMilliseconds === null ? '-' : r.measurementWindowMilliseconds.toFixed(3)
  return (
    `avc1 ts=${TIMESCALE} fd=${FRAME_DURATION_TICKS} pf=${r.presentedFrameTicks} ` +
    `ap=${r.audioPositionTicks} err=${r.errorTicks} ` +
    `errms=${r.errorMilliseconds.toFixed(3)} win=${win} winms=${winms} ` +
    `drawn=${r.wasDrawn ? 1 : 0} expl=${r.explanation}`
  )
}

const plannedSample = (index: number, overrides: Record<string, unknown> = {}) => ({
  index,
  plannedElapsedMs: planSamples()[index].plannedElapsedMs,
  actualElapsedMs: planSamples()[index].plannedElapsedMs,
  monotonicMs: 1_000_000 + planSamples()[index].plannedElapsedMs,
  ...overrides
})
const goodRun = () => Array.from({ length: SAMPLE_COUNT }, (_, i) => plannedSample(i))

describe('outcome 5 sample plan', () => {
  it('spans the required ten minutes at the declared cadence and count', () => {
    const plan = planSamples({ startedAtMs: 1_000 })
    expect(plan).toHaveLength(SAMPLE_COUNT)
    expect(SAMPLE_COUNT).toBe(21)
    expect((plan[plan.length - 1].plannedElapsedMs - plan[0].plannedElapsedMs) / 1000).toBe(
      MIN_ELAPSED_SECONDS
    )
    for (let i = 1; i < plan.length; i += 1) {
      expect((plan[i].plannedElapsedMs - plan[i - 1].plannedElapsedMs) / 1000).toBe(
        NOMINAL_CADENCE_SECONDS
      )
    }
  })
})

describe('sequence integrity requires BOTH clocks to span the run', () => {
  it('accepts a complete, ordered, full-duration run', () => {
    expect(validateSampleSequence(goodRun())).toEqual({ ok: true, failures: [] })
  })

  // THE FALSE GREEN: 600s reported, 20ms actually elapsed.
  it('refuses a run reported as ten minutes whose monotonic clock advanced 20ms', () => {
    const bunched = goodRun().map((s, i) => ({ ...s, monotonicMs: 1_000_000 + i }))
    const verdict = validateSampleSequence(bunched)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/monotonic span/i)
  })

  // The monotonic span must be checked IN ITS OWN RIGHT. A run whose monotonic
  // clock covers 575s agrees with its reported span to well within a cadence,
  // so the disagreement rule cannot see it — only the monotonic duration rule
  // can. Without this the monotonic check is redundant and untested.
  it('refuses a monotonic span just under ten minutes that agrees with the reported span', () => {
    const shortMonotonic = goodRun().map((s, i) => ({
      ...s,
      monotonicMs:
        1_000_000 + Math.round((i * ((MIN_ELAPSED_SECONDS - 25) * 1000)) / (SAMPLE_COUNT - 1))
    }))
    const verdict = validateSampleSequence(shortMonotonic)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/monotonic span/i)
    // and it must NOT be caught by the disagreement rule instead
    expect(verdict.failures.join(' ')).not.toMatch(/disagree/i)
  })

  // ADVISOR'S EXACT CASE: endpoint spans agree and the clock rises strictly,
  // but samples 1..19 all happen in one late cluster. Only a per-sample
  // comparison can see it.
  it('refuses nineteen samples bunched at 580s with a final jump to 600s', () => {
    const bunched = goodRun().map((s, i) => ({
      ...s,
      monotonicMs: 1_000_000 + (i === 0 ? 0 : i === SAMPLE_COUNT - 1 ? 600_000 : 580_000 + i)
    }))
    const verdict = validateSampleSequence(bunched)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/bunched/i)
  })

  it('refuses a monotonic span that disagrees with the reported span', () => {
    const drifted = goodRun().map((s, i) => ({ ...s, monotonicMs: 1_000_000 + i * 60_000 }))
    expect(validateSampleSequence(drifted).failures.join(' ')).toMatch(/disagree/i)
  })

  it('refuses a sample that fired EARLY, before its planned instant', () => {
    const early = goodRun()
    early[10] = { ...early[10], actualElapsedMs: (early[10].actualElapsedMs as number) - 1 }
    expect(validateSampleSequence(early).failures.join(' ')).toMatch(/early/i)
  })

  it('refuses a sample more than one nominal cadence late', () => {
    const late = goodRun()
    late[10] = {
      ...late[10],
      actualElapsedMs: (late[10].actualElapsedMs as number) + NOMINAL_CADENCE_SECONDS * 1000 + 1,
      monotonicMs: (late[10].monotonicMs as number) + NOMINAL_CADENCE_SECONDS * 1000 + 1
    }
    expect(validateSampleSequence(late).failures.join(' ')).toMatch(/late/i)
  })

  it('refuses a run that did not actually last ten minutes', () => {
    const compressed = goodRun().map((s, i) => ({
      ...s,
      plannedElapsedMs: planSamples()[i].plannedElapsedMs,
      actualElapsedMs: i * 6_000,
      monotonicMs: 1_000_000 + i * 6_000
    }))
    expect(validateSampleSequence(compressed).failures.join(' ')).toMatch(/under-duration/i)
  })

  it('refuses miscounted, duplicated, unordered, timestampless or non-finite samples', () => {
    expect(validateSampleSequence(goodRun().slice(0, 20)).ok).toBe(false)

    const duplicated = goodRun()
    duplicated[5] = { ...duplicated[5], index: 4 }
    expect(validateSampleSequence(duplicated).ok).toBe(false)

    const missing = goodRun()
    delete (missing[SAMPLE_COUNT - 1] as Record<string, unknown>).actualElapsedMs
    expect(validateSampleSequence(missing).failures.join(' ')).toMatch(/actualElapsedMs/i)

    const noMonotonic = goodRun().map((s) => {
      const copy = { ...s } as Record<string, unknown>
      delete copy.monotonicMs
      return copy
    })
    expect(validateSampleSequence(noMonotonic).failures.join(' ')).toMatch(/monotonicMs/i)

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const run = goodRun()
      run[3] = { ...run[3], actualElapsedMs: bad }
      expect(validateSampleSequence(run).ok).toBe(false)
    }

    const drifted = goodRun()
    drifted[9] = { ...drifted[9], plannedElapsedMs: 999 }
    expect(validateSampleSequence(drifted).ok).toBe(false)
  })
})

describe('av1 parses as the RETAINED PEAK and recomputes its own claims', () => {
  it('tags the receipt as a peak, because that is what the product publishes', () => {
    // StudioViewerWindow.swift:849 publishes syncMeter.peakSample, not current.
    const parsed = parseAvSyncPeakExport(av1Text())
    expect(parsed.ok).toBe(true)
    expect(parsed.kind).toBe('peak')
  })

  it('refuses a receipt whose err disagrees with its own operands', () => {
    const forged =
      'av1 pf=600000 ap=0 err=0 errms=0.000 win=1000000 winms=1.000 drawn=1 expl=not_explained'
    expect(parseAvSyncPeakExport(forged).ok).toBe(false)
  })

  it('refuses three-decimal fields one full unit off the canonical form', () => {
    // 0.001 is not a rounding of 0.000, and 1.001 is not a rounding of 1.000.
    expect(
      parseAvSyncPeakExport(
        'av1 pf=600000 ap=600000 err=0 errms=0.001 win=1000000 winms=1.000 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
    expect(
      parseAvSyncPeakExport(
        'av1 pf=600000 ap=600000 err=0 errms=0.000 win=1000000 winms=1.001 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
  })

  it('keeps an absent window absent, and refuses a half-absent one', () => {
    expect(parseAvSyncPeakExport(av1Text({ winNs: null })).measurementWindowNanoseconds).toBeNull()
    expect(
      parseAvSyncPeakExport(
        'av1 pf=600000 ap=600000 err=0 errms=0.000 win=- winms=1.000 drawn=1 expl=unknown'
      ).ok
    ).toBe(false)
  })

  it('refuses unknown schemas, duplicate fields, unknown fields and unsafe integers', () => {
    expect(parseAvSyncPeakExport('av2 pf=1 ap=1').ok).toBe(false)
    expect(parseAvSyncPeakExport('').ok).toBe(false)
    expect(parseAvSyncPeakExport(`${av1Text()} pf=1`).reason).toMatch(/duplicate/i)
    expect(parseAvSyncPeakExport(`${av1Text()} extra=1`).reason).toMatch(/unknown field/i)
    // Raw string: a JS literal this large loses precision before the parser.
    expect(
      parseAvSyncPeakExport(
        'av1 pf=9007199254740993 ap=1 err=9007199254740992 errms=0.000 ' +
          'win=1000000 winms=1.000 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
  })

  it('refuses a negative window and a missing operand', () => {
    expect(
      parseAvSyncPeakExport(
        'av1 pf=600000 ap=600000 err=0 errms=0.000 win=-5 winms=-0.000 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
    expect(parseAvSyncPeakExport('av1 pf=1 ap=1 err=0').ok).toBe(false)
  })
})

describe('avc1 parses only a live current sample with its exact timebase', () => {
  it('accepts the current schema and returns its authoritative timebase', () => {
    expect(parseAvSyncCurrentExport(avc1Text({ errTicks: 450, winNs: 750_000 }))).toMatchObject({
      ok: true,
      kind: 'current',
      presentedFrameTicks: 600_000,
      audioPositionTicks: 599_550,
      errorTicks: 450,
      measurementWindowNanoseconds: 750_000,
      wasDrawn: true,
      timebase: TIMEBASE
    })
  })

  it('rejects av1 so a retained peak cannot substitute for current evidence', () => {
    expect(parseAvSyncCurrentExport(av1Text()).ok).toBe(false)
    expect(parseAvSyncCurrentExport(av1Text()).reason).toMatch(/schema|current/i)
  })

  it('rejects forged algebra, noncanonical decimals, and unusable timebases or windows', () => {
    expect(parseAvSyncCurrentExport(avc1Text().replace('err=0', 'err=1')).ok).toBe(false)
    expect(parseAvSyncCurrentExport(avc1Text().replace('errms=0.000', 'errms=0.001')).ok).toBe(
      false
    )
    expect(parseAvSyncCurrentExport(avc1Text().replace('winms=1.000', 'winms=1.001')).ok).toBe(
      false
    )
    expect(parseAvSyncCurrentExport(avc1Text().replace('ts=30000', 'ts=0')).ok).toBe(false)
    expect(parseAvSyncCurrentExport(avc1Text().replace('fd=1000', 'fd=0')).ok).toBe(false)
    expect(parseAvSyncCurrentExport(avc1Text({ winNs: null })).ok).toBe(false)
    expect(parseAvSyncCurrentExport(`${avc1Text()} ts=30000`).reason).toMatch(/duplicate/i)
  })
})

describe('classification recomputes and never trusts a supplied ok bit', () => {
  // THE FALSE GREEN THE SECOND VERSION LEFT OPEN: a hand-built "parsed" object
  // skipped the parser entirely, so "refused again at classification" was a
  // claim rather than an implementation.
  const handcrafted = {
    ok: true,
    kind: 'current',
    presentedFrameTicks: 600_000,
    audioPositionTicks: 0,
    errorTicks: 0,
    errorMilliseconds: 0,
    measurementWindowNanoseconds: 1_000_000,
    measurementWindowMilliseconds: 1,
    wasDrawn: true,
    explanation: 'not_explained'
  }

  it('refuses a handcrafted object that bypassed the parser', () => {
    const current = classifyAvCurrentSample({ receipt: handcrafted, timebase: TIMEBASE })
    expect(current.status).toBe('red')
    expect(current.reason).toMatch(/disagrees with its own operands/i)
    expect(
      classifyAvPeakSample({ receipt: { ...handcrafted, kind: 'peak' }, timebase: TIMEBASE }).status
    ).toBe('red')
  })

  it('requires an exact timebase including the frame duration', () => {
    expect(
      classifyAvCurrentSample({ receipt: receipt(), timebase: { timescale: TIMESCALE } }).status
    ).toBe('red')
    expect(classifyAvCurrentSample({ receipt: receipt(), timebase: undefined }).status).toBe('red')
  })

  it('refuses an errms that disagrees with the error at the given timebase', () => {
    const verdict = classifyAvCurrentSample({
      receipt: receipt({ errTicks: msToTicks(10) }),
      timebase: { timescale: 60000, frameDurationTicks: 2000 }
    })
    expect(verdict.status).toBe('red')
    expect(verdict.reason).toMatch(/errms/i)
  })

  it('refuses an explanation these operands could not have produced', () => {
    const impossible = receipt({ errTicks: msToTicks(100), expl: 'explained' })
    expect(classifyAvCurrentSample({ receipt: impossible, timebase: TIMEBASE }).reason).toMatch(
      /explanation/i
    )
  })
})

describe('a PEAK is not a CURRENT sample', () => {
  it('honours the asymmetric BT.1359 tolerances', () => {
    expect(AUDIO_DELAYED_TOLERANCE_MS).toBe(125)
    expect(AUDIO_ADVANCED_TOLERANCE_MS).toBe(45)
    expect(
      classifyAvCurrentSample({
        receipt: receipt({ errTicks: msToTicks(120) }),
        timebase: TIMEBASE
      }).status
    ).toBe('green')
    expect(
      classifyAvCurrentSample({
        receipt: receipt({ errTicks: -msToTicks(120), winNs: 1_000_000 }),
        timebase: TIMEBASE
      }).status
    ).toBe('red')
  })

  // THE BOARD SHAPE, EXACTLY: a large explained peak alongside a healthy
  // current reading. Conflating them would either fail the run or hide drift.
  it('retains a -1088.5ms explained peak as a diagnostic while current stays Green', () => {
    const peak = classifyAvPeakSample({
      receipt: peakReceipt({ errTicks: msToTicks(-1088.5), winNs: 1_100_000_000 }),
      timebase: TIMEBASE
    })
    expect(peak.kind).toBe('peak')
    expect(peak.status).toBe('explained-diagnostic')
    expect(peak.status).not.toBe('red')
    expect(peak.status).not.toBe('green')

    const current = classifyAvCurrentSample({
      receipt: receipt({ errTicks: msToTicks(-15) }),
      timebase: TIMEBASE
    })
    expect(current.kind).toBe('current')
    expect(current.status).toBe('green')
  })

  // A RETAINED PEAK MUST NEVER SATISFY A CURRENT SLOT.
  it('refuses a peak-tagged receipt in a current slot and vice versa', () => {
    const asCurrent = classifyAvCurrentSample({
      receipt: peakReceipt({ errTicks: 0 }),
      timebase: TIMEBASE
    })
    expect(asCurrent.status).toBe('red')
    expect(asCurrent.reason).toMatch(/cannot stand in for a live reading/i)

    const asPeak = classifyAvPeakSample({ receipt: receipt({ errTicks: 0 }), timebase: TIMEBASE })
    expect(asPeak.status).toBe('red')
    expect(asPeak.reason).toMatch(/requires a "peak" receipt/i)
  })

  it('reds an out-of-bound peak that nothing explains', () => {
    expect(
      classifyAvPeakSample({
        receipt: peakReceipt({ errTicks: msToTicks(-1088.5), winNs: 1_000_000 }),
        timebase: TIMEBASE
      }).status
    ).toBe('red')
    expect(
      classifyAvPeakSample({
        receipt: peakReceipt({ errTicks: msToTicks(-1088.5), winNs: null }),
        timebase: TIMEBASE
      }).status
    ).toBe('red')
  })

  // A ten-second gap between the two clock reads cannot prove instantaneous
  // sync no matter how small the resulting error looks.
  it('refuses a CURRENT sample whose read window is wider than one frame', () => {
    const wide = classifyAvCurrentSample({
      receipt: receipt({ errTicks: 0, winNs: 10_000_000_000 }),
      timebase: TIMEBASE
    })
    expect(wide.status).toBe('red')
    expect(wide.reason).toMatch(/not simultaneous/i)

    // One frame of quantisation is the boundary; just inside it is fine.
    expect(
      classifyAvCurrentSample({
        receipt: receipt({ errTicks: 0, winNs: 33_000_000 }),
        timebase: TIMEBASE
      }).status
    ).toBe('green')
    // Just outside is not.
    expect(
      classifyAvCurrentSample({
        receipt: receipt({ errTicks: 0, winNs: 34_000_000 }),
        timebase: TIMEBASE
      }).status
    ).toBe('red')
  })

  // The PEAK keeps its separate semantics: it is allowed to describe a stall.
  it('still allows a WIDE window on a peak, which is what explains a stall', () => {
    expect(
      classifyAvPeakSample({
        receipt: peakReceipt({ errTicks: msToTicks(-1088.5), winNs: 1_100_000_000 }),
        timebase: TIMEBASE
      }).status
    ).toBe('explained-diagnostic')
  })

  it('never lets an explanation excuse a CURRENT out-of-bound error', () => {
    const explainedButOut = classifyAvCurrentSample({
      receipt: receipt({ errTicks: msToTicks(-300), winNs: 400_000_000 }),
      timebase: TIMEBASE
    })
    expect(explainedButOut.status).toBe('red')
  })

  it('reds an undrawn sample and a current sample with no measurement window', () => {
    expect(
      classifyAvCurrentSample({ receipt: receipt({ drawn: false }), timebase: TIMEBASE }).reason
    ).toMatch(/not drawn/i)
    expect(
      classifyAvCurrentSample({ receipt: receipt({ winNs: null }), timebase: TIMEBASE }).reason
    ).toMatch(/window/i)
  })
})

describe('the Swift measurement driver exposes exact dual-clock and route receipts', () => {
  it('reads peak and current in one bounded AX snapshot and fails closed on CoreAudio status', async () => {
    const driver = await fsPromises.readFile(
      path.resolve(__dirname, 'studio-acceptance-ui-driver.swift'),
      'utf8'
    )

    expect(driver).toContain('func exactAccessibilityAvSync(')
    expect(driver).toContain('let avSyncPeakAccessibilityLabel = "A/V sync detail"')
    expect(driver).toContain('let avSyncCurrentAccessibilityLabel = "A/V sync current detail"')
    expect(driver).toContain('peakMatches.count == 1')
    expect(driver).toContain('currentMatches.count == 1')
    expect(driver).toContain('peakValue.hasPrefix("av1 ")')
    expect(driver).toContain('currentValue.hasPrefix("avc1 ")')
    expect(driver).toContain('action.type == "read-av-sync"')
    expect(driver).toContain('avSyncPeakValue: observed.peakValue')
    expect(driver).toContain('avSyncCurrentValue: observed.currentValue')

    expect(driver).toContain('struct CoreAudioRouteHealthReceipt: Codable')
    expect(driver).toContain('func coreAudioRouteHealthReceipt() throws')
    expect(driver).toContain('kAudioDevicePropertyDeviceIsAlive')
    expect(driver).toContain('kAudioDevicePropertyDeviceIsRunningSomewhere')
    expect(driver).toContain('kAudioDevicePropertyStreams')
    expect(driver).toContain('kAudioStreamPropertyVirtualFormat')
    expect(driver).toContain('kAudioDevicePropertyMute')
    expect(driver).toContain('kAudioDevicePropertyVolumeScalar')
    expect(driver.match(/guard status == noErr else/g)).toHaveLength(5)
    expect(driver).toContain('muteSupported: mute.supported')
    expect(driver).toContain('volumeSupported: volume.supported')
    expect(driver).toContain('action.type == "coreaudio-route-health"')
    expect(driver).toContain('routeHealth: routeHealth')
  })
})

describe('audibility evidence is never allowed to overclaim', () => {
  const probe = (overrides = {}) => ({
    durationSeconds: 3,
    elapsedSeconds: 3.01,
    sampleBufferCount: 140,
    frameCount: 144_000,
    sampleValueCount: 288_000,
    sampleRate: 48000,
    channelCount: 2,
    rms: 0.21,
    peak: 0.8,
    nonSilentFraction: 0.97,
    defaultOutputDevice: {
      id: 71,
      name: 'MacBook Pro Speakers',
      uid: 'uid-1',
      nominalSampleRate: 48000
    },
    ...overrides
  })
  const silenceProbe = (overrides = {}) =>
    probe({ rms: 0.0001, peak: 0.002, nonSilentFraction: 0, ...overrides })
  const route = (overrides = {}) => ({
    id: 71,
    name: 'MacBook Pro Speakers',
    uid: 'uid-1',
    nominalSampleRate: 48000,
    alive: true,
    running: true,
    hasOutputStream: true,
    outputChannelCount: 2,
    muteSupported: true,
    muted: false,
    volumeSupported: true,
    volume: 0.75,
    ...overrides
  })
  const complete = (overrides = {}) =>
    classifyAudioEvidence({
      windowAudio: probe(),
      silenceWindow: silenceProbe(),
      routeHealth: route(),
      priorRouteHealth: route(),
      ...overrides
    })

  it('reports physical audibility as BLOCKED even when every available signal is perfect', () => {
    const verdict = complete()
    expect(verdict.physicalAudibility).toBe('blocked')
    expect(verdict.missingProof).toMatch(/sink|post-mix|metering/i)
    expect(verdict.status).not.toBe('green')
    expect(verdict.windowEmission).toBe('proven')
    expect(verdict.intentionalSilence).toBe('proven')
    expect(verdict.routeState).toBe('healthy')
  })

  it('requires a complete AudioProbeReceipt, not three floating metrics', () => {
    expect(complete({ windowAudio: { rms: 0.2, peak: 0.5, nonSilentFraction: 1 } }).status).toBe(
      'red'
    )
    expect(complete({ windowAudio: probe({ frameCount: 0 }) }).status).toBe('red')
    expect(complete({ windowAudio: probe({ sampleRate: 0 }) }).status).toBe('red')
    expect(complete({ windowAudio: probe({ elapsedSeconds: 0 }) }).status).toBe('red')
    // A peak below its own RMS is physically impossible.
    expect(complete({ windowAudio: probe({ rms: 0.9, peak: 0.1 }) }).status).toBe('red')
  })

  // 600 seconds of capture cannot happen in a tenth of a second.
  it('refuses an AudioProbe whose elapsed time cannot contain its duration', () => {
    expect(
      complete({ windowAudio: probe({ durationSeconds: 600, elapsedSeconds: 0.1 }) }).status
    ).toBe('red')
    expect(
      complete({ silenceWindow: silenceProbe({ durationSeconds: 2, elapsedSeconds: 0.1 }) }).status
    ).toBe('red')
    // And an implausibly long capture is refused too.
    expect(
      complete({ windowAudio: probe({ durationSeconds: 3, elapsedSeconds: 300 }) }).status
    ).toBe('red')
  })

  it('is red when a quiet AVERAGE hides a loud transient or a busy fraction', () => {
    expect(complete({ silenceWindow: silenceProbe({ peak: 0.9 }) }).intentionalSilence).toBe(
      'violated'
    )
    expect(
      complete({ silenceWindow: silenceProbe({ nonSilentFraction: 0.6 }) }).intentionalSilence
    ).toBe('violated')
  })

  it('refuses a probe whose sample-count algebra is impossible', () => {
    expect(complete({ windowAudio: probe({ sampleValueCount: 1 }) }).status).toBe('red')
  })

  // 600 seconds "captured" by a single frame is an absent capture, not a quiet one.
  it('refuses a 600s request backed by one frame of audio', () => {
    expect(
      complete({
        windowAudio: probe({
          durationSeconds: 600,
          elapsedSeconds: 600.1,
          sampleBufferCount: 1,
          frameCount: 1,
          sampleValueCount: 2,
          channelCount: 2
        })
      }).status
    ).toBe('red')
  })

  it('requires the embedded device receipt and links it to the checked route', () => {
    const { defaultOutputDevice, ...noDevice } = probe()
    expect(complete({ windowAudio: noDevice }).status).toBe('red')
    expect(
      complete({
        windowAudio: probe({
          defaultOutputDevice: { id: 99, name: 'Other', uid: 'uid-9', nominalSampleRate: 48000 }
        })
      }).status
    ).toBe('red')
    expect(
      complete({
        silenceWindow: silenceProbe({
          defaultOutputDevice: {
            id: 71,
            name: 'MacBook Pro Speakers',
            uid: 'uid-1',
            nominalSampleRate: 44100
          }
        })
      }).status
    ).toBe('red')
  })

  it('is red when the positive window carried no signal', () => {
    expect(complete({ windowAudio: silenceProbe() }).windowEmission).toBe('absent')
  })

  it('never infers route support from a missing field', () => {
    const { muteSupported, ...noMuteFlag } = route()
    expect(complete({ routeHealth: noMuteFlag }).routeState).toBe('unknown')
    const { volumeSupported, ...noVolumeFlag } = route()
    expect(complete({ routeHealth: noVolumeFlag }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ muteSupported: false }) }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ volumeSupported: false }) }).routeState).toBe('unknown')
  })

  it('never treats a muted, zero-volume, dead or unidentified route as healthy', () => {
    expect(complete({ routeHealth: route({ muted: true }) }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ volume: 0 }) }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ alive: false }) }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ outputChannelCount: 0 }) }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ uid: '' }) }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ id: 0 }) }).routeState).toBe('unknown')
    expect(complete({ routeHealth: route({ nominalSampleRate: 0 }) }).routeState).toBe('unknown')
  })

  it('validates the PRIOR route receipt in full, not just the current one', () => {
    expect(complete({ priorRouteHealth: undefined }).routeState).toBe('unknown')
    expect(complete({ priorRouteHealth: { id: 71, uid: 'uid-1' } }).routeState).toBe('unknown')
    expect(complete({ priorRouteHealth: route({ muted: true }) }).routeState).toBe('unknown')
  })

  it('is red when the output device identity or rate changed mid-run', () => {
    expect(complete({ priorRouteHealth: route({ uid: 'uid-2' }) }).routeState).toBe('changed')
    expect(complete({ priorRouteHealth: route({ nominalSampleRate: 44100 }) }).routeState).toBe(
      'changed'
    )
  })
})

describe('resource bounds derive from the accepted contract', () => {
  const surfaces = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i)
  const steady = (mutate: (r: Record<string, unknown>, i: number) => void = () => {}) =>
    Array.from({ length: SAMPLE_COUNT }, (_, i) => {
      const reading: Record<string, unknown> = {
        footprintBytes: 400_000_000 + (i % 2) * 1_000_000,
        mallocInUseBytes: 100_000_000 + (i % 2) * 500_000,
        residentBytes: 500_000_000 + (i % 2) * 1_000_000,
        residentDecoderCount: 1,
        liveIoSurfaceIds: surfaces(12)
      }
      mutate(reading, i)
      return reading
    })
  const classify = (readings: unknown, extra = {}) =>
    classifyResourceGrowth({ readings, droppedFrames: 0, ioSurfaceCapacity: 24, ...extra })

  it('uses the accepted fixed budget and does not scale it by run length', () => {
    expect(FOOTPRINT_GROWTH_BUDGET_MB).toBe(24)
    expect(classify(steady()).status).toBe('green')
  })

  it('requires exactly one aligned reading per sample', () => {
    expect(classify(steady().slice(0, 20)).status).toBe('red')
    expect(classify([]).status).toBe('red')
    expect(classify(undefined).status).toBe('red')
  })

  it('is red past the accepted budget on footprint, malloc or resident', () => {
    const over = (field: string) =>
      classify(
        steady((r, i) => {
          if (i === SAMPLE_COUNT - 1) {
            r[field] = (r[field] as number) + (FOOTPRINT_GROWTH_BUDGET_MB + 1) * 1_048_576
          }
        })
      )
    expect(over('footprintBytes').failures.join(' ')).toMatch(/footprint/i)
    expect(over('mallocInUseBytes').failures.join(' ')).toMatch(/malloc/i)
    expect(over('residentBytes').failures.join(' ')).toMatch(/resident/i)
  })

  it('is red on a leak SHAPE that stays inside the total budget', () => {
    const creeping = steady((r, i) => {
      r.footprintBytes = 400_000_000 + i * 200_000
    })
    expect(classify(creeping).failures.join(' ')).toMatch(/every sample/i)
  })

  // Swift's rule is THREE accumulating samples, which is TWO transitions.
  it('is red after [1] -> [1,2] -> [1,2,3], exactly two strict-superset transitions', () => {
    const accumulating = steady((r, i) => {
      r.liveIoSurfaceIds = surfaces(12 + Math.min(i, 2))
    })
    expect(classify(accumulating).failures.join(' ')).toMatch(/IOSurface/i)

    // One transition alone must NOT trip it, or the rule is over-strict.
    const single = steady((r, i) => {
      r.liveIoSurfaceIds = surfaces(i === 0 ? 12 : 13)
    })
    expect(classify(single).status).toBe('green')
  })

  it('bounds the PEAK decoder count, not just the endpoint', () => {
    // Spikes to 9 mid-run and returns to 1: an endpoint check sees nothing.
    const spike = steady((r, i) => {
      if (i === 10) r.residentDecoderCount = 9
    })
    expect(classify(spike).failures.join(' ')).toMatch(/decoder/i)
  })

  it('is red on malformed, duplicate or out-of-range IOSurface identities', () => {
    expect(
      classify(
        steady((r, i) => {
          if (i === 1) r.liveIoSurfaceIds = [MAX_IO_SURFACE_ID + 1]
        })
      ).status
    ).toBe('red')
    expect(
      classify(
        steady((r, i) => {
          if (i === 1) r.liveIoSurfaceIds = [5, 5]
        })
      ).status
    ).toBe('red')
    expect(
      classify(
        steady((r, i) => {
          if (i === 1) r.liveIoSurfaceIds = []
        })
      ).status
    ).toBe('red')
  })

  it('is red on non-finite readings, a missing capacity, or dropped frames', () => {
    expect(
      classify(
        steady((r, i) => {
          if (i === 1) r.footprintBytes = Number.NaN
        })
      ).status
    ).toBe('red')
    expect(classify(steady(), { ioSurfaceCapacity: undefined }).status).toBe('red')
    expect(classify(steady(), { droppedFrames: undefined }).status).toBe('red')
    expect(classify(steady(), { droppedFrames: 3 }).status).toBe('red')
    expect(
      classify(
        steady((r, i) => {
          if (i === 2) r.liveIoSurfaceIds = surfaces(40)
        })
      ).failures.join(' ')
    ).toMatch(/capacity/i)
  })
})

describe('the terminal verdict reclassifies RAW evidence', () => {
  const run = () => goodRun()
  const aligned = (i: number, extra: Record<string, unknown>) => ({
    sampleIndex: i,
    monotonicMs: run()[i].monotonicMs,
    ...extra
  })
  const currentReceipts = () =>
    Array.from({ length: SAMPLE_COUNT }, (_, i) =>
      aligned(i, {
        receipt: receipt({ errTicks: msToTicks(-1.2), winNs: 1_000_000 }),
        timebase: TIMEBASE
      })
    )
  const peakReceipts = () =>
    Array.from({ length: SAMPLE_COUNT }, (_, i) =>
      aligned(i, {
        receipt: peakReceipt({ errTicks: msToTicks(-20), winNs: 1_000_000 }),
        timebase: TIMEBASE
      })
    )
  const device = { id: 71, name: 'Speakers', uid: 'uid-1', nominalSampleRate: 48000 }
  const audioProbe = (overrides = {}) => ({
    durationSeconds: 3,
    elapsedSeconds: 3.01,
    sampleBufferCount: 140,
    frameCount: 144_000,
    sampleValueCount: 288_000,
    sampleRate: 48000,
    channelCount: 2,
    rms: 0.21,
    peak: 0.8,
    nonSilentFraction: 0.97,
    defaultOutputDevice: device,
    ...overrides
  })
  const routeReceipt = (overrides = {}) => ({
    ...device,
    alive: true,
    running: true,
    hasOutputStream: true,
    outputChannelCount: 2,
    muteSupported: true,
    muted: false,
    volumeSupported: true,
    volume: 0.75,
    ...overrides
  })
  const rawResources = () => ({
    readings: Array.from({ length: SAMPLE_COUNT }, (_, i) =>
      aligned(i, {
        footprintBytes: 400_000_000 + (i % 2) * 1_000_000,
        mallocInUseBytes: 100_000_000 + (i % 2) * 500_000,
        residentBytes: 500_000_000 + (i % 2) * 1_000_000,
        residentDecoderCount: 1,
        liveIoSurfaceIds: Array.from({ length: 12 }, (_, k) => 1000 + k)
      })
    ),
    droppedFrames: 0,
    ioSurfaceCapacity: 24
  })
  const timebasePlan = () =>
    Array.from({ length: SAMPLE_COUNT }, (_, i) => ({
      sampleIndex: i,
      timescale: TIMESCALE,
      frameDurationTicks: FRAME_DURATION_TICKS
    }))
  const base = () => ({
    samples: run(),
    timebasePlan: timebasePlan(),
    currentSamples: currentReceipts(),
    peakSamples: peakReceipts(),
    audio: {
      windowAudio: audioProbe(),
      silenceWindow: audioProbe({ rms: 0.0001, peak: 0.002, nonSilentFraction: 0 }),
      routeHealth: routeReceipt(),
      priorRouteHealth: routeReceipt()
    },
    resources: rawResources()
  })

  it('returns blocked — never green — on complete, sound RAW evidence', () => {
    const verdict = summarizeOutcome5(base())
    expect(verdict.status).toBe('blocked')
    expect(verdict.failures).toEqual([])
    expect(verdict.blockers.join(' ')).toMatch(/cannot reach Green/i)
    expect(verdict.evidence.avVerdicts).toHaveLength(SAMPLE_COUNT)
    expect(verdict.evidence.peakVerdicts).toHaveLength(SAMPLE_COUNT)
    expect(verdict.evidence.timebasePlan.ok).toBe(true)
    expect(verdict.evidence.audio.physicalAudibility).toBe('blocked')
  })

  // PEAK EVIDENCE IS REQUIRED. Omitting it used to produce a clean blocked,
  // silently dropping half of what Outcome 5 asks for.
  it('is red when peak evidence is absent, miscounted, or unexplained-bad', () => {
    const { peakSamples, ...noPeaks } = base()
    expect(summarizeOutcome5(noPeaks).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), peakSamples: peakReceipts().slice(0, 20) }).status).toBe(
      'red'
    )
    const badPeaks = base()
    badPeaks.peakSamples = Array.from({ length: SAMPLE_COUNT }, (_, i) =>
      aligned(i, {
        receipt: peakReceipt({ errTicks: msToTicks(300), winNs: 1_000_000 }),
        timebase: TIMEBASE
      })
    )
    const verdict = summarizeOutcome5(badPeaks)
    expect(verdict.status).toBe('red')
    expect(verdict.failures.join(' ')).toMatch(/peak A\/V/i)
  })

  it('retains a large EXPLAINED peak without failing the run', () => {
    const explained = base()
    explained.peakSamples = Array.from({ length: SAMPLE_COUNT }, (_, i) =>
      aligned(i, {
        receipt: peakReceipt({ errTicks: msToTicks(-1088.5), winNs: 1_100_000_000 }),
        timebase: TIMEBASE
      })
    )
    const verdict = summarizeOutcome5(explained)
    expect(verdict.status).toBe('blocked')
    expect(verdict.evidence.peakVerdicts[0].status).toBe('explained-diagnostic')
  })

  // Length is not twenty-one observations.
  it('is red when a stream is not cross-aligned to the sample plan', () => {
    const dup = base()
    dup.currentSamples = Array.from({ length: SAMPLE_COUNT }, () => currentReceipts()[0])
    expect(summarizeOutcome5(dup).status).toBe('red')

    const wrongTime = base()
    wrongTime.peakSamples[9] = { ...wrongTime.peakSamples[9], monotonicMs: 12345 }
    expect(summarizeOutcome5(wrongTime).failures.join(' ')).toMatch(/observed at/i)

    const wrongIndex = base()
    wrongIndex.resources.readings[4] = { ...wrongIndex.resources.readings[4], sampleIndex: 17 }
    expect(summarizeOutcome5(wrongIndex).failures.join(' ')).toMatch(/sampleIndex/i)
  })

  it('is red for placeholder A/V verdicts even when all other evidence is real', () => {
    const verdict = summarizeOutcome5({
      ...base(),
      currentSamples: Array.from({ length: SAMPLE_COUNT }, (_, i) =>
        aligned(i, { kind: 'current', status: 'green', errorMilliseconds: 0 })
      )
    })
    expect(verdict.status).toBe('red')
    expect(verdict.failures.join(' ')).toMatch(/current A\/V/i)
  })

  it('refuses a peak-tagged receipt sitting in the current stream', () => {
    const swapped = base()
    swapped.currentSamples = Array.from({ length: SAMPLE_COUNT }, (_, i) =>
      aligned(i, {
        receipt: peakReceipt({ errTicks: msToTicks(-1.2), winNs: 1_000_000 }),
        timebase: TIMEBASE
      })
    )
    const verdict = summarizeOutcome5(swapped)
    expect(verdict.status).toBe('red')
    expect(verdict.failures.join(' ')).toMatch(/cannot stand in for a live reading/i)
  })

  // ONE SAMPLE CANNOT INHABIT TWO TIMEBASES. The same 6,000-tick error reads
  // 6ms Green at timescale 1,000,000 and 200ms Red at the real 30,000, so
  // letting each stream pick its own denominator decides the verdict.
  it('is red when current and peak evidence use different timebases for one sample', () => {
    const divergent = base()
    const forgivingTimebase = { timescale: 1_000_000, frameDurationTicks: 33_333 }
    divergent.currentSamples[6] = aligned(6, {
      receipt: receipt({ errTicks: 6_000, winNs: 33_000_000 }),
      timebase: forgivingTimebase
    })
    const verdict = summarizeOutcome5(divergent)
    expect(verdict.status).toBe('red')
    expect(verdict.failures.join(' ')).toMatch(/timebase/i)
    expect(verdict.failures.join(' ')).toMatch(/authoritative plan/i)
  })

  it('is red without an authoritative timebase plan, or with an unsafe one', () => {
    const { timebasePlan: _omitted, ...noPlan } = base()
    expect(summarizeOutcome5(noPlan).failures.join(' ')).toMatch(/timebase plan/i)
    expect(summarizeOutcome5({ ...base(), timebasePlan: timebasePlan().slice(0, 20) }).status).toBe(
      'red'
    )
    const unsafe = base()
    unsafe.timebasePlan[3] = { sampleIndex: 3, timescale: 0, frameDurationTicks: 1000 }
    expect(summarizeOutcome5(unsafe).failures.join(' ')).toMatch(/timescale/i)
    const misindexed = base()
    misindexed.timebasePlan[5] = { ...misindexed.timebasePlan[5], sampleIndex: 19 }
    expect(summarizeOutcome5(misindexed).status).toBe('red')
  })

  // Equality between two absent names is not a match.
  it('is red when every device name is absent, even though the identities compare equal', () => {
    const nameless = base()
    const stripName = (o: Record<string, unknown>) => {
      const copy = { ...o }
      delete copy.name
      return copy
    }
    nameless.audio = {
      windowAudio: { ...audioProbe(), defaultOutputDevice: stripName(device) },
      silenceWindow: {
        ...audioProbe({ rms: 0.0001, peak: 0.002, nonSilentFraction: 0 }),
        defaultOutputDevice: stripName(device)
      },
      routeHealth: stripName(routeReceipt()),
      priorRouteHealth: stripName(routeReceipt())
    }
    const verdict = summarizeOutcome5(nameless)
    expect(verdict.status).toBe('red')
    // Asserted SEPARATELY on purpose. Both layers must object in their own
    // right: with a single generic assertion, dropping either check still reds
    // because the other one covers for it, and neither is actually proven.
    expect(verdict.failures.join(' ')).toMatch(/current device name is empty/i)
    expect(verdict.failures.join(' ')).toMatch(/prior device name is empty/i)
    expect(verdict.failures.join(' ')).toMatch(/embedded device name is empty/i)
  })

  it('cannot be unlocked by a forged physicalAudibility on the input', () => {
    const forged = base()
    ;(forged.audio as Record<string, unknown>).physicalAudibility = 'proven'
    const verdict = summarizeOutcome5(forged)
    expect(verdict.status).toBe('blocked')
    expect(verdict.evidence.audio.physicalAudibility).toBe('blocked')
    expect(verdict.status).not.toBe('green')
  })

  it('reclassifies a bad current receipt even when it looks complete', () => {
    const bad = base()
    bad.currentSamples[7] = aligned(7, {
      receipt: receipt({ errTicks: msToTicks(-300), winNs: 400_000_000 }),
      timebase: TIMEBASE
    })
    expect(summarizeOutcome5(bad).status).toBe('red')
  })

  it('is red for missing, miscounted or absent raw evidence', () => {
    expect(summarizeOutcome5({ ...base(), currentSamples: [] }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), currentSamples: undefined }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), audio: undefined }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), resources: undefined }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), samples: goodRun().slice(0, 20) }).status).toBe('red')
  })

  it('is red when the raw sequence was not a ten-minute run', () => {
    const compressed = base()
    compressed.samples = goodRun().map((s, i) => ({
      ...s,
      actualElapsedMs: i * 6_000,
      monotonicMs: 1_000_000 + i * 6_000
    }))
    expect(summarizeOutcome5(compressed).status).toBe('red')
  })
})
