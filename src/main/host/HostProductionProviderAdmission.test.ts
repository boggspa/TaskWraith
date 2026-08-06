/**
 * Host Arc Step 5b — HostProductionProviderAdmission pins.
 *
 * RED-first: these pins existed against the missing mapper before the
 * implementation landed. Mutation-prove the load-bearing clauses.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  HOST_PROVIDER_ADMISSION_NOTES,
  createHostProductionProviderAdmission,
  mapConfiguredProviderSnapshotToHostProviders,
  type HostConfiguredProviderSnapshot
} from './HostProductionProviderAdmission'

function snap(
  overrides: Partial<HostConfiguredProviderSnapshot> = {}
): HostConfiguredProviderSnapshot {
  return {
    ready: true,
    providerIds: ['claude', 'codex'],
    ...overrides
  }
}

describe('mapConfiguredProviderSnapshotToHostProviders', () => {
  it('returns empty when snapshot is not ready (fail closed)', () => {
    expect(
      mapConfiguredProviderSnapshotToHostProviders(snap({ ready: false, providerIds: ['claude'] }))
    ).toEqual([])
  })

  it('returns empty when ready with zero provider ids', () => {
    expect(mapConfiguredProviderSnapshotToHostProviders(snap({ providerIds: [] }))).toEqual([])
  })

  it('emits one allowlisted row per configured provider id', () => {
    const rows = mapConfiguredProviderSnapshotToHostProviders(snap())
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      providerId: 'claude',
      displayProvider: 'Claude',
      shortCode: expect.any(String),
      available: true,
      hueKey: 'claude',
      note: HOST_PROVIDER_ADMISSION_NOTES.configured
    })
    expect(rows[0].shortCode.length).toBeGreaterThan(0)
    expect(rows[1].providerId).toBe('codex')
    expect(rows[1].displayProvider).toBe('Codex')
  })

  it('emits provider×model rows when modelsByProvider is present', () => {
    const rows = mapConfiguredProviderSnapshotToHostProviders(
      snap({
        providerIds: ['antigravity'],
        modelsByProvider: {
          antigravity: [
            { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
            { id: 'gemini-3-pro', label: 'Gemini 3 Pro' }
          ]
        }
      })
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].providerId).toBe('antigravity')
    expect(rows[0].modelId).toBe('gemini-3.6-flash')
    expect(rows[0].modelLabel).toBe('Gemini 3.6 Flash')
    expect(rows[0].note).toBe(HOST_PROVIDER_ADMISSION_NOTES.conditional)
    expect(rows[1].modelId).toBe('gemini-3-pro')
  })

  it('never copies credential-shaped or free-form source fields onto the wire', () => {
    const poisoned = {
      ready: true,
      providerIds: ['claude'],
      apiKey: 'sk-live-secret',
      token: 'tok-secret',
      secret: 'sec',
      credential: 'cred',
      baseUrl: 'https://proxy.internal/v1?auth_token=leak',
      customHeaders: { Authorization: 'Bearer leak' },
      note: 'pass-through of attacker text with apiKey=sk-x',
      modelsByProvider: {
        claude: [
          {
            id: 'claude-opus-4-7',
            label: 'Opus',
            apiKey: 'nested-secret',
            baseUrl: 'https://evil/?token=x'
          } as { id: string; label: string }
        ]
      }
    } as HostConfiguredProviderSnapshot

    const rows = mapConfiguredProviderSnapshotToHostProviders(poisoned)
    expect(rows).toHaveLength(1)
    const serialized = JSON.stringify(rows[0])
    expect(serialized).not.toMatch(/apiKey|token|secret|credential|Bearer|auth_token|sk-/i)
    expect(rows[0].note).toBe(HOST_PROVIDER_ADMISSION_NOTES.configured)
    expect(rows[0]).not.toHaveProperty('baseUrl')
    expect(rows[0]).not.toHaveProperty('customHeaders')
  })

  it('skips blank provider ids rather than inventing rows', () => {
    const rows = mapConfiguredProviderSnapshotToHostProviders(
      snap({ providerIds: ['', '  ', 'claude'] })
    )
    expect(rows.map((r) => r.providerId)).toEqual(['claude'])
  })
})

describe('createHostProductionProviderAdmission', () => {
  it('implements HostProductionProviderListPort.getProviders', () => {
    const port = createHostProductionProviderAdmission({
      getConfiguredSnapshot: () => snap({ providerIds: ['pi'] })
    })
    const rows = port.getProviders()
    expect(rows).toHaveLength(1)
    expect(rows[0].providerId).toBe('pi')
    expect(rows[0].displayProvider).toBe('Pi')
  })

  it('returns empty when getConfiguredSnapshot throws', () => {
    const port = createHostProductionProviderAdmission({
      getConfiguredSnapshot: () => {
        throw new Error('settings unavailable')
      }
    })
    expect(port.getProviders()).toEqual([])
  })

  it('returns empty when deps are malformed', () => {
    const port = createHostProductionProviderAdmission(
      null as unknown as { getConfiguredSnapshot: () => HostConfiguredProviderSnapshot }
    )
    expect(port.getProviders()).toEqual([])
  })

  it('re-reads the snapshot on every getProviders call (no stale cache)', () => {
    const getConfiguredSnapshot = vi
      .fn()
      .mockReturnValueOnce(snap({ providerIds: ['claude'] }))
      .mockReturnValueOnce(snap({ providerIds: ['claude', 'cursor'] }))
    const port = createHostProductionProviderAdmission({ getConfiguredSnapshot })
    expect(port.getProviders()).toHaveLength(1)
    expect(port.getProviders()).toHaveLength(2)
    expect(getConfiguredSnapshot).toHaveBeenCalledTimes(2)
  })
})
