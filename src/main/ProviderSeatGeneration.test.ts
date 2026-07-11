import { describe, expect, it } from 'vitest'
import {
  planProviderSeatGeneration,
  providerSeatCanPrewarm,
  recordProviderSeatCacheEvidence
} from './ProviderSeatGeneration'
import type { PromptCacheCapability } from './store/types'

function input(provider: 'claude' | 'codex' | 'kimi' | 'ollama' = 'claude') {
  return {
    provider,
    model: provider === 'claude' ? 'claude-sonnet-4-7' : `${provider}-model`,
    transport: provider === 'ollama' ? ('local' as const) : ('cli-opaque' as const),
    guaranteeTier:
      provider === 'codex'
        ? ('automatic-observed' as const)
        : provider === 'ollama'
          ? ('unsupported' as const)
          : ('best-effort' as const),
    systemPromptFingerprint: 'system-v1',
    toolsFingerprint: 'tools-v1',
    taskWraithMcpProfileId: 'taskwraith-gateway-v1' as const,
    thinkingMode: 'on',
    reasoningEffort: 'high',
    serviceTier: 'standard'
  }
}

describe('ProviderSeatGeneration', () => {
  it('creates an initial continuity generation without claiming a cache hit', () => {
    const transition = planProviderSeatGeneration(undefined, input(), '2026-07-11T12:00:00.000Z')

    expect(transition).toMatchObject({
      freshSessionRequired: true,
      cacheImpact: 'full',
      causes: ['initial'],
      generation: { ordinal: 1, guaranteeTier: 'best-effort' }
    })
    expect(transition.generation.cacheEvidence).toBeUndefined()
  })

  it('rotates on model or tool/profile changes and preserves the old generation record', () => {
    const first = planProviderSeatGeneration(undefined, input()).generation
    const next = planProviderSeatGeneration(first, {
      ...input(),
      model: 'claude-opus-4-7',
      toolsFingerprint: 'tools-v2'
    })

    expect(next).toMatchObject({
      freshSessionRequired: true,
      cacheImpact: 'full',
      causes: ['model', 'tools'],
      generation: { ordinal: 2 }
    })
    expect(next.generation.id).not.toBe(first.id)
    expect(first.ordinal).toBe(1)
  })

  it('models Claude system and thinking invalidation by cache tier', () => {
    const first = planProviderSeatGeneration(undefined, input()).generation
    const system = planProviderSeatGeneration(first, {
      ...input(),
      systemPromptFingerprint: 'system-v2'
    })
    expect(system).toMatchObject({
      freshSessionRequired: true,
      cacheImpact: 'partial',
      causes: ['system'],
      preservedCacheTiers: ['tools']
    })

    const thinking = planProviderSeatGeneration(first, {
      ...input(),
      thinkingMode: 'off'
    })
    expect(thinking).toMatchObject({
      freshSessionRequired: false,
      cacheImpact: 'partial',
      causes: ['thinking'],
      preservedCacheTiers: ['tools', 'system']
    })
    expect(thinking.generation.id).toBe(first.id)
  })

  it('does not cold-cycle Claude or Codex continuity for effort-only changes', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const firstInput = input(provider)
      const first = planProviderSeatGeneration(undefined, firstInput).generation
      const next = planProviderSeatGeneration(first, {
        ...firstInput,
        reasoningEffort: 'low'
      })

      expect(next.freshSessionRequired).toBe(false)
      expect(next.cacheImpact).toBe('none')
      expect(next.causes).toEqual(['effort'])
      expect(next.generation.id).toBe(first.id)
    }
  })

  it('keeps opaque-provider uncertainty explicit instead of calling it warm', () => {
    const kimi = input('kimi')
    const first = planProviderSeatGeneration(undefined, kimi).generation
    const next = planProviderSeatGeneration(first, { ...kimi, reasoningEffort: 'low' })

    expect(next).toMatchObject({
      freshSessionRequired: false,
      cacheImpact: 'unknown',
      causes: ['effort'],
      preservedCacheTiers: []
    })
  })

  it('records reported cache hits/writes/misses and ignores absent telemetry', () => {
    const generation = planProviderSeatGeneration(undefined, input('codex')).generation
    expect(
      recordProviderSeatCacheEvidence(generation, { cached_input_tokens: 42 }, { runId: 'run-1' })
        .cacheEvidence
    ).toMatchObject({
      state: 'observed_hit',
      runId: 'run-1',
      cacheReadInputTokens: 42,
      guaranteeTier: 'automatic-observed'
    })
    expect(
      recordProviderSeatCacheEvidence(generation, { cacheWriteTokens: 7 }).cacheEvidence
    ).toMatchObject({ state: 'observed_write', cacheCreationInputTokens: 7 })
    expect(
      recordProviderSeatCacheEvidence(generation, { cached_input_tokens: 0 }).cacheEvidence
    ).toMatchObject({ state: 'observed_miss' })
    expect(recordProviderSeatCacheEvidence(generation, { inputTokens: 10 })).toBe(generation)
    const observed = recordProviderSeatCacheEvidence(generation, { cached_input_tokens: 42 })
    expect(recordProviderSeatCacheEvidence(observed, { inputTokens: 10 }).cacheEvidence).toEqual(
      observed.cacheEvidence
    )
  })

  it('keeps unsupported local cache semantics separate from continuity rotation', () => {
    const local = input('ollama')
    const first = planProviderSeatGeneration(undefined, local).generation
    const next = planProviderSeatGeneration(first, { ...local, model: 'ollama-model-2' })

    expect(next).toMatchObject({
      freshSessionRequired: true,
      cacheImpact: 'unsupported',
      causes: ['model'],
      preservedCacheTiers: []
    })
  })

  it('permits prewarming only for controllable guaranteed API transports', () => {
    const capability = {
      provider: 'claude',
      label: 'Claude',
      transport: 'api-byok',
      guaranteeTier: 'guaranteed',
      guaranteeLabel: 'Guaranteed',
      detail: 'test',
      defaultMode: 'explicit',
      controllable: true,
      supportsModeControl: true
    } satisfies PromptCacheCapability

    expect(providerSeatCanPrewarm(capability)).toBe(true)
    expect(providerSeatCanPrewarm({ ...capability, transport: 'cli-opaque' })).toBe(false)
    expect(providerSeatCanPrewarm({ ...capability, controllable: false })).toBe(false)
    expect(
      providerSeatCanPrewarm({ ...capability, guaranteeTier: 'automatic-observed' })
    ).toBe(false)
  })
})
