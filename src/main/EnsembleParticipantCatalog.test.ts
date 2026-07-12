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

  it('combines runtime configuration and available quota evidence', () => {
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
      configured: true,
      usage: { worstBand: 'critical' }
    })
    expect(catalog.find((entry) => entry.provider === 'grok')).toMatchObject({
      configured: true
    })
    expect(catalog.find((entry) => entry.provider === 'claude')).toMatchObject({
      configured: false
    })
  })
})
