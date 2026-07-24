import { describe, expect, it } from 'vitest'
import {
  buildEnsembleParticipantModelCatalog,
  buildEnsembleParticipantProviderCatalog
} from './EnsembleParticipantCatalog'

describe('EnsembleParticipantCatalog', () => {
  it('returns model context/reasoning metadata used for roster selection', () => {
    const codex = buildEnsembleParticipantModelCatalog('codex').find(
      (model) => model.id === 'gpt-5.6-terra'
    )
    expect(codex).toMatchObject({
      id: 'gpt-5.6-terra',
      contextWindow: 1_050_000
    })
    expect(codex?.reasoningEfforts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'high' })])
    )
  })

  it('keeps Codex quota evidence separate from runtime configuration', () => {
    const catalog = buildEnsembleParticipantProviderCatalog(
      (provider) =>
        provider === 'codex'
          ? {
              provider,
              configured: true,
              source: 'codex-account',
              fetchedAt: '2026-07-12T12:00:00.000Z',
              windows: [
                {
                  id: 'weekly',
                  label: 'Weekly',
                  runs: 1,
                  totalTokens: 1,
                  limitLabel: 'Weekly allowance',
                  trackingOnly: false,
                  usedPercent: 92
                }
              ]
            }
          : null,
      new Set(['grok'])
    )

    expect(catalog.find((entry) => entry.provider === 'codex')).toMatchObject({
      configured: false,
      usage: { worstBand: 'critical' }
    })
    expect(catalog.find((entry) => entry.provider === 'grok')).toMatchObject({
      configured: true
    })
    expect(catalog.find((entry) => entry.provider === 'claude')).toMatchObject({
      configured: false
    })

    const authenticatedCatalog = buildEnsembleParticipantProviderCatalog(
      () => null,
      new Set(['codex'])
    )
    expect(authenticatedCatalog.find((entry) => entry.provider === 'codex')).toMatchObject({
      configured: true
    })
  })
})

describe('antigravity gemini-api seat models', () => {
  it('exposes the static gemini-api floor so admitted seats are never model-less', () => {
    const models = buildEnsembleParticipantModelCatalog('antigravity')
    expect(models.length).toBeGreaterThanOrEqual(4)
    const ids = models.map((model) => model.id)
    expect(ids).toContain('gemini-api:gemini-2.5-flash')
    expect(ids).toContain('gemini-api:gemini-2.5-pro')
    // The prefix is load-bearing (dispatch routes on it) — every row keeps it.
    for (const id of ids) {
      expect(id.startsWith('gemini-api:')).toBe(true)
    }
  })
})
