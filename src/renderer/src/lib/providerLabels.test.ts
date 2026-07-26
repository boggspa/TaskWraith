import { describe, expect, it } from 'vitest'
import { getProviderOfferUnavailableReason } from './providerLabels'

describe('getProviderOfferUnavailableReason', () => {
  it('describes retired Gemini without conflating history with run management', () => {
    expect(getProviderOfferUnavailableReason('gemini')).toBe(
      'Gemini is retired for new runs; historical chats remain available.'
    )
  })

  it('describes the conditional AntiGravity setup wall', () => {
    expect(getProviderOfferUnavailableReason('antigravity')).toBe(
      'AntiGravity needs its consent or Gemini API setup before new runs.'
    )
  })

  it('uses offer-policy language for any other rejected provider', () => {
    expect(getProviderOfferUnavailableReason('pi')).toBe(
      'Pi is not currently offered for new runs.'
    )
  })
})
