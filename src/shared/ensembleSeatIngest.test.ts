import { describe, expect, it } from 'vitest'
import {
  ENSEMBLE_INGEST_CHARS_PER_TOKEN,
  ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS,
  ENSEMBLE_INGEST_OVERRIDE_MAX_CHARS,
  ENSEMBLE_INGEST_OVERRIDE_MIN_CHARS,
  ENSEMBLE_INGEST_WINDOW_FRACTION,
  ENSEMBLE_SEAT_INGEST_MAX_CHARS,
  ENSEMBLE_SEAT_INGEST_MIN_CHARS,
  ensembleIngestOverrideEligible,
  ensembleIngestOverrideKey,
  parseParameterBillionsFromModelId,
  parseParameterSizeLabel,
  resolveEnsembleSeatIngestChars
} from './ensembleSeatIngest'

describe('parseParameterBillionsFromModelId', () => {
  it.each([
    ['qwen3:4b', 4],
    ['qwen3:4b-instruct', 4],
    ['gemma4:12b', 12],
    ['lfm2.5:8b', 8],
    ['rnj-1:8b', 8],
    ['devstral-small-2:24b', 24],
    ['mistral-medium-3.5:128b', 128],
    ['granite4.1:800m', 0.8],
    ['llama3.1:70b-instruct-q4_K_M', 70]
  ])('parses %s → %s billion', (id, billions) => {
    expect(parseParameterBillionsFromModelId(id)).toBe(billions)
  })

  it.each(['ornith', 'gpt-5.3-codex-spark', 'kimi-k3', 'grok-4.6', '', undefined, null])(
    'returns null for size-less id %s',
    (id) => {
      expect(parseParameterBillionsFromModelId(id as string | null | undefined)).toBeNull()
    }
  )
})

describe('parseParameterSizeLabel', () => {
  it('parses daemon-reported labels', () => {
    expect(parseParameterSizeLabel('8.2B')).toBe(8.2)
    expect(parseParameterSizeLabel('4B')).toBe(4)
    expect(parseParameterSizeLabel('780M')).toBe(0.78)
  })
  it('rejects junk', () => {
    expect(parseParameterSizeLabel('')).toBeNull()
    expect(parseParameterSizeLabel('big')).toBeNull()
    expect(parseParameterSizeLabel(null)).toBeNull()
  })
})

describe('ensembleIngestOverrideEligible', () => {
  it('offers the slider ONLY to Codex Spark and 4B–12B Ollama locals', () => {
    expect(
      ensembleIngestOverrideEligible({ provider: 'codex', modelId: 'gpt-5.3-codex-spark' })
    ).toBe(true)
    expect(ensembleIngestOverrideEligible({ provider: 'codex', modelId: 'gpt-5.5-codex' })).toBe(
      false
    )
    expect(ensembleIngestOverrideEligible({ provider: 'ollama', modelId: 'qwen3:4b' })).toBe(true)
    expect(ensembleIngestOverrideEligible({ provider: 'ollama', modelId: 'gemma4:12b' })).toBe(true)
    expect(
      ensembleIngestOverrideEligible({ provider: 'ollama', modelId: 'devstral-small-2:24b' })
    ).toBe(false)
    expect(ensembleIngestOverrideEligible({ provider: 'ollama', modelId: 'granite4.1:800m' })).toBe(
      false
    )
    // Size-less tag stays ineligible until the caller supplies measured data.
    expect(ensembleIngestOverrideEligible({ provider: 'ollama', modelId: 'ornith' })).toBe(false)
    expect(
      ensembleIngestOverrideEligible({
        provider: 'ollama',
        modelId: 'ornith',
        parameterBillions: 8.2
      })
    ).toBe(true)
    expect(ensembleIngestOverrideEligible({ provider: 'claude', modelId: 'claude-sonnet-5' })).toBe(
      false
    )
  })
})

