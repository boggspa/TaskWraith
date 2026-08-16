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
  classifyAvSample,
  classifyResourceGrowth,
  parseAvSyncExport,
  planSamples,
  summarizeOutcome5,
  validateSampleSequence
} = require('./studio-av-endurance-runner.cjs')

/** 30fps in the product's own integer tick space. */
const TIMESCALE = 30000
const FRAME_DURATION_TICKS = 1000
const TIMEBASE = { timescale: TIMESCALE, frameDurationTicks: FRAME_DURATION_TICKS }
const msToTicks = (ms: number) => Math.round((ms / 1000) * TIMESCALE)

function deriveExplanation(errTicks: number, winNs: number | null): string {
  if (winNs === null) return 'unknown'
  const errMs = (errTicks / TIMESCALE) * 1000
  const quantisationMs = (FRAME_DURATION_TICKS / TIMESCALE) * 1000
  return errMs < 0 && -errMs <= winNs / 1_000_000 + quantisationMs ? 'explained' : 'not_explained'
}

/** Builds a SELF-CONSISTENT receipt, so a control must forge one deliberately. */
function av1({
  errTicks = 0,
  winNs = 1_000_000,
  drawn = 1,
  expl = null,
  pf = 600_000
}: {
  errTicks?: number
  winNs?: number | null
  drawn?: number
  expl?: string | null
  pf?: number
} = {}): string {
  const ap = pf - errTicks
  const errms = ((errTicks / TIMESCALE) * 1000).toFixed(3)
  const win = winNs === null ? '-' : String(winNs)
  const winms = winNs === null ? '-' : (winNs / 1_000_000).toFixed(3)
  const explanation = expl ?? deriveExplanation(errTicks, winNs)
  return (
    `av1 pf=${pf} ap=${ap} err=${errTicks} errms=${errms} ` +
    `win=${win} winms=${winms} drawn=${drawn} expl=${explanation}`
  )
}

function plannedSample(index: number, overrides: Record<string, unknown> = {}) {
  const plan = planSamples({ startedAtMs: 0 })[index]
  return {
    index,
    plannedElapsedMs: plan.plannedElapsedMs,
    actualElapsedMs: plan.plannedElapsedMs,
    monotonicMs: plan.plannedElapsedMs,
    ...overrides
  }
}
const goodRun = () => Array.from({ length: SAMPLE_COUNT }, (_, i) => plannedSample(i))

describe('outcome 5 sample plan', () => {
  it('spans at least the required ten minutes with the exact declared sample count', () => {
    const plan = planSamples({ startedAtMs: 1_000 })
    expect(plan).toHaveLength(SAMPLE_COUNT)
    expect(SAMPLE_COUNT).toBe(21)
    const spanSeconds = (plan[plan.length - 1].plannedElapsedMs - plan[0].plannedElapsedMs) / 1000
    expect(spanSeconds).toBeGreaterThanOrEqual(MIN_ELAPSED_SECONDS)
    expect(plan[0].plannedElapsedMs).toBe(0)
  })

  it('holds the nominal cadence between the first and last sample', () => {
    const plan = planSamples({ startedAtMs: 0 })
    for (let i = 1; i < plan.length; i += 1) {
      expect((plan[i].plannedElapsedMs - plan[i - 1].plannedElapsedMs) / 1000).toBe(
        NOMINAL_CADENCE_SECONDS
      )
    }
  })
})

