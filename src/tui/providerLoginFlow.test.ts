import { describe, expect, it } from 'vitest'
import { matchProviderStatus, providerLoginGuidance } from './providerLoginFlow'

const providers = [
  { providerId: 'claude', status: 'ready' as const, label: 'Claude' },
  {
    providerId: 'pi',
    status: 'auth_required' as const,
    label: 'Pi',
    detail: 'Configure an upstream key in the Host environment.'
  }
]

describe('provider login flow helpers', () => {
  it('matches exact ids and unique label prefixes without guessing ambiguity', () => {
    expect(matchProviderStatus(providers, 'pi')?.providerId).toBe('pi')
    expect(matchProviderStatus(providers, 'Clau')?.providerId).toBe('claude')
    expect(matchProviderStatus(providers, 'missing')).toBeUndefined()
  })

  it('uses bounded setup guidance without ever requesting a credential value', () => {
    const guidance = providerLoginGuidance(providers[1])
    expect(guidance).toContain('Host environment')
    expect(guidance).toContain('press r')
    expect(guidance).not.toMatch(/enter|paste|type.*key/i)
  })
})
