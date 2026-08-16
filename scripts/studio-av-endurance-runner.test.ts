import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  AUDIO_ADVANCED_TOLERANCE_MS,
  AUDIO_DELAYED_TOLERANCE_MS,
  FOOTPRINT_GROWTH_BUDGET_MB,
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
const msToTicks = (ms: number) => Math.round((ms / 1000) * TIMESCALE)

function av1(overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    pf: '600000',
    ap: '600000',
    err: '0',
    errms: '0.000',
    win: '1000000',
    winms: '1.000',
    drawn: '1',
    expl: 'explained',
    ...overrides
  }
  return `av1 ${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`
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

describe('outcome 5 sample plan', () => {
  it('spans at least the required ten minutes with the exact declared sample count', () => {
    const plan = planSamples({ startedAtMs: 1_000 })
    expect(plan).toHaveLength(SAMPLE_COUNT)
    expect(SAMPLE_COUNT).toBe(21)

    const spanSeconds = (plan[plan.length - 1].plannedElapsedMs - plan[0].plannedElapsedMs) / 1000
    // The mission is a TEN MINUTE endurance claim. A plan that spans less than
    // that cannot support it no matter how many samples it contains.
    expect(spanSeconds).toBeGreaterThanOrEqual(MIN_ELAPSED_SECONDS)
    expect(plan[0].plannedElapsedMs).toBe(0)
  })

  it('holds the nominal cadence between the first and last sample', () => {
    const plan = planSamples({ startedAtMs: 0 })
    for (let i = 1; i < plan.length; i += 1) {
      const gapSeconds = (plan[i].plannedElapsedMs - plan[i - 1].plannedElapsedMs) / 1000
      expect(gapSeconds).toBe(NOMINAL_CADENCE_SECONDS)
    }
  })
})

describe('sample sequence integrity', () => {
  const goodRun = () => Array.from({ length: SAMPLE_COUNT }, (_, i) => plannedSample(i))

  it('accepts a complete, ordered, full-duration run', () => {
    const verdict = validateSampleSequence(goodRun())
    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
  })

  it('refuses a run that did not actually last ten minutes', () => {
    // Every sample present and ordered, but compressed into two minutes. This
    // is the shape a "fast" run would take, and it must not read as endurance.
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
    const verdict = validateSampleSequence(goodRun().slice(0, SAMPLE_COUNT - 1))
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/expected 21/i)
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

  it('refuses a clock that runs backwards between samples', () => {
    const backwards = goodRun()
    backwards[10] = { ...backwards[10], monotonicMs: backwards[9].monotonicMs - 1 }
    const verdict = validateSampleSequence(backwards)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.join(' ')).toMatch(/monotonic/i)
  })
})

describe('av1 receipt parsing fails closed', () => {
  it('parses the authoritative export shape', () => {
    const parsed = parseAvSyncExport(av1())
    expect(parsed.ok).toBe(true)
    expect(parsed.presentedFrameTicks).toBe(600000)
    expect(parsed.audioPositionTicks).toBe(600000)
    expect(parsed.wasDrawn).toBe(true)
    expect(parsed.explanation).toBe('explained')
  })

  it('keeps an absent measurement window absent instead of turning it into zero', () => {
    // A zero window would parse as "both clocks were read together" — the
    // strongest possible claim and the exact opposite of what absence means.
    const parsed = parseAvSyncExport(av1({ win: '-', winms: '-' }))
    expect(parsed.ok).toBe(true)
    expect(parsed.measurementWindowNanoseconds).toBeNull()
    expect(parsed.measurementWindowNanoseconds).not.toBe(0)
  })

  it('refuses an unknown schema rather than mis-keying a later format', () => {
    expect(parseAvSyncExport('av2 pf=1 ap=1').ok).toBe(false)
    expect(parseAvSyncExport('').ok).toBe(false)
    expect(parseAvSyncExport(av1({ pf: 'nonsense' })).ok).toBe(false)
  })

  it('refuses a receipt that is missing any operand', () => {
    expect(parseAvSyncExport('av1 pf=1 ap=1 err=0').ok).toBe(false)
  })
})

