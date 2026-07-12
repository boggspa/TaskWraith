import { describe, expect, it } from 'vitest'
import { resolveLiveTallyTokens } from './liveTallyTokens'

describe('resolveLiveTallyTokens', () => {
  it('shows only sealed base tokens when not running', () => {
    const result = resolveLiveTallyTokens({
      running: false,
      baseInputTokens: 5000,
      baseOutputTokens: 1200,
      estimatedOutputTokens: 999,
      snapshotInputTokens: 4000,
      snapshotOutputTokens: 800
    })
    expect(result).toEqual({
      inputTokens: 5000,
      outputTokensTarget: 1200,
      liveInputExtra: 0,
      liveOutputExtra: 0,
      authoritative: false
    })
  })

  it('falls back to the char estimate before any snapshot arrives', () => {
    const result = resolveLiveTallyTokens({
      running: true,
      baseInputTokens: 5000,
      baseOutputTokens: 1200,
      estimatedOutputTokens: 300,
      snapshotInputTokens: 0,
      snapshotOutputTokens: 0
    })
    expect(result.outputTokensTarget).toBe(1500) // 1200 + 300 estimate
    expect(result.inputTokens).toBe(5000) // no live input without a snapshot
    expect(result.liveOutputExtra).toBe(300)
    expect(result.authoritative).toBe(false)
  })

  it('prefers the authoritative snapshot output when it exceeds the estimate', () => {
    // The char estimate can only see visible text; a reasoning/tool-heavy turn
    // has far more real output than chars/4 implies.
    const result = resolveLiveTallyTokens({
      running: true,
      baseInputTokens: 5000,
      baseOutputTokens: 1200,
      estimatedOutputTokens: 300,
      snapshotInputTokens: 6400,
      snapshotOutputTokens: 4800
    })
    expect(result.outputTokensTarget).toBe(6000) // 1200 + 4800 authoritative
    expect(result.liveOutputExtra).toBe(4800)
    expect(result.authoritative).toBe(true)
  })

  it('adds the in-flight turn input from the snapshot (absent from base)', () => {
    const result = resolveLiveTallyTokens({
      running: true,
      baseInputTokens: 5000,
      baseOutputTokens: 1200,
      estimatedOutputTokens: 300,
      snapshotInputTokens: 6400,
      snapshotOutputTokens: 4800
    })
    expect(result.inputTokens).toBe(11400) // 5000 sealed + 6400 live
    expect(result.liveInputExtra).toBe(6400)
  })

  it('never drops below the text estimate when it leads (multi-lane / early turn)', () => {
    // A single active-run snapshot cannot cover a fan-out's aggregated text, so
    // the estimate must remain the floor and stay flagged as an estimate.
    const result = resolveLiveTallyTokens({
      running: true,
      baseInputTokens: 0,
      baseOutputTokens: 0,
      estimatedOutputTokens: 900,
      snapshotInputTokens: 1000,
      snapshotOutputTokens: 400
    })
    expect(result.outputTokensTarget).toBe(900) // estimate leads
    expect(result.liveOutputExtra).toBe(900)
    expect(result.authoritative).toBe(false)
    // Live input still rides the snapshot even when output is estimate-led.
    expect(result.inputTokens).toBe(1000)
  })

  it('treats a snapshot equal to the estimate as authoritative', () => {
    const result = resolveLiveTallyTokens({
      running: true,
      baseInputTokens: 0,
      baseOutputTokens: 0,
      estimatedOutputTokens: 500,
      snapshotOutputTokens: 500
    })
    expect(result.authoritative).toBe(true)
  })

  it('coerces malformed numbers to zero rather than NaN', () => {
    const result = resolveLiveTallyTokens({
      running: true,
      baseInputTokens: Number.NaN,
      baseOutputTokens: -50,
      estimatedOutputTokens: Number.POSITIVE_INFINITY,
      snapshotInputTokens: undefined,
      snapshotOutputTokens: undefined
    })
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokensTarget).toBe(0)
    expect(result.liveOutputExtra).toBe(0)
    expect(result.authoritative).toBe(false)
  })
})
