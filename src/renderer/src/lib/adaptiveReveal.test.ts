import { describe, expect, it } from 'vitest'
import {
  ADAPTIVE_REVEAL_TERMINAL_DRAIN_MS,
  advanceAdaptiveReveal,
  commonGraphemePrefixLength,
  createAdaptiveRevealState,
  createRevealCadenceTracker,
  observeRevealTarget,
  resolveAdaptiveRevealPresentation,
  revealCadenceSnapshot,
  type AdaptiveRevealState,
  type RevealCadence
} from './adaptiveReveal'
import {
  readRevealCadencePrior,
  recordRevealCadencePrior,
  resetRevealCadenceRegistryForTest
} from './revealCadenceRegistry'

const STEADY: RevealCadence = {
  sourceCharsPerSec: 105,
  averageChunkChars: 7,
  averageGapMs: 65,
  jitterMs: 8,
  sampleCount: 8
}

function driveFor(
  target: string,
  hz: number,
  seconds: number,
  cadence: RevealCadence = STEADY,
  initial: AdaptiveRevealState = createAdaptiveRevealState()
): AdaptiveRevealState {
  let state = initial
  const dt = 1 / hz
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += dt) {
    state = advanceAdaptiveReveal({ state, target, cadence, dt, isComplete: false })
  }
  return state
}

describe('adaptive reveal cadence observation', () => {
  it('learns renderer-visible source rate without counting cumulative rewrites', () => {
    let tracker = createRevealCadenceTracker(0)
    tracker = observeRevealTarget(tracker, 10, 100)
    tracker = observeRevealTarget(tracker, 20, 200)
    tracker = observeRevealTarget(tracker, 35, 300)
    const learned = revealCadenceSnapshot(tracker)

    expect(learned.sampleCount).toBe(2)
    expect(learned.sourceCharsPerSec).toBeGreaterThan(80)
    expect(learned.averageChunkChars).toBeGreaterThan(8)

    const rewritten = observeRevealTarget(tracker, 12, 350)
    expect(rewritten.sampleCount).toBe(learned.sampleCount)
    expect(rewritten.sourceCharsPerSec).toBe(learned.sourceCharsPerSec)
  })

  it('re-baselines an equal-length rewrite and does not count its restore as a burst', () => {
    let tracker = createRevealCadenceTracker(0)
    tracker = observeRevealTarget(tracker, 10, 100)
    tracker = observeRevealTarget(tracker, 20, 200)
    const beforeRewrite = revealCadenceSnapshot(tracker)

    tracker = observeRevealTarget(tracker, 20, 240, { appendOnly: false })
    tracker = observeRevealTarget(tracker, 30, 260)

    expect(tracker.sampleCount).toBe(beforeRewrite.sampleCount)
    expect(tracker.sourceCharsPerSec).toBe(beforeRewrite.sourceCharsPerSec)
    expect(tracker.rebaselineNextGrowth).toBe(false)
  })

  it('selects gentler/longer fades for slow streams and shorter fades for bursts', () => {
    const slow = resolveAdaptiveRevealPresentation({
      sourceCharsPerSec: 28,
      averageChunkChars: 3,
      averageGapMs: 130,
      jitterMs: 10,
      sampleCount: 5
    })
    const burst = resolveAdaptiveRevealPresentation({
      sourceCharsPerSec: 850,
      averageChunkChars: 140,
      averageGapMs: 250,
      jitterMs: 120,
      sampleCount: 5
    })

    expect(slow.band).toBe('slow')
    expect(burst.band).toBe('burst')
    expect(slow.fadeDurationMs).toBeGreaterThan(burst.fadeDurationMs)
    expect(slow.maxPaintFps).toBeLessThan(burst.maxPaintFps)
  })
})

