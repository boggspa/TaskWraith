import { describe, expect, it } from 'vitest'
import { buildEnsembleUsageRecord, type EnsembleUsageInput } from './ensembleUsageRecord'

function base(stats: Record<string, unknown> | undefined): EnsembleUsageInput {
  return {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    workspaceId: 'ws-1',
    chatId: 'chat-1',
    runId: 'run-1',
    stats
  }
}

describe('buildEnsembleUsageRecord', () => {
  it('extracts canonical snake_case token + duration fields', () => {
    const rec = buildEnsembleUsageRecord(
      base({ input_tokens: 100, output_tokens: 40, total_tokens: 140, duration_ms: 5000 })
    )
    expect(rec).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.3-codex',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      runId: 'run-1',
      usageKind: 'run',
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      durationMs: 5000
    })
  })

  it('falls back to camelCase token keys', () => {
    const rec = buildEnsembleUsageRecord(base({ inputTokens: 10, outputTokens: 5, durationMs: 1200 }))
    expect(rec).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, durationMs: 1200 })
  })

  it('persists cache breakdown without double-counting cache-inclusive input', () => {
    const rec = buildEnsembleUsageRecord(
      base({
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 10,
        _taskwraith_input_includes_cache: true
      })
    )
    expect(rec).toMatchObject({
      inputTokens: 20,
      cacheReadInputTokens: 70,
      cacheCreationInputTokens: 10,
      outputTokens: 40,
      totalTokens: 140
    })
  })

  it('recognizes provider cache aliases and keeps separately-reported input intact', () => {
    const rec = buildEnsembleUsageRecord(
      base({ inputTokens: 12, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 3 })
    )
    expect(rec).toMatchObject({
      inputTokens: 12,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 3,
      outputTokens: 5,
      totalTokens: 50
    })
  })

  it('treats Codex cachedInputTokens as a subset of reported input', () => {
    const rec = buildEnsembleUsageRecord(
      base({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 })
    )
    expect(rec).toMatchObject({
      inputTokens: 20,
      cacheReadInputTokens: 80,
      outputTokens: 5,
      totalTokens: 105
    })
  })

  it('derives total from input+output when total is absent', () => {
    const rec = buildEnsembleUsageRecord(base({ input_tokens: 30, output_tokens: 20, duration_ms: 100 }))
    expect(rec?.totalTokens).toBe(50)
  })

  it('uses the wall-clock fallback when stats carry no duration', () => {
    const rec = buildEnsembleUsageRecord({
      ...base({ total_tokens: 12 }),
      fallbackDurationMs: 8000
    })
    expect(rec?.durationMs).toBe(8000)
  })

  it('prefers stats duration over the fallback', () => {
    const rec = buildEnsembleUsageRecord({
      ...base({ total_tokens: 12, duration_ms: 3000 }),
      fallbackDurationMs: 8000
    })
    expect(rec?.durationMs).toBe(3000)
  })

  it('returns null when usage was already recorded upstream (dedup)', () => {
    expect(
      buildEnsembleUsageRecord(base({ total_tokens: 100, duration_ms: 5000, _taskwraith_usage_recorded: true }))
    ).toBeNull()
  })

  it('returns null for a run with no tokens AND no duration', () => {
    expect(buildEnsembleUsageRecord(base({}))).toBeNull()
    expect(buildEnsembleUsageRecord(base(undefined))).toBeNull()
  })

  it('records a duration-only run (tokens absent but time spent)', () => {
    const rec = buildEnsembleUsageRecord(base({ duration_ms: 4000 }))
    expect(rec).not.toBeNull()
    expect(rec).toMatchObject({ totalTokens: 0, durationMs: 4000 })
  })

  it('includes token limits only when present + positive', () => {
    const withLimits = buildEnsembleUsageRecord(
      base({ total_tokens: 100, duration_ms: 10, total_tokens_limit: 400000 })
    )
    expect(withLimits).toHaveProperty('totalTokenLimit', 400000)
    const without = buildEnsembleUsageRecord(base({ total_tokens: 100, duration_ms: 10 }))
    expect(without).not.toHaveProperty('totalTokenLimit')
  })

  it('copies content-free ensemble prompt telemetry when provided', () => {
    const rec = buildEnsembleUsageRecord({
      ...base({ total_tokens: 12, duration_ms: 10 }),
      ensemblePromptKind: 'slim',
      ensembleDynamicStateBlockChars: 742,
      ensembleDynamicStateSent: false,
      ensembleDynamicStateReceiptState: 'matched'
    })

    expect(rec).toMatchObject({
      ensemblePromptKind: 'slim',
      ensembleDynamicStateBlockChars: 742,
      ensembleDynamicStateSent: false,
      ensembleDynamicStateReceiptState: 'matched'
    })
  })

  it('omits ensemble prompt telemetry when no accepted-dispatch snapshot is supplied', () => {
    const rec = buildEnsembleUsageRecord(base({ total_tokens: 12, duration_ms: 10 }))

    expect(rec).not.toHaveProperty('ensemblePromptKind')
    expect(rec).not.toHaveProperty('ensembleDynamicStateBlockChars')
    expect(rec).not.toHaveProperty('ensembleDynamicStateSent')
    expect(rec).not.toHaveProperty('ensembleDynamicStateReceiptState')
  })

  it('defaults a missing model to "unknown"', () => {
    const rec = buildEnsembleUsageRecord({ ...base({ total_tokens: 5, duration_ms: 5 }), model: '' })
    expect(rec?.model).toBe('unknown')
  })
})