describe('sample sequence integrity', () => {
  it('accepts a complete, ordered, full-duration run', () => {
    const verdict = validateSampleSequence(goodRun())
    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
  })

  it('refuses a run that did not actually last ten minutes', () => {
    const compressed = goodRun().map((s, i) => ({
      ...s,
      actualElapsedMs: i * 6_000,
      monotonicMs: i * 6_000
    }))
    const verdict = validateSampleSequence(compressed)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/under-duration/i)
  })

  it('refuses a short run even when the count is right', () => {
    expect(validateSampleSequence(goodRun().slice(0, SAMPLE_COUNT - 1)).failures.join(' ')).toMatch(
      /expected 21/i
    )
  })

  it('refuses duplicated and out-of-order samples', () => {
    const duplicated = goodRun()
    duplicated[5] = { ...duplicated[5], index: 4 }
    expect(validateSampleSequence(duplicated).failures.join(' ')).toMatch(/duplicate|order/i)

    const reordered = goodRun()
    const swap = reordered[7]
    reordered[7] = reordered[8]
    reordered[8] = swap
    expect(validateSampleSequence(reordered).failures.join(' ')).toMatch(/order/i)
  })

  it('refuses a clock that fails to advance between samples', () => {
    const backwards = goodRun()
    backwards[10] = { ...backwards[10], monotonicMs: backwards[9].monotonicMs - 1 }
    expect(validateSampleSequence(backwards).failures.join(' ')).toMatch(/monotonic/i)
  })

  // FALSE GREEN THE FIRST VERSION ACCEPTED: a sample with no timestamps at all
  // was skipped rather than refused, so an incomplete run read as complete.
  it('refuses a run whose LAST sample has no elapsed timestamp', () => {
    const missing = goodRun()
    delete (missing[SAMPLE_COUNT - 1] as Record<string, unknown>).actualElapsedMs
    const verdict = validateSampleSequence(missing)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/actualElapsedMs/i)
  })

  it('refuses a run with no monotonic timestamps anywhere', () => {
    const missing = goodRun().map((s) => {
      const copy = { ...s } as Record<string, unknown>
      delete copy.monotonicMs
      return copy
    })
    const verdict = validateSampleSequence(missing)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/monotonicMs/i)
  })

  it('refuses non-finite or negative timestamps', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const run = goodRun()
      run[3] = { ...run[3], actualElapsedMs: bad }
      expect(validateSampleSequence(run).ok).toBe(false)
    }
  })

  it('refuses a run that quietly departed from the declared cadence plan', () => {
    const drifted = goodRun()
    drifted[9] = { ...drifted[9], plannedElapsedMs: 999 }
    expect(validateSampleSequence(drifted).failures.join(' ')).toMatch(/plan/i)
  })

  it('refuses a non-integer sample index', () => {
    const fractional = goodRun()
    fractional[2] = { ...fractional[2], index: 2.5 }
    expect(validateSampleSequence(fractional).ok).toBe(false)
  })
})

