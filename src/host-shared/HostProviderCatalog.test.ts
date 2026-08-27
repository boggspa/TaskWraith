import { describe, expect, it } from 'vitest'

import {
  hasHostProviderCatalogEntry,
  hostProviderAuthFlows,
  hostProviderCatalogEntry,
  hostProviderCatalogIds,
  hostProviderOffers,
  hostProviderStatus
} from './HostProviderCatalog'

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
      expect(entry!.postures.length).toBe(4)
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
    expect(muse!.postures.every((p) => p.available)).toBe(true)

    const offline = hostProviderOffers('muse', false)
    expect(offline).not.toBeNull()
    expect(offline!.models[0].available).toBe(false)
    expect(offline!.models[0].reasoning.every((r) => !r.available)).toBe(true)
    expect(offline!.postures.every((p) => !p.available)).toBe(true)
  })

  it('matches HostNodeMuseCatalog for Muse', () => {
    const entry = hostProviderCatalogEntry('muse')
    expect(entry).not.toBeNull()
    expect(entry!.models[0].modelId).toBe('muse-spark-1.2')
    expect(entry!.models[0].label).toBe('Muse Spark 1.2')
    expect(entry!.models[0].reasoning.map((r) => r.reasoningId)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra'
    ])
  })

  it('offers both K3 routes as regular-speed models with the full K3 effort ladder', () => {
    const entry = hostProviderCatalogEntry('kimi')
    expect(entry).not.toBeNull()
    expect(entry!.models.map((model) => model.modelId)).toEqual([
      'kimi-k2.7-code',
      'kimi-k3',
      'kimi-k3-256k'
    ])
    for (const modelId of ['kimi-k3', 'kimi-k3-256k']) {
      expect(entry!.models.find((model) => model.modelId === modelId)?.reasoning).toEqual([
        { reasoningId: 'low', label: 'Low', available: true },
        { reasoningId: 'high', label: 'High', available: true },
        { reasoningId: 'max', label: 'Max', available: true }
      ])
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
})
