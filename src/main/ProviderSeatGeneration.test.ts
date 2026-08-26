import { describe, expect, it } from 'vitest'
import {
  fingerprintProviderSeatPrefix,
  planProviderSeatGeneration,
  planProviderSeatRuntime,
  providerSeatCanPrewarm,
  providerSeatPosturePrefixComponents,
  providerSeatRotationDropsContext,
  providerSeatRotationNoticeText,
  recordProviderSeatCacheEvidence,
  storedSeatSessionRotationRequired
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
  it('fingerprints stable prefix configuration without prompt content', () => {
    const first = fingerprintProviderSeatPrefix('system', ['v5', 'claude', 'default'])
    expect(fingerprintProviderSeatPrefix('system', ['v5', 'claude', 'default'])).toBe(first)
    expect(fingerprintProviderSeatPrefix('system', ['v5', 'claude', 'plan'])).not.toBe(first)
    expect(fingerprintProviderSeatPrefix('tools', ['taskwraith-gateway-v1'])).not.toBe(first)
  })

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

  it('rotates Kimi continuity when switching between the 1M and fixed-256K routes', () => {
    const longRoute = { ...input('kimi'), model: 'kimi-k3' }
    const previous = planProviderSeatGeneration(undefined, longRoute).generation
    const runtime = planProviderSeatRuntime(
      previous,
      { ...longRoute, model: 'kimi-k3-256k' },
      { linkedProviderSessionId: 'session-kimi-long' }
    )

    expect(runtime).toMatchObject({
      shouldRotateSession: true,
      transition: {
        freshSessionRequired: true,
        cacheImpact: 'full',
        causes: ['model'],
        generation: { ordinal: 2 }
      }
    })
  })

  it('models Claude system and thinking invalidation by cache tier', () => {
    const initial = planProviderSeatGeneration(undefined, input()).generation
    const first = recordProviderSeatCacheEvidence(initial, { cacheReadInputTokens: 12 })
    const system = planProviderSeatGeneration(first, {
      ...input(),
      systemPromptFingerprint: 'system-v2'
    })
    // A CLI session carries the whole conversation: system-prefix drift keeps
    // the session (no fresh-session rotation) and only re-tiers the cache.
    expect(system).toMatchObject({
      freshSessionRequired: false,
      cacheImpact: 'partial',
      causes: ['system'],
      preservedCacheTiers: ['tools']
    })
    expect(system.generation.id).toBe(first.id)
    expect(system.generation.config.systemPromptFingerprint).toBe('system-v2')
    expect(system.generation.cacheEvidence).toBeUndefined()

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
    expect(thinking.generation.cacheEvidence).toBeUndefined()
  })

  it('still rotates history-replay transports on system-prefix changes', () => {
    const api = { ...input(), transport: 'api-byok' as const }
    const first = planProviderSeatGeneration(undefined, api).generation
    const system = planProviderSeatGeneration(first, {
      ...api,
      systemPromptFingerprint: 'system-v2'
    })

    expect(system.freshSessionRequired).toBe(true)
    expect(system.causes).toEqual(['system'])
    expect(system.generation.ordinal).toBe(2)
  })

  it('never rotates a linked CLI session for system-prefix drift alone', () => {
    const first = planProviderSeatGeneration(undefined, input('claude')).generation
    const runtime = planProviderSeatRuntime(
      first,
      { ...input('claude'), systemPromptFingerprint: 'system-v2' },
      { linkedProviderSessionId: 'claude-live-session' }
    )

    expect(runtime.transition.causes).toEqual(['system'])
    expect(runtime.shouldRotateSession).toBe(false)
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

  it('inherits unstated provider-mutable fields instead of flip-flopping across lanes', () => {
    const stated = input('claude')
    const first = planProviderSeatGeneration(undefined, stated).generation
    const laneWithoutSoftFields = {
      ...stated,
      thinkingMode: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined
    }
    const next = planProviderSeatGeneration(first, laneWithoutSoftFields)

    expect(next.causes).toEqual([])
    expect(next.generation.config.reasoningEffort).toBe('high')
    expect(next.generation.config.thinkingMode).toBe('on')
    expect(next.generation.config.serviceTier).toBe('standard')
  })

  it('normalizes absent posture to the clamp-derived preset for fingerprinting', () => {
    const renderer = providerSeatPosturePrefixComponents({
      approvalMode: 'default',
      presetId: 'default',
      readOnly: false
    })
    const remote = providerSeatPosturePrefixComponents({
      approvalMode: 'default',
      presetId: null,
      readOnly: null
    })
    expect(remote).toEqual(renderer)
    expect(remote).toEqual({ presetId: 'default', readOnly: false })

    expect(
      providerSeatPosturePrefixComponents({ approvalMode: 'plan', presetId: null, readOnly: null })
    ).toEqual({ presetId: 'read_only', readOnly: true })
    expect(
      providerSeatPosturePrefixComponents({
        approvalMode: 'default',
        presetId: 'workspace_write',
        readOnly: false
      })
    ).toEqual({ presetId: 'workspace_write', readOnly: false })
  })

  it('exempts pi from context-drop notices — its session is chat-deterministic', () => {
    expect(providerSeatRotationDropsContext('claude', 'cli-opaque')).toBe(true)
    expect(providerSeatRotationDropsContext('codex', 'cli-opaque')).toBe(true)
    expect(providerSeatRotationDropsContext('pi', 'cli-opaque')).toBe(false)
    expect(providerSeatRotationDropsContext('claude', 'api-byok')).toBe(false)
  })

  it('phrases real rotation notices by cause with model detail when known', () => {
    expect(
      providerSeatRotationNoticeText({
        providerLabel: 'Kimi',
        causes: ['model', 'effort'],
        storedSessionMismatch: true,
        previousModel: 'kimi-k2.7-code',
        nextModel: 'kimi-k3'
      })
    ).toBe(
      'Session context reset — the model changed (kimi-k2.7-code → kimi-k3). Kimi starts this turn without the previous conversation context.'
    )
    expect(
      providerSeatRotationNoticeText({
        providerLabel: 'Claude',
        causes: ['tools'],
        storedSessionMismatch: false
      })
    ).toBe(
      'Session context reset — the tool profile changed. Claude starts this turn without the previous conversation context.'
    )
    expect(
      providerSeatRotationNoticeText({
        providerLabel: 'Claude',
        causes: [],
        storedSessionMismatch: true
      })
    ).toBe(
      'Session context reset — the stored session no longer matches its recorded configuration. Claude starts this turn without the previous conversation context.'
    )
    expect(
      providerSeatRotationNoticeText({
        providerLabel: 'Codex',
        causes: ['provider', 'model'],
        storedSessionMismatch: false,
        previousModel: 'gpt-5.5',
        nextModel: 'gpt-5.5'
      })
    ).toBe(
      'Session context reset — the provider changed, the model changed. Codex starts this turn without the previous conversation context.'
    )
  })

  it('skips unrecorded fields when validating a stored session and spares CLI context', () => {
    const stored = planProviderSeatGeneration(undefined, input('claude')).generation.config

    const unknownObservation = {
      provider: 'claude' as const,
      transport: 'cli-opaque' as const,
      model: undefined,
      toolsFingerprint: undefined,
      taskWraithMcpProfileId: undefined,
      systemPromptFingerprint: undefined
    }
    expect(storedSeatSessionRotationRequired(stored, unknownObservation, true)).toBe(false)
    expect(storedSeatSessionRotationRequired(undefined, unknownObservation, true)).toBe(false)

    const fullMatch = {
      provider: 'claude' as const,
      transport: 'cli-opaque' as const,
      model: stored.model,
      toolsFingerprint: stored.toolsFingerprint,
      taskWraithMcpProfileId: stored.taskWraithMcpProfileId,
      systemPromptFingerprint: stored.systemPromptFingerprint
    }
    expect(storedSeatSessionRotationRequired(stored, fullMatch, true)).toBe(false)
    expect(storedSeatSessionRotationRequired(stored, fullMatch, false)).toBe(false)

    expect(
      storedSeatSessionRotationRequired(stored, { ...fullMatch, model: 'claude-opus-4-7' }, true)
    ).toBe(true)
    expect(
      storedSeatSessionRotationRequired(stored, { ...fullMatch, toolsFingerprint: 'tools-v2' }, true)
    ).toBe(true)
    expect(
      storedSeatSessionRotationRequired(stored, { ...fullMatch, transport: 'api-byok' }, true)
    ).toBe(true)

    // System drift on a CLI seat re-generations without rotating; the same
    // drift on a history-replay transport still rotates.
    expect(
      storedSeatSessionRotationRequired(
        stored,
        { ...fullMatch, systemPromptFingerprint: 'system-v2' },
        true
      )
    ).toBe(false)
    const apiStored = { ...stored, transport: 'api-byok' as const }
    expect(
      storedSeatSessionRotationRequired(
        apiStored,
        { ...fullMatch, transport: 'api-byok', systemPromptFingerprint: 'system-v2' },
        true
      )
    ).toBe(true)
  })

  it('bootstraps an existing session and rotates it on the first observed model change', () => {
    const previousInput = input('codex')
    const runtime = planProviderSeatRuntime(
      undefined,
      { ...previousInput, model: 'gpt-5.5' },
      {
        linkedProviderSessionId: 'thread-existing',
        bootstrapInput: { ...previousInput, model: 'gpt-5.4' },
        now: '2026-07-11T12:00:00.000Z'
      }
    )

    expect(runtime).toMatchObject({
      bootstrappedExistingSession: true,
      shouldRotateSession: true,
      transition: { causes: ['model'], freshSessionRequired: true }
    })
  })

  it('rotates a receipted existing seat when its desired immutable tool profile changes', () => {
    const desired = input('claude')
    const actual = {
      ...desired,
      toolsFingerprint: 'taskwraith-full-v1-tools',
      taskWraithMcpProfileId: 'taskwraith-full-v1' as const
    }
    const runtime = planProviderSeatRuntime(undefined, desired, {
      linkedProviderSessionId: 'claude-existing',
      bootstrapInput: actual
    })

    expect(runtime.shouldRotateSession).toBe(true)
    expect(runtime.transition.causes).toEqual(['tools'])
    expect(runtime.transition.generation.config.taskWraithMcpProfileId).toBe(
      'taskwraith-gateway-v1'
    )
  })

  it('rotates a gateway-v1 seat to v2 even when the broader tool fingerprint is unchanged', () => {
    const gatewayV1 = input('claude')
    const gatewayV2 = {
      ...gatewayV1,
      taskWraithMcpProfileId: 'taskwraith-gateway-v2' as const
    }
    const first = planProviderSeatGeneration(undefined, gatewayV1).generation
    const next = planProviderSeatGeneration(first, gatewayV2)

    expect(next.freshSessionRequired).toBe(true)
    expect(next.causes).toEqual(['tools'])
    expect(next.generation.config.taskWraithMcpProfileId).toBe('taskwraith-gateway-v2')
  })

  it('does not redundantly rotate an initial seat with no provider session', () => {
    const runtime = planProviderSeatRuntime(undefined, input('claude'), {
      now: '2026-07-11T12:00:00.000Z'
    })

    expect(runtime.transition.causes).toEqual(['initial'])
    expect(runtime.transition.freshSessionRequired).toBe(true)
    expect(runtime.shouldRotateSession).toBe(false)
    expect(runtime.bootstrappedExistingSession).toBe(false)
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
    const runObserved = recordProviderSeatCacheEvidence(
      generation,
      { cached_input_tokens: 42 },
      { runId: 'run-idempotent', observedAt: '2026-07-11T12:00:00.000Z' }
    )
    expect(
      recordProviderSeatCacheEvidence(
        runObserved,
        { cached_input_tokens: 42 },
        { runId: 'run-idempotent', observedAt: '2026-07-11T12:01:00.000Z' }
      )
    ).toBe(runObserved)
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
