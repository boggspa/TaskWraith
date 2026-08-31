import { describe, expect, it } from 'vitest'

import {
  hasHostProviderCatalogEntry,
  hostKimiManagedFallbackRows,
  hostProviderAuthFlows,
  hostProviderCatalogEntry,
  hostProviderCatalogIds,
  hostProviderKimiOffers,
  hostProviderOffers,
  hostProviderStatus,
  projectHostProviderOfferCapabilities
} from './HostProviderCatalog'
import { PI_STATIC_MODELS } from './pi/PiModels'
import { isPiModelRetired } from '../shared/piModelLifecycle'

describe('derived reasoning offers', () => {
  const efforts = (providerId: string, modelId: string): string[] =>
    (hostProviderCatalogEntry(providerId)?.models ?? [])
      .find((offer) => offer.modelId === modelId)
      ?.reasoning.map((option) => option.reasoningId) ?? []

  // This surface feeds the Host and the iOS remote picker, so drift from the
  // desktop tables was invisible to every desktop test. Both providers now
  // derive from the same resolvers the desktop uses.
  it('never offers Ollama an effort its daemon rejects', () => {
    const offered = new Set(
      (hostProviderCatalogEntry('ollama')?.models ?? []).flatMap((offer) =>
        offer.reasoning.map((option) => option.reasoningId)
      )
    )
    // `think` accepts high/medium/low/max, true, or false — never `xhigh`.
    expect(offered.has('xhigh')).toBe(false)
    expect([...offered].sort()).toEqual(['high', 'low', 'medium', 'off', 'on'])
  })

  it('offers no reasoning at all for models that cannot think', () => {
    for (const modelId of ['gemma3:4b', 'granite4:3b', 'granite4.1:30b', 'granite4.2:8b']) {
      expect(efforts('ollama', modelId), modelId).toEqual([])
    }
    for (const wireId of ['mistral/mistral-large-2512', 'mistral/ministral-8b-2512']) {
      expect(efforts('pi', wireId), wireId).toEqual([])
    }
  })

  it('keeps each Pi route on its own upstream ladder', () => {
    expect(efforts('pi', 'deepseek/deepseek-v4-pro')).toEqual(['off', 'low', 'high', 'max'])
    expect(efforts('pi', 'zai/glm-5.2')).toEqual(['off', 'high', 'max'])
    expect(efforts('pi', 'openrouter/z-ai/glm-5.2')).toEqual(['off', 'high', 'xhigh'])
    // GPT-OSS cannot be switched off on either host.
    expect(efforts('pi', 'groq/openai/gpt-oss-120b')).toEqual(['low', 'medium', 'high'])
  })

  it('gives GPT-OSS the level ladder Ollama documents for it', () => {
    expect(efforts('ollama', 'gpt-oss:20b')).toEqual(['low', 'medium', 'high'])
    expect(efforts('ollama', 'qwen3.5:9b')).toEqual(['off', 'on'])
  })
})

