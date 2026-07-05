import { describe, expect, it } from 'vitest'
import {
  buildStaticCacheCapabilityMatrix,
  CACHE_GUARANTEE_LABELS,
  guaranteeBadgeClass,
  summarizeCapabilitiesByProvider
} from './promptCacheUi'

describe('promptCacheUi', () => {
  it('builds a static capability matrix with honest guarantee labels', () => {
    const matrix = buildStaticCacheCapabilityMatrix()
    expect(matrix.length).toBeGreaterThan(0)
    expect(matrix.some((row) => row.provider === 'gemini')).toBe(false)
    expect(matrix.some((row) => row.provider === 'claude' && row.guaranteeTier === 'best-effort')).toBe(
      true
    )
    expect(matrix.some((row) => row.provider === 'codex' && row.guaranteeTier === 'automatic-observed')).toBe(
      true
    )
    expect(CACHE_GUARANTEE_LABELS.guaranteed).toBe('Guaranteed')
  })

  it('summarizes strongest tier per provider', () => {
    const summary = summarizeCapabilitiesByProvider(buildStaticCacheCapabilityMatrix())
    expect(summary.claude?.guaranteeTier).toBe('best-effort')
    expect(summary.kimi?.guaranteeTier).toBe('best-effort')
    expect(summary.codex?.guaranteeTier).toBe('automatic-observed')
    expect(summary.ollama?.guaranteeTier).toBe('unsupported')
  })

  it('maps guarantee tiers to badge classes', () => {
    expect(guaranteeBadgeClass('best-effort')).toBe(
      'prompt-cache-guarantee prompt-cache-guarantee--best-effort'
    )
  })
})