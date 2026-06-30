import { describe, expect, it } from 'vitest'
import { queuedMessageEntryProviderLabel } from './QueuedMessagesAboveRow'

describe('QueuedMessagesAboveRow labels', () => {
  it('uses an ensemble display label instead of the seed provider for ensemble queue rows', () => {
    expect(
      queuedMessageEntryProviderLabel({
        id: 'ensemble-queued-round-1-0',
        provider: 'grok',
        providerDisplayLabel: 'Ensemble',
        prompt: 'Continue the round.'
      })
    ).toBe('Ensemble')
  })

  it('falls back to the provider label for normal queued rows', () => {
    expect(
      queuedMessageEntryProviderLabel({
        id: 'queued-1',
        provider: 'grok',
        prompt: 'Run this later.'
      })
    ).toBe('Grok')
  })
})