describe('HostProviderCatalog', () => {
  it('exposes entries for all nine live providers', () => {
    const ids = hostProviderCatalogIds()
    expect(ids).toEqual([
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'ollama',
      'pi',
      'mistral',
      'muse'
    ])
    for (const id of ids) {
      expect(hasHostProviderCatalogEntry(id)).toBe(true)
      const entry = hostProviderCatalogEntry(id)
      expect(entry).not.toBeNull()
      expect(entry!.providerId).toBe(id)
      expect(entry!.models.length).toBeGreaterThan(0)
      expect(entry!.postures.map((posture) => posture.label)).toEqual([
        'Plan',
        'Ask',
        'Accept Edits',
        'Full WS Access',
        'Full Access (YOLO)'
      ])
    }
  })

  it('rejects unknown providers without fabricating rows', () => {
    expect(hasHostProviderCatalogEntry('gemini')).toBe(false)
    expect(hostProviderCatalogEntry('gemini')).toBeNull()
    expect(hostProviderOffers('gemini', true)).toBeNull()
    expect(hostProviderStatus('gemini', true, true)).toBeNull()
    expect(hostProviderAuthFlows('gemini')).toEqual([])
  })

  it('does not catalog AntiGravity; standalone Host never fabricates that row', () => {
    expect(hasHostProviderCatalogEntry('antigravity')).toBe(false)
    expect(hostProviderCatalogEntry('antigravity')).toBeNull()
    expect(hostProviderOffers('antigravity', true)).toBeNull()
    expect(hostProviderStatus('antigravity', true, true)).toBeNull()
    expect(hostProviderAuthFlows('antigravity')).toEqual([])
    expect(hostProviderCatalogIds()).not.toContain('antigravity')
  })

  it('derives offers with deterministic revision and availability gating', () => {
    const muse = hostProviderOffers('muse', true)
    expect(muse).not.toBeNull()
    expect(muse!.providerId).toBe('muse')
    expect(typeof muse!.offerRevision).toBe('string')
    expect(muse!.offerRevision.length).toBe(64)
    expect(muse!.models[0].modelId).toBe('muse-spark-1.2')
    expect(muse!.models[0].default).toBe(true)
    expect(muse!.models[0].available).toBe(true)
    expect(muse!.models[0].reasoning.length).toBe(6)
    expect(muse!.postures.slice(0, 4).every((p) => p.available)).toBe(true)
    expect(muse!.postures[4]).toMatchObject({
      postureId: 'full_access',
      available: false,
      requiresExplicitConsent: true,
      ceiling: 'full_access'
    })

    const offline = hostProviderOffers('muse', false)
    expect(offline).not.toBeNull()
    expect(offline!.models[0].available).toBe(false)
    expect(offline!.models[0].reasoning.every((r) => !r.available)).toBe(true)
    expect(offline!.postures.every((p) => !p.available)).toBe(true)
  })

  it('flags the requested default model for each provider without fabricating availability', () => {
    expect(hostProviderCatalogEntry('codex')?.models.find((model) => model.default)?.modelId).toBe(
      'gpt-5.6-terra'
    )
    expect(hostProviderCatalogEntry('claude')?.models.find((model) => model.default)?.modelId).toBe(
      'claude-opus-5'
    )
    expect(
      hostProviderCatalogEntry('mistral')?.models.find((model) => model.default)?.modelId
    ).toBe('mistral-medium-3.5')
    expect(hostProviderCatalogEntry('pi')?.models.find((model) => model.default)?.modelId).toBe(
      'deepseek/deepseek-v4-flash'
    )
  })

  it('offers Full Access only for transports with an exact verified mapping', () => {
    for (const providerId of hostProviderCatalogIds()) {
      const withoutAuthority = hostProviderCatalogEntry(providerId)?.postures.find(
        (posture) => posture.postureId === 'full_access'
      )
      expect(withoutAuthority?.available).toBe(false)
      const fullAccess = hostProviderCatalogEntry(providerId, {
        fullAccessConsentAuthority: true
      })?.postures.find((posture) => posture.postureId === 'full_access')
      expect(fullAccess).toMatchObject({
        label: 'Full Access (YOLO)',
        requiresExplicitConsent: true,
        ceiling: 'full_access',
        available: providerId === 'codex' || providerId === 'claude'
      })
    }
  })

  it('overlays consent capability onto the exact dynamic offer and revision', () => {
    const base = hostProviderOffers('codex', true)!
    const dynamic = {
      ...base,
      offerRevision: 'dynamic-runtime-revision',
      models: [
        ...base.models,
        { modelId: 'runtime-model', label: 'Runtime model', available: true, reasoning: [] }
      ]
    }
    const disabled = projectHostProviderOfferCapabilities(dynamic)
    expect(disabled.offerRevision).toBe('dynamic-runtime-revision')
    expect(disabled.models).toEqual(dynamic.models)
    expect(
      disabled.postures.find((posture) => posture.postureId === 'full_access')?.available
    ).toBe(false)

    const enabled = projectHostProviderOfferCapabilities(dynamic, {
      fullAccessConsentAuthority: true
    })
    expect(enabled.models).toEqual(dynamic.models)
    expect(enabled.postures.filter((posture) => posture.postureId !== 'full_access')).toEqual(
      dynamic.postures.filter((posture) => posture.postureId !== 'full_access')
    )
    expect(enabled.offerRevision).not.toBe(dynamic.offerRevision)
    expect(enabled.postures.find((posture) => posture.postureId === 'full_access')).toMatchObject({
      available: true,
      ceiling: 'full_access'
    })
  })

  it('matches HostNodeMuseCatalog for Muse', () => {
    const entry = hostProviderCatalogEntry('muse')
    expect(entry).not.toBeNull()
    expect(
      entry!.models.map(({ modelId, label, default: isDefault }) => ({
        modelId,
        label,
        isDefault: Boolean(isDefault)
      }))
    ).toEqual([
      { modelId: 'muse-spark-1.2', label: 'Muse Spark 1.2', isDefault: true },
      {
        modelId: 'muse-spark-1.2-contributor',
        label: 'Muse Contributor Spark 1.2',
        isDefault: false
      }
    ])
    expect(entry!.models[1]?.detail).toMatch(/content.*product improvement/i)
    for (const model of entry!.models) {
      expect(model.reasoning.map((r) => r.reasoningId)).toEqual([
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'ultra'
      ])
    }
  })

  it('offers both K3 routes as regular-speed models with the full K3 effort ladder', () => {
    const entry = hostProviderCatalogEntry('kimi')
    expect(entry).not.toBeNull()
    expect(entry!.models.map((model) => model.modelId)).toEqual([
      'kimi-k2.7-code',
      'kimi-k3',
      'kimi-k3-256k'
    ])
    expect(entry!.models.map((model) => model.label)).toEqual([
      'K2.7 Coding',
      'K3 (1M)',
      'K3 (256K)'
    ])
    for (const modelId of ['kimi-k3', 'kimi-k3-256k']) {
      expect(entry!.models.find((model) => model.modelId === modelId)?.reasoning).toEqual([
        { reasoningId: 'low', label: 'Low', available: true },
        { reasoningId: 'high', label: 'High', available: true },
        { reasoningId: 'max', label: 'Max', available: true }
      ])
    }
  })

  it('keeps the static Kimi picker when managed discovery is unavailable', () => {
    const fallback = hostProviderOffers('kimi', true)
    const gated = hostProviderKimiOffers(true, null)
    expect(gated).toEqual(fallback)
    expect(hostKimiManagedFallbackRows().map((row) => row.id)).toEqual([
      'kimi-k2.7-code',
      'kimi-k3',
      'kimi-k3-256k'
    ])
  })

  it('gates Host Kimi offers to verified managed rows without remapping aliases', () => {
    const gated = hostProviderKimiOffers(true, [
      {
        id: 'kimi-k3',
        label: 'K3 (plan-capped 256K)',
        description: 'K3 route - 256K limit on this Kimi plan - Low, High, or Max thinking',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'max' },
          { reasoningEffort: 'invented' }
        ]
      },
      {
        id: 'kimi-k2.7-code',
        label: 'K2.7 Coding',
        disabled: true
      }
    ])
    expect(gated?.models.map((model) => model.modelId)).toEqual(['kimi-k3'])
    expect(gated?.models[0]).toMatchObject({
      label: 'K3 (plan-capped 256K)',
      default: true,
      reasoning: [
        { reasoningId: 'low', label: 'Low', available: true },
        { reasoningId: 'max', label: 'Max', available: true }
      ]
    })
    expect(gated?.models.some((model) => model.modelId === 'kimi-k2.7-code')).toBe(false)
    expect(gated?.offerRevision).not.toBe(hostProviderOffers('kimi', true)?.offerRevision)
  })

  it('does not change Grok, Mistral, Codex, Claude, or Cursor offers', () => {
    for (const providerId of ['grok', 'mistral', 'codex', 'claude', 'cursor']) {
      const offers = hostProviderOffers(providerId, true)
      expect(offers?.providerId).toBe(providerId)
      expect(offers?.models.length).toBeGreaterThan(0)
      expect(offers?.models.every((model) => model.available)).toBe(true)
    }
  })

  it('advertises Grok interactive login plus env-key alternative', () => {
    const flows = hostProviderAuthFlows('grok')
    expect(flows).toEqual([
      {
        flowId: 'grok:login',
        kind: 'manual',
        label: 'Sign in',
        available: true,
        detail:
          'Interactive `grok login`, or set XAI_API_KEY / GROK_API_KEY in the Host environment.'
      }
    ])
  })

  it('keeps Pi env-only with no begin-able manual flow', () => {
    expect(hostProviderAuthFlows('pi')).toEqual([])
  })

  it('keeps Ollama daemon-only with no begin-able manual flow', () => {
    expect(hostProviderAuthFlows('ollama')).toEqual([])
    expect(hostProviderCatalogEntry('ollama')?.authFlows).toEqual([])
  })

  it('offers the newest curated local Ollama families', () => {
    expect(hostProviderCatalogEntry('ollama')?.models.map((model) => model.modelId)).toEqual(
      expect.arrayContaining([
        'mistral-medium-3.5:128b',
        'qwen3.8-flash-next:125b-mlx',
        'granite4.2:3b',
        'granite4.2:8b',
        'granite4.2:30b'
      ])
    )
  })

  it('marks providers with manual login flows', () => {
    for (const id of ['codex', 'claude', 'kimi', 'cursor', 'grok', 'mistral', 'muse']) {
      const flows = hostProviderAuthFlows(id)
      expect(flows.length).toBe(1)
      expect(flows[0].kind).toBe('manual')
      expect(flows[0].flowId).toBe(`${id}:login`)
      expect(flows[0].available).toBe(true)
    }
  })

  it('every Pi offer id is upstream-qualified (<upstream>/<model>)', () => {
    const offers = hostProviderOffers('pi', true)
    expect(offers).not.toBeNull()
    expect(offers!.models.length).toBeGreaterThan(0)
    for (const model of offers!.models) {
      expect(model.modelId).toMatch(/^[a-z0-9-]+\//)
    }
  })

  it('derives the complete active Pi offer catalog from the shared static authority', () => {
    const offers = hostProviderOffers('pi', true)
    const activeStaticIds = PI_STATIC_MODELS.filter((model) => !isPiModelRetired(model.wireId)).map(
      (model) => model.wireId
    )

    expect(offers?.models.map((model) => model.modelId)).toEqual(activeStaticIds)
    expect(offers?.models.map((model) => model.modelId)).toEqual(
      expect.arrayContaining([
        'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
        'openrouter/cohere/north-mini-code:free',
        'openrouter/minimax/minimax-m3:free',
        'openrouter/thinkingmachines/inkling:free',
        'openrouter/thinkingmachines/inkling-small:free'
      ])
    )
  })

  it('does not include retired Ox Alpha in the current Pi offer catalog', () => {
    const offers = hostProviderOffers('pi', true)
    expect(offers).not.toBeNull()
    expect(offers!.models.map((model) => model.modelId)).not.toContain(
      'openrouter/stealth/ox-alpha'
    )
    expect(offers!.models.map((model) => model.modelId)).toEqual(
      expect.arrayContaining(['openrouter/z-ai/glm-5.2', 'openrouter/poolside/laguna-s-2.1'])
    )
  })
})