describe('av1 receipt parsing recomputes rather than trusts', () => {
  it('parses a self-consistent export', () => {
    const parsed = parseAvSyncExport(av1())
    expect(parsed.ok).toBe(true)
    expect(parsed.presentedFrameTicks).toBe(600_000)
    expect(parsed.wasDrawn).toBe(true)
  })

  // THE EXACT FORGERY THE FIRST VERSION ACCEPTED AND CLASSIFIED GREEN.
  it('refuses a receipt whose err disagrees with its own operands', () => {
    const forged =
      'av1 pf=600000 ap=0 err=0 errms=0.000 win=1000000 winms=1.000 drawn=1 expl=not_explained'
    const parsed = parseAvSyncExport(forged)
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toMatch(/disagrees with its own operands/i)

    // And it must not survive classification either, at any layer.
    expect(classifyAvSample({ parsed, timebase: TIMEBASE }).status).toBe('red')
  })

  it('keeps an absent measurement window absent instead of turning it into zero', () => {
    const parsed = parseAvSyncExport(av1({ winNs: null }))
    expect(parsed.ok).toBe(true)
    expect(parsed.measurementWindowNanoseconds).toBeNull()
    expect(parsed.measurementWindowNanoseconds).not.toBe(0)
  })

  it('refuses a half-absent measurement window', () => {
    expect(
      parseAvSyncExport(
        'av1 pf=600000 ap=600000 err=0 errms=0.000 win=- winms=1.000 drawn=1 expl=unknown'
      ).ok
    ).toBe(false)
  })

  it('refuses a winms that disagrees with win', () => {
    expect(
      parseAvSyncExport(
        'av1 pf=600000 ap=600000 err=0 errms=0.000 win=1000000 winms=9.000 drawn=1 expl=not_explained'
      ).reason
    ).toMatch(/winms/i)
  })

  it('refuses a negative measurement window, which the product type cannot express', () => {
    expect(
      parseAvSyncExport(
        'av1 pf=600000 ap=600000 err=0 errms=0.000 win=-5 winms=-0.000 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
  })

  it('refuses unknown schemas, duplicate fields, unknown fields and unsafe integers', () => {
    expect(parseAvSyncExport('av2 pf=1 ap=1').ok).toBe(false)
    expect(parseAvSyncExport('').ok).toBe(false)
    expect(parseAvSyncExport(`${av1()} pf=1`).reason).toMatch(/duplicate/i)
    expect(parseAvSyncExport(`${av1()} extra=1`).reason).toMatch(/unknown field/i)
    // Built as a raw string on purpose: a JS number literal this large loses
    // precision before the parser could ever see it, which would make the
    // control assert nothing.
    expect(
      parseAvSyncExport(
        'av1 pf=9007199254740993 ap=1 err=9007199254740992 errms=0.000 ' +
          'win=1000000 winms=1.000 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
  })

  it('refuses milliseconds that are not the exported three-decimal form', () => {
    expect(
      parseAvSyncExport(
        'av1 pf=600000 ap=600000 err=0 errms=NaN win=1000000 winms=1.000 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
    expect(
      parseAvSyncExport(
        'av1 pf=600000 ap=600000 err=0 errms=0 win=1000000 winms=1.000 drawn=1 expl=not_explained'
      ).ok
    ).toBe(false)
  })

  it('refuses a receipt that is missing any operand', () => {
    expect(parseAvSyncExport('av1 pf=1 ap=1 err=0').ok).toBe(false)
  })
})

describe('A/V classification uses the operands, not the headline number', () => {
  it('honours the asymmetric BT.1359 tolerances in both directions', () => {
    expect(AUDIO_DELAYED_TOLERANCE_MS).toBe(125)
    expect(AUDIO_ADVANCED_TOLERANCE_MS).toBe(45)

    const delayed = classifyAvSample({
      parsed: parseAvSyncExport(av1({ errTicks: msToTicks(120) })),
      timebase: TIMEBASE
    })
    expect(delayed.withinTolerance).toBe(true)

    const advanced = classifyAvSample({
      parsed: parseAvSyncExport(av1({ errTicks: -msToTicks(120) })),
      timebase: TIMEBASE
    })
    expect(advanced.withinTolerance).toBe(false)
    expect(advanced.status).toBe('red')
  })

  it('requires an exact timebase including the frame duration', () => {
    const parsed = parseAvSyncExport(av1())
    expect(classifyAvSample({ parsed, timebase: { timescale: TIMESCALE } }).status).toBe('red')
    expect(classifyAvSample({ parsed, timebase: undefined }).status).toBe('red')
  })

  it('refuses an errms that disagrees with the error at the given timebase', () => {
    // Self-consistent at 30000, deliberately classified at 60000.
    const parsed = parseAvSyncExport(av1({ errTicks: msToTicks(10) }))
    const verdict = classifyAvSample({
      parsed,
      timebase: { timescale: 60000, frameDurationTicks: 2000 }
    })
    expect(verdict.status).toBe('red')
    expect(verdict.reason).toMatch(/errms/i)
  })

  it('refuses an explanation these operands could not have produced', () => {
    // Only a NEGATIVE error can be explained by the measurement window, because
    // the audio playhead is the operand read last.
    const impossible = parseAvSyncExport(av1({ errTicks: msToTicks(100), expl: 'explained' }))
    const verdict = classifyAvSample({ parsed: impossible, timebase: TIMEBASE })
    expect(verdict.status).toBe('red')
    expect(verdict.reason).toMatch(/explanation/i)
  })

  it('accepts a genuinely explained audio-advanced outlier as consistent', () => {
    // -20ms with a 1ms window and 33.3ms frame quantisation is explainable.
    const parsed = parseAvSyncExport(av1({ errTicks: -msToTicks(20) }))
    expect(parsed.explanation).toBe('explained')
    expect(classifyAvSample({ parsed, timebase: TIMEBASE }).status).toBe('green')
  })

  it('treats an undrawn sample as evidence about nothing', () => {
    const undrawn = classifyAvSample({
      parsed: parseAvSyncExport(av1({ drawn: 0 })),
      timebase: TIMEBASE
    })
    expect(undrawn.status).not.toBe('green')
    expect(undrawn.reason).toMatch(/not drawn/i)
  })

  it('refuses a sample whose window is absent, because the operands may be a cross-read', () => {
    const noWindow = classifyAvSample({
      parsed: parseAvSyncExport(av1({ winNs: null })),
      timebase: TIMEBASE
    })
    expect(noWindow.status).not.toBe('green')
    expect(noWindow.reason).toMatch(/window/i)
  })

  it('does not let an explanation excuse a real out-of-bound error', () => {
    const explainedButOut = classifyAvSample({
      parsed: parseAvSyncExport(av1({ errTicks: -msToTicks(300), winNs: 400_000_000 })),
      timebase: TIMEBASE
    })
    expect(explainedButOut.explanation).toBe('explained')
    expect(explainedButOut.status).toBe('red')
  })
})

describe('audibility evidence is never allowed to overclaim', () => {
  const positive = { rms: 0.21, peak: 0.8, nonSilentFraction: 0.97 }
  const silence = { rms: 0.0001, peak: 0.002, nonSilentFraction: 0.0 }
  const route = {
    deviceId: 'dev-1',
    deviceUid: 'uid-1',
    alive: true,
    running: true,
    hasOutputStream: true,
    outputChannelCount: 2,
    sampleRate: 48000,
    muted: false,
    volume: 0.75
  }
  const complete = (overrides = {}) =>
    classifyAudioEvidence({
      windowAudio: positive,
      silenceWindow: silence,
      routeHealth: route,
      priorRouteHealth: route,
      ...overrides
    })

  it('reports physical audibility as BLOCKED even when every available signal is perfect', () => {
    const verdict = complete()
    expect(verdict.physicalAudibility).toBe('blocked')
    expect(verdict.missingProof).toMatch(/sink|post-mix|metering/i)
    expect(verdict.status).not.toBe('green')
  })

  it('names what it DID prove, separately, so the blocked verdict is still useful', () => {
    const verdict = complete()
    expect(verdict.windowEmission).toBe('proven')
    expect(verdict.routeState).toBe('healthy')
    expect(verdict.intentionalSilence).toBe('proven')
  })

  it('is red when the intentional-silence window is not actually silent', () => {
    const verdict = complete({ silenceWindow: positive })
    expect(verdict.intentionalSilence).toBe('violated')
    expect(verdict.status).toBe('red')
  })

  it('is red when a quiet AVERAGE hides a loud transient or a busy fraction', () => {
    // RMS alone would pass both of these.
    expect(
      complete({ silenceWindow: { rms: 0.001, peak: 0.9, nonSilentFraction: 0 } })
        .intentionalSilence
    ).toBe('violated')
    expect(
      complete({ silenceWindow: { rms: 0.001, peak: 0.001, nonSilentFraction: 0.6 } })
        .intentionalSilence
    ).toBe('violated')
  })

  it('is red when the positive window carried no signal', () => {
    const verdict = complete({ windowAudio: silence })
    expect(verdict.windowEmission).toBe('absent')
    expect(verdict.status).toBe('red')
  })

  it('is red on incomplete or out-of-range audio receipts', () => {
    expect(complete({ windowAudio: { rms: 0.2, peak: 0.5 } }).windowEmission).toBe('unknown')
    expect(
      complete({ windowAudio: { rms: Number.NaN, peak: 0.5, nonSilentFraction: 1 } }).status
    ).toBe('red')
    expect(complete({ silenceWindow: { rms: -1, peak: 0, nonSilentFraction: 0 } }).status).toBe(
      'red'
    )
  })

  it('never treats a muted, zero-volume or unsupported route as healthy', () => {
    expect(complete({ routeHealth: { ...route, muted: true } }).routeState).toBe('muted')
    expect(complete({ routeHealth: { ...route, muted: null } }).routeState).toBe('unknown')
    expect(complete({ routeHealth: { ...route, volume: 0 } }).routeState).toBe('unknown')
    expect(complete({ routeHealth: { ...route, alive: false } }).routeState).toBe('unknown')
    expect(complete({ routeHealth: { ...route, outputChannelCount: 0 } }).routeState).toBe(
      'unknown'
    )
    expect(complete({ routeHealth: { ...route, deviceUid: '' } }).routeState).toBe('unknown')
    expect(complete({ routeHealth: { ...route, sampleRate: 0 } }).routeState).toBe('unknown')
  })

  it('cannot claim route stability without a prior reading to compare', () => {
    const verdict = complete({ priorRouteHealth: undefined })
    expect(verdict.routeState).toBe('unknown')
    expect(verdict.status).toBe('red')
  })

  it('is red when the output device identity or rate changed mid-run', () => {
    expect(complete({ priorRouteHealth: { ...route, deviceUid: 'uid-2' } }).routeState).toBe(
      'changed'
    )
    expect(complete({ priorRouteHealth: { ...route, sampleRate: 44100 } }).routeState).toBe(
      'changed'
    )
  })
})

describe('resource bounds derive from the accepted contract', () => {
  const surfaces = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i)
  const steady = (overrides: Array<Record<string, unknown>> = []) =>
    Array.from({ length: 5 }, (_, i) => ({
      footprintBytes: 400_000_000 + (i % 2) * 1_000_000,
      mallocBytes: 100_000_000 + (i % 2) * 500_000,
      residentDecoderCount: 1,
      liveIoSurfaceIds: surfaces(12),
      ...(overrides[i] || {})
    }))
  const classify = (readings: unknown, extra = {}) =>
    classifyResourceGrowth({ readings, droppedFrames: 0, ioSurfaceCapacity: 24, ...extra })

  it('uses the accepted fixed allocation-class budget and does not scale it by run length', () => {
    // StudioStressTests.swift:197 fixes growthBudgetMB at 24, and
    // trend.isStable takes an ABSOLUTE byte budget. A leak scales with work, so
    // scaling the budget with work would hide exactly what this run catches.
    expect(FOOTPRINT_GROWTH_BUDGET_MB).toBe(24)
  })

  it('accepts a stable aligned trend', () => {
    expect(classify(steady()).status).toBe('green')
  })

  it('is red just past the accepted footprint budget', () => {
    const readings = steady()
    readings[4] = {
      ...readings[4],
      footprintBytes: readings[0].footprintBytes + (FOOTPRINT_GROWTH_BUDGET_MB + 1) * 1_048_576
    }
    expect(classify(readings).failures.join(' ')).toMatch(/footprint/i)
  })

  it('is red on malloc growth even when the footprint is fine', () => {
    const readings = steady()
    readings[4] = {
      ...readings[4],
      mallocBytes: readings[0].mallocBytes + (FOOTPRINT_GROWTH_BUDGET_MB + 1) * 1_048_576
    }
    expect(classify(readings).failures.join(' ')).toMatch(/malloc/i)
  })

  it('is red on a leak SHAPE that stays inside the total budget', () => {
    // Grows every single sample, total only ~5MB. Endpoints alone cannot see
    // this, which is exactly why the trend is aligned rather than sampled twice.
    const creeping = steady().map((r, i) => ({ ...r, footprintBytes: 400_000_000 + i * 1_000_000 }))
    expect(classify(creeping).failures.join(' ')).toMatch(/every sample/i)
  })

  it('is red when live IOSurface identities strictly accumulate three times running', () => {
    const accumulating = steady().map((r, i) => ({ ...r, liveIoSurfaceIds: surfaces(12 + i) }))
    expect(classify(accumulating).failures.join(' ')).toMatch(/IOSurface/i)
  })

  it('is red when the live IOSurface set exceeds the declared renderer capacity', () => {
    const over = steady()
    over[2] = { ...over[2], liveIoSurfaceIds: surfaces(40) }
    expect(classify(over).failures.join(' ')).toMatch(/capacity/i)
  })

  it('is red without a declared capacity to compare against', () => {
    expect(classify(steady(), { ioSurfaceCapacity: undefined }).status).toBe('red')
  })

  it('is red when decoders accumulate, which is the leak shape this arc has seen', () => {
    const readings = steady()
    readings[4] = { ...readings[4], residentDecoderCount: 9 }
    expect(classify(readings).failures.join(' ')).toMatch(/decoder/i)
  })

  // FALSE GREEN THE FIRST VERSION ACCEPTED: inputs with no numeric operands.
  it('is red on empty, short, malformed or non-finite resource evidence', () => {
    expect(classify([]).status).toBe('red')
    expect(classify(undefined).status).toBe('red')
    expect(classify([{}, {}]).status).toBe('red')
    const nan = steady()
    nan[1] = { ...nan[1], footprintBytes: Number.NaN }
    expect(classify(nan).status).toBe('red')
    const infinite = steady()
    infinite[1] = { ...infinite[1], mallocBytes: Number.POSITIVE_INFINITY }
    expect(classify(infinite).status).toBe('red')
  })

  it('is red on IOSurface identities outside the product UInt32 range', () => {
    const bad = steady()
    bad[1] = { ...bad[1], liveIoSurfaceIds: [MAX_IO_SURFACE_ID + 1] }
    expect(classify(bad).status).toBe('red')
    const negative = steady()
    negative[1] = { ...negative[1], liveIoSurfaceIds: [-1] }
    expect(classify(negative).status).toBe('red')
  })

  it('is red when droppedFrames is absent or non-zero', () => {
    expect(classify(steady(), { droppedFrames: undefined }).status).toBe('red')
    expect(classify(steady(), { droppedFrames: 3 }).status).toBe('red')
  })
})

describe('terminal verdict fails closed', () => {
  const greenSamples = () => Array.from({ length: SAMPLE_COUNT }, () => ({ status: 'green' }))
  const base = () => ({
    sequence: { ok: true, failures: [] },
    avSamples: greenSamples(),
    audio: { status: 'blocked', physicalAudibility: 'blocked', missingProof: 'no sink seam' },
    resources: { status: 'green', failures: [] }
  })

  it('cannot be green while physical audibility is blocked', () => {
    const verdict = summarizeOutcome5(base())
    expect(verdict.status).toBe('blocked')
    expect(verdict.blockers.join(' ')).toMatch(/audib/i)
  })

  it('is red — not blocked — when something actually failed', () => {
    const samples = greenSamples()
    samples[4] = { status: 'red', reason: 'error out of bound' }
    expect(summarizeOutcome5({ ...base(), avSamples: samples }).status).toBe('red')
  })

  it('is red when the sequence itself was not a ten-minute run', () => {
    expect(
      summarizeOutcome5({ ...base(), sequence: { ok: false, failures: ['under-duration'] } }).status
    ).toBe('red')
  })

  // FALSE GREENS THE FIRST VERSION SOFTENED INTO "blocked": absent evidence.
  it('is red — not blocked — for missing or miscounted A/V verdicts', () => {
    expect(summarizeOutcome5({ ...base(), avSamples: [] }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), avSamples: undefined }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), avSamples: greenSamples().slice(0, 20) }).status).toBe(
      'red'
    )
    expect(
      summarizeOutcome5({ ...base(), avSamples: [...greenSamples(), { status: 'green' }] }).status
    ).toBe('red')
  })

  it('is red for a sample carrying an unrecognised verdict', () => {
    const samples = greenSamples()
    samples[7] = { status: 'unknown' }
    expect(summarizeOutcome5({ ...base(), avSamples: samples }).status).toBe('red')
    const missing = greenSamples()
    missing[7] = undefined as never
    expect(summarizeOutcome5({ ...base(), avSamples: missing }).status).toBe('red')
  })

  it('is red for missing, malformed or unrecognised audio evidence', () => {
    expect(summarizeOutcome5({ ...base(), audio: undefined }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), audio: {} }).status).toBe('red')
    expect(
      summarizeOutcome5({
        ...base(),
        audio: { status: 'green', physicalAudibility: 'blocked' }
      }).status
    ).toBe('red')
  })

  it('is red for missing or unrecognised resource evidence', () => {
    expect(summarizeOutcome5({ ...base(), resources: undefined }).status).toBe('red')
    expect(summarizeOutcome5({ ...base(), resources: { status: 'blocked' } }).status).toBe('red')
  })
})
