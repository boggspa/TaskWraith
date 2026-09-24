import { describe, expect, it } from 'vitest'
import { providerContextPolicyDetails, providerRuntimeVersion } from './providerContextPolicy'

describe('context policy presentation', () => {
  it('labels configuration separately from unreported runtime facts', () => {
    const rows = Object.fromEntries(
      providerContextPolicyDetails({
        provider: 'claude',
        model: 'claude-fable-5-1',
        modelCapacityTokens: 1_000_000,
        requestedCompactionTokens: 650_000,
        configurationSource: 'user-settings'
      })
    )
    expect(rows['Requested compaction window']).toBe('650,000 tokens')
    expect(rows['Runtime working window']).toBe('Not reported')
    expect(rows['Runtime compaction threshold']).toBe('Not reported')
    expect(rows.Configuration).toBe('Saved Claude preference')
  })

  it('extracts only a bounded version from native handshake text', () => {
    expect(providerRuntimeVersion('codex_cli_rs/0.153.0 (Darwin; private-hostname)')).toBe(
      '0.153.0'
    )
    expect(providerRuntimeVersion('2.1.261')).toBe('2.1.261')
    expect(providerRuntimeVersion(null)).toBeUndefined()
    expect(providerRuntimeVersion('unknown')).toBeUndefined()
  })
})