describe('advanceAdaptiveReveal', () => {
  it('finds the grapheme-safe common prefix for cumulative rewrites', () => {
    expect(
      commonGraphemePrefixLength(
        Array.from(
          new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment('hello 👋 world')
        ).map((item) => item.segment),
        Array.from(
          new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment('hello 👋 there')
        ).map((item) => item.segment)
      )
    ).toBe(8)
  })

  it('is wall-clock stable across 30/60/120 Hz instead of forcing one char per frame', () => {
    const target = 'Adaptive streaming should feel identical on every refresh rate. '.repeat(80)
    const at30 = driveFor(target, 30, 0.8).revealed
    const at60 = driveFor(target, 60, 0.8).revealed
    const at120 = driveFor(target, 120, 0.8).revealed

    expect(Math.abs(at30 - at60)).toBeLessThanOrEqual(8)
    expect(Math.abs(at60 - at120)).toBeLessThanOrEqual(8)
    expect(at120).toBeLessThan(target.length)
  })

  it('preserves fractional credit and may hold a frame for a slow stream', () => {
    const slow: RevealCadence = {
      sourceCharsPerSec: 18,
      averageChunkChars: 2,
      averageGapMs: 140,
      jitterMs: 4,
      sampleCount: 6
    }
    const first = advanceAdaptiveReveal({
      state: createAdaptiveRevealState(),
      target: 'hello world',
      cadence: slow,
      dt: 1 / 120,
      isComplete: false
    })

    expect(first.revealed).toBe(0)
    expect(first.credit).toBeGreaterThan(0)
  })

  it('never hard-snaps a large live burst', () => {
    const target = 'x'.repeat(2_000)
    const first = advanceAdaptiveReveal({
      state: createAdaptiveRevealState(),
      target,
      cadence: {
        sourceCharsPerSec: 900,
        averageChunkChars: 500,
        averageGapMs: 250,
        jitterMs: 80,
        sampleCount: 4
      },
      dt: 1 / 60,
      isComplete: false
    })

    expect(first.revealed).toBeGreaterThan(0)
    expect(first.revealed).toBeLessThan(target.length)
  })

  it('drains all terminal backlog within the terminal SLA', () => {
    const target = 'Terminal backlog should settle without a one-frame slam. '.repeat(100)
    let state = createAdaptiveRevealState()
    const dt = 1 / 60
    const frames = Math.ceil((ADAPTIVE_REVEAL_TERMINAL_DRAIN_MS / 1_000) * 60) + 1
    for (let i = 0; i < frames; i++) {
      state = advanceAdaptiveReveal({ state, target, cadence: STEADY, dt, isComplete: true })
    }
    expect(state.revealed).toBe(Array.from(target).length)
  })

  it('never splits a grapheme cluster', () => {
    const target = `one 👨‍👩‍👧‍👦 two 🇬🇧 three é four`.repeat(30)
    let state = createAdaptiveRevealState()
    for (let i = 0; i < 120 && state.revealed < target.length; i++) {
      state = advanceAdaptiveReveal({
        state,
        target,
        cadence: STEADY,
        dt: 1 / 60,
        isComplete: false
      })
      const visible = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(target)
      )
        .slice(0, state.revealed)
        .map((item) => item.segment)
        .join('')
      expect(target.startsWith(visible)).toBe(true)
      expect((visible as { isWellFormed?: () => boolean }).isWellFormed?.() ?? true).toBe(true)
    }
  })
})

describe('provider/model cadence registry', () => {
  it('prefers exact-model history and falls back to provider history', () => {
    resetRevealCadenceRegistryForTest()
    const cadence: RevealCadence = {
      sourceCharsPerSec: 220,
      averageChunkChars: 18,
      averageGapMs: 45,
      jitterMs: 6,
      sampleCount: 10
    }
    recordRevealCadencePrior('codex', 'gpt-5.5', cadence)

    expect(readRevealCadencePrior('codex', 'gpt-5.5')?.sourceCharsPerSec).toBe(220)
    expect(readRevealCadencePrior('codex', 'new-model')?.sourceCharsPerSec).toBe(220)
    expect(readRevealCadencePrior('claude', 'gpt-5.5')).toBeUndefined()
  })

  it('blends repeated exact-model samples instead of replacing their history', () => {
    resetRevealCadenceRegistryForTest()
    recordRevealCadencePrior('codex', 'gpt-5.5', {
      sourceCharsPerSec: 100,
      averageChunkChars: 8,
      averageGapMs: 80,
      jitterMs: 4,
      sampleCount: 10
    })
    recordRevealCadencePrior('codex', 'gpt-5.5', {
      sourceCharsPerSec: 300,
      averageChunkChars: 24,
      averageGapMs: 30,
      jitterMs: 12,
      sampleCount: 10
    })

    const blended = readRevealCadencePrior('codex', 'gpt-5.5')
    expect(blended?.sourceCharsPerSec).toBeGreaterThan(100)
    expect(blended?.sourceCharsPerSec).toBeLessThan(300)
    expect(blended?.sampleCount).toBe(20)
  })
})
