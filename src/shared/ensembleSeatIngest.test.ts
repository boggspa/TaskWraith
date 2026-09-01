import { describe, expect, it } from 'vitest'
import {
  ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS,
  ENSEMBLE_INGEST_OVERRIDE_MAX_CHARS,
  ENSEMBLE_INGEST_OVERRIDE_MIN_CHARS,
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
  it('derives a window-scaled maximum for capable models', () => {
    const claude = resolveEnsembleSeatIngestChars({
      provider: 'claude',
      modelId: 'x',
      liveContextTokens: 200_000
    })
    // (200_000 − 16_384 − 4_096) × 3.5
    expect(claude).toMatchObject({
      chars: 628_320,
      source: 'window-derived',
      overrideEligible: false
    })

    const big = resolveEnsembleSeatIngestChars({
      provider: 'kimi',
      modelId: 'x',
      liveContextTokens: 1_048_576
    })
    expect(big.chars).toBe(3_598_336)
    expect(big.chars).toBeLessThanOrEqual(ENSEMBLE_SEAT_INGEST_MAX_CHARS)
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

  it('ignores overrides for ineligible models (they always get the window maximum)', () => {
    const resolved = resolveEnsembleSeatIngestChars({
      provider: 'claude',
      modelId: 'claude-opus-5',
      liveContextTokens: 200_000,
      overrides: { [ensembleIngestOverrideKey('claude', 'claude-opus-5')]: 12_000 }
    })
    expect(resolved.source).toBe('window-derived')
    expect(resolved.chars).toBe(628_320)
  })
})