describe('A/V classification uses the operands, not the headline number', () => {
  const base = { timescale: TIMESCALE }

  it('honours the asymmetric BT.1359 tolerances in both directions', () => {
    expect(AUDIO_DELAYED_TOLERANCE_MS).toBe(125)
    expect(AUDIO_ADVANCED_TOLERANCE_MS).toBe(45)

    // Picture ahead of sound (audio delayed) is the LOOSER direction.
    const delayed = classifyAvSample({
      ...base,
      parsed: parseAvSyncExport(av1({ err: String(msToTicks(120)), errms: '120.000' }))
    })
    expect(delayed.withinTolerance).toBe(true)

    // The same magnitude in the other direction is NOT acceptable. A symmetric
    // window is the widely-made mistake this asserts against.
    const advanced = classifyAvSample({
      ...base,
      parsed: parseAvSyncExport(av1({ err: String(-msToTicks(120)), errms: '-120.000' }))
    })
    expect(advanced.withinTolerance).toBe(false)
    expect(advanced.status).toBe('red')
  })

  it('treats an undrawn sample as evidence about nothing', () => {
    const undrawn = classifyAvSample({
      ...base,
      parsed: parseAvSyncExport(av1({ drawn: '0' }))
    })
    expect(undrawn.status).not.toBe('green')
    expect(undrawn.reason).toMatch(/not drawn/i)
  })

  it('refuses a sample whose window is absent, because the operands may be a cross-read', () => {
    const noWindow = classifyAvSample({
      ...base,
      parsed: parseAvSyncExport(av1({ win: '-', winms: '-', expl: 'unknown' }))
    })
    expect(noWindow.status).not.toBe('green')
    expect(noWindow.reason).toMatch(/window/i)
  })

  it('does not let a measurement-window explanation excuse a real out-of-bound error', () => {
    // An explained outlier is still an outlier if the CURRENT error is out of
    // bound: explanation covers the peak, never the live reading.
    const explainedButOut = classifyAvSample({
      ...base,
      parsed: parseAvSyncExport(av1({ err: String(-msToTicks(300)), errms: '-300.000' }))
    })
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

  it('reports physical audibility as BLOCKED even when every available signal is perfect', () => {
    const verdict = classifyAudioEvidence({
      windowAudio: positive,
      silenceWindow: silence,
      routeHealth: route
    })
    // This is the whole point of the gate. Window audio proves the Studio
    // window emitted samples. Route health proves the sink is configured. NEITHER
    // proves a speaker moved air, and no post-mix/sink-energy seam exists.
    expect(verdict.physicalAudibility).toBe('blocked')
    expect(verdict.missingProof).toMatch(/sink|post-mix|metering/i)
    expect(verdict.status).not.toBe('green')
  })

  it('names what it DID prove, separately, so the blocked verdict is still useful', () => {
    const verdict = classifyAudioEvidence({
      windowAudio: positive,
      silenceWindow: silence,
      routeHealth: route
    })
    expect(verdict.windowEmission).toBe('proven')
    expect(verdict.routeState).toBe('healthy')
    expect(verdict.intentionalSilence).toBe('proven')
  })

  it('is red when the intentional-silence window is not actually silent', () => {
    // Without this, a stuck meter reading "signal" forever would pass the
    // positive test and prove nothing at all.
    const verdict = classifyAudioEvidence({
      windowAudio: positive,
      silenceWindow: positive,
      routeHealth: route
    })
    expect(verdict.intentionalSilence).toBe('violated')
    expect(verdict.status).toBe('red')
  })

  it('is red when the positive window carried no signal', () => {
    const verdict = classifyAudioEvidence({
      windowAudio: silence,
      silenceWindow: silence,
      routeHealth: route
    })
    expect(verdict.windowEmission).toBe('absent')
    expect(verdict.status).toBe('red')
  })

  it('never treats a muted or unsupported route as green', () => {
    expect(
      classifyAudioEvidence({
        windowAudio: positive,
        silenceWindow: silence,
        routeHealth: { ...route, muted: true }
      }).routeState
    ).toBe('muted')

    const unsupported = classifyAudioEvidence({
      windowAudio: positive,
      silenceWindow: silence,
      routeHealth: { ...route, muted: null }
    })
    expect(unsupported.routeState).toBe('unknown')
    expect(unsupported.status).not.toBe('green')
  })

  it('is red when the output device identity changed mid-run', () => {
    const verdict = classifyAudioEvidence({
      windowAudio: positive,
      silenceWindow: silence,
      routeHealth: route,
      priorRouteHealth: { ...route, deviceUid: 'uid-2' }
    })
    expect(verdict.status).toBe('red')
    expect(verdict.routeState).toBe('changed')
  })
})

describe('resource bounds derive from the accepted contract', () => {
  it('uses the accepted fixed allocation-class budget and does not scale it by run length', () => {
    // StudioStressTests.swift:197 fixes growthBudgetMB at 24 for looped
    // playback, and trend.isStable takes an ABSOLUTE byte budget rather than a
    // per-cycle one. A leak scales with work, so scaling the budget with work
    // would hide exactly what a ten-minute run exists to catch. Inheriting the
    // accepted number is derivation; picking a roomier one would be invention.
    expect(FOOTPRINT_GROWTH_BUDGET_MB).toBe(24)
  })

  it('accepts growth inside the declared allocation-class limits', () => {
    const verdict = classifyResourceGrowth({
      first: { footprintBytes: 400_000_000, ioSurfaceCount: 12, residentDecoderCount: 1 },
      last: { footprintBytes: 420_000_000, ioSurfaceCount: 13, residentDecoderCount: 1 },
      droppedFrames: 0
    })
    expect(verdict.status).toBe('green')
  })

  it('is red just past the accepted budget, not merely at wild values', () => {
    const justOver = classifyResourceGrowth({
      first: { footprintBytes: 400_000_000, ioSurfaceCount: 12, residentDecoderCount: 1 },
      last: {
        footprintBytes: 400_000_000 + (FOOTPRINT_GROWTH_BUDGET_MB + 1) * 1_048_576,
        ioSurfaceCount: 12,
        residentDecoderCount: 1
      },
      droppedFrames: 0
    })
    expect(justOver.status).toBe('red')
  })

  it('is red on unbounded footprint growth across the run', () => {
    const verdict = classifyResourceGrowth({
      first: { footprintBytes: 400_000_000, ioSurfaceCount: 12, residentDecoderCount: 1 },
      last: { footprintBytes: 1_400_000_000, ioSurfaceCount: 12, residentDecoderCount: 1 },
      droppedFrames: 0
    })
    expect(verdict.status).toBe('red')
    expect(verdict.failures.join(' ')).toMatch(/footprint/i)
  })

  it('is red when decoders accumulate, which is the leak shape this arc has seen', () => {
    const verdict = classifyResourceGrowth({
      first: { footprintBytes: 400_000_000, ioSurfaceCount: 12, residentDecoderCount: 1 },
      last: { footprintBytes: 405_000_000, ioSurfaceCount: 12, residentDecoderCount: 9 },
      droppedFrames: 0
    })
    expect(verdict.status).toBe('red')
    expect(verdict.failures.join(' ')).toMatch(/decoder/i)
  })
})

describe('terminal verdict', () => {
  const green = {
    sequence: { ok: true, failures: [] },
    avSamples: [{ status: 'green' }, { status: 'green' }],
    audio: { status: 'blocked', physicalAudibility: 'blocked' },
    resources: { status: 'green', failures: [] }
  }

  it('cannot be green while physical audibility is blocked', () => {
    const verdict = summarizeOutcome5(green)
    expect(verdict.status).toBe('blocked')
    expect(verdict.blockers.join(' ')).toMatch(/audib/i)
  })

  it('is red — not blocked — when something actually failed', () => {
    // A real failure must not be laundered into the softer "blocked" verdict.
    const verdict = summarizeOutcome5({
      ...green,
      avSamples: [{ status: 'green' }, { status: 'red', reason: 'error out of bound' }]
    })
    expect(verdict.status).toBe('red')
  })

  it('is red when the sequence itself was not a ten-minute run', () => {
    const verdict = summarizeOutcome5({
      ...green,
      sequence: { ok: false, failures: ['under-duration'] }
    })
    expect(verdict.status).toBe('red')
  })
})
