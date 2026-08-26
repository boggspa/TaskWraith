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

  it('marks providers without manual login flows as empty', () => {
    expect(hostProviderAuthFlows('grok')).toEqual([])
    expect(hostProviderAuthFlows('pi')).toEqual([])
  })

  it('marks providers with manual login flows', () => {
    for (const id of ['codex', 'claude', 'kimi', 'cursor', 'ollama', 'mistral', 'muse']) {
      const flows = hostProviderAuthFlows(id)
      expect(flows.length).toBe(1)
      expect(flows[0].kind).toBe('manual')
      expect(flows[0].flowId).toBe(`${id}:login`)
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