describe('resolveEnsembleSeatIngestChars', () => {
  it('derives a window-scaled fraction for capable models', () => {
    const claude = resolveEnsembleSeatIngestChars({
      provider: 'claude',
      modelId: 'x',
      liveContextTokens: 200_000
    })
    // 200_000 × 0.14 × 3.5 — the FRACTION, not (window − reserves) × 3.5,
    // which would be 628_320 here.
    expect(claude).toMatchObject({
      chars: 98_000,
      source: 'window-derived',
      overrideEligible: false
    })

    const big = resolveEnsembleSeatIngestChars({
      provider: 'kimi',
      modelId: 'x',
      liveContextTokens: 1_048_576
    })
    expect(big.chars).toBe(513_802)
    expect(big.chars).toBeLessThanOrEqual(ENSEMBLE_SEAT_INGEST_MAX_CHARS)
  })

  it('keeps a Mistral seat clear of the measured reasoning-separation cliff', () => {
    // The reason this cap exists. Vibe stops separating reasoning at >=150K
    // prompt tokens on a single-turn reply, and the model's whole
    // chain-of-thought then arrives as its answer. Medium 3.5's 262_144-token
    // window funded ~845K chars under the old policy, which is how a
    // 194_964-token prompt was built.
    const seat = resolveEnsembleSeatIngestChars({
      provider: 'mistral',
      modelId: 'mistral-medium-3.5'
    })
    expect(seat.windowTokens).toBe(262_144)
    expect(seat.chars).toBe(128_450)
    // Pin the MARGIN, not just the number: the transcript must stay far below
    // the cliff even before the prompt shell and the seat's own output.
    expect(seat.chars / ENSEMBLE_INGEST_CHARS_PER_TOKEN).toBeLessThan(150_000)
    expect(seat.chars).toBeLessThan(200_000)
  })

  it('spends the same share of every window', () => {
    // Guards the fraction itself: a constant-valued cap would pass the two
    // cases above while breaking the smaller and larger windows between them.
    for (const windowTokens of [131_072, 200_000, 262_144, 400_000]) {
      const resolved = resolveEnsembleSeatIngestChars({
        provider: 'claude',
        modelId: 'x',
        liveContextTokens: windowTokens
      })
      expect(resolved.chars).toBe(
        Math.floor(windowTokens * ENSEMBLE_INGEST_WINDOW_FRACTION * ENSEMBLE_INGEST_CHARS_PER_TOKEN)
      )
    }
  })

  it('floors a tiny window at the minimum instead of going negative', () => {
    const tiny = resolveEnsembleSeatIngestChars({
      provider: 'ollama',
      modelId: 'devstral-small-2:24b',
      liveContextTokens: 8_192
    })
    expect(tiny.chars).toBe(ENSEMBLE_SEAT_INGEST_MIN_CHARS)
    expect(tiny.source).toBe('window-derived')
  })

  it('defaults the exception classes to 50K', () => {
    expect(
      resolveEnsembleSeatIngestChars({ provider: 'codex', modelId: 'gpt-5.3-codex-spark' })
    ).toMatchObject({
      chars: ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS,
      source: 'exception-default',
      overrideEligible: true
    })
    expect(
      resolveEnsembleSeatIngestChars({ provider: 'ollama', modelId: 'qwen3:4b' })
    ).toMatchObject({ chars: ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS, source: 'exception-default' })
  })

  it('honors a per-model override for eligible models, clamped to the slider range', () => {
    const key = ensembleIngestOverrideKey('ollama', 'qwen3:4b')
    expect(
      resolveEnsembleSeatIngestChars({
        provider: 'ollama',
        modelId: 'qwen3:4b',
        overrides: { [key]: 120_000 }
      })
    ).toMatchObject({ chars: 120_000, source: 'override' })
    expect(
      resolveEnsembleSeatIngestChars({
        provider: 'ollama',
        modelId: 'qwen3:4b',
        overrides: { [key]: 10_000_000 }
      }).chars
    ).toBe(ENSEMBLE_INGEST_OVERRIDE_MAX_CHARS)
    expect(
      resolveEnsembleSeatIngestChars({
        provider: 'ollama',
        modelId: 'qwen3:4b',
        overrides: { [key]: 1 }
      }).chars
    ).toBe(ENSEMBLE_INGEST_OVERRIDE_MIN_CHARS)
  })

  it('ignores overrides for ineligible models (they always get the window fraction)', () => {
    const resolved = resolveEnsembleSeatIngestChars({
      provider: 'claude',
      modelId: 'claude-opus-5',
      liveContextTokens: 200_000,
      overrides: { [ensembleIngestOverrideKey('claude', 'claude-opus-5')]: 12_000 }
    })
    expect(resolved.source).toBe('window-derived')
    expect(resolved.chars).toBe(98_000)
  })
})
