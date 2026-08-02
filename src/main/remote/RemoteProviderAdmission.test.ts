import { describe, expect, it } from 'vitest'
import { RemoteWorkspaceAllowlist } from '../RemoteWorkspaceAllowlist'
import { assertRemoteProviderGrant, isRemoteProviderDispatchable } from './RemoteProviderAdmission'

describe('isRemoteProviderDispatchable', () => {
  it('admits live and retired-continuation providers by default', () => {
    expect(isRemoteProviderDispatchable('pi')).toBe(true)
    expect(isRemoteProviderDispatchable('gemini')).toBe(true)
    expect(isRemoteProviderDispatchable('antigravity')).toBe(false)
  })

  it('admits a conditional provider only through the supplied runtime gate', () => {
    expect(
      isRemoteProviderDispatchable('antigravity', (provider) => provider === 'antigravity')
    ).toBe(true)
    expect(isRemoteProviderDispatchable('unknown', () => false)).toBe(false)
  })
})

describe('assertRemoteProviderGrant', () => {
  const allowlist = (): RemoteWorkspaceAllowlist => {
    const value = new RemoteWorkspaceAllowlist()
    value.upsert({
      workspaceId: 'ws-1',
      path: '/repo',
      mode: 'read-write',
      capabilities: ['monitor', 'startTurn', 'steer']
    })
    return value
  }

  it('keeps nested provider admission independent from the universal workspace grant', () => {
    for (const provider of ['pi', 'claude', 'antigravity']) {
      expect(() =>
        assertRemoteProviderGrant({
          allowlist: allowlist(),
          workspaceId: 'ws-1',
          provider,
          capability: 'steer'
        })
      ).not.toThrow()
    }
  })

  it('still rejects capabilities outside the workspace grant', () => {
    expect(() =>
      assertRemoteProviderGrant({
        allowlist: allowlist(),
        workspaceId: 'ws-1',
        provider: 'pi',
        capability: 'fileWrite'
      })
    ).toThrow(/capability "fileWrite"/i)
  })
})
