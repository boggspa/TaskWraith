import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import type { HostExternalSupervisor } from './HostExternalSupervisor'
import {
  clearPreparedExternalHost,
  consumePreparedExternalHost,
  publishPreparedExternalHost
} from './HostExternalRuntimeState'

const welcome: HostBootstrapWelcome = {
  type: 'host.welcome',
  protocolVersion: 2,
  controlProtocolCompat: 1,
  projectionVersion: 2,
  hostId: 'host-1',
  hostVersion: 'node-host-v1',
  sessionId: 'session-1',
  generation: 3,
  cursor: 4,
  authenticatedClient: {
    clientId: 'desktop-external',
    clientClass: 'desktop',
    clientVersion: '1.0.0'
  },
  capabilities: [
    'bootstrap',
    'commands',
    'receipts',
    'setup',
    'provider-catalog',
    'provider-auth',
    'history',
    'health'
  ],
  freshness: 'live'
}

function supervisor() {
  return {
    ensureAvailable: vi.fn(),
    close: vi.fn()
  } as unknown as HostExternalSupervisor
}

beforeEach(() => clearPreparedExternalHost())

describe('HostExternalRuntimeState', () => {
  it('hands one cloned authenticated production preparation to the exact profile', () => {
    const owner = supervisor()
    const mutableWelcome = { ...welcome, capabilities: [...welcome.capabilities] }
    const result = { kind: 'existing' as const, welcome: mutableWelcome }
    const published = publishPreparedExternalHost({
      profilePath: '/profiles/a',
      cutoverId: 'cutover-a',
      supervisor: owner,
      result
    })
    mutableWelcome.capabilities.push('channels')
    expect(published.result.welcome.capabilities).not.toContain('channels')
    expect(() => consumePreparedExternalHost('/profiles/b')).toThrow('does not match')
    expect(consumePreparedExternalHost('/profiles/a')).toBe(published)
    expect(consumePreparedExternalHost('/profiles/a')).toBeNull()
    expect(owner.close).not.toHaveBeenCalled()
  })

  it('fails closed for duplicate, non-production, and noncanonical preparations', () => {
    const owner = supervisor()
    publishPreparedExternalHost({
      profilePath: '/profiles/a',
      cutoverId: 'cutover-a',
      supervisor: owner,
      result: { kind: 'launched', pid: 42, welcome }
    })
    expect(() =>
      publishPreparedExternalHost({
        profilePath: '/profiles/a',
        cutoverId: 'cutover-b',
        supervisor: owner,
        result: { kind: 'existing', welcome }
      })
    ).toThrow('already pending')
    expect(() => consumePreparedExternalHost('relative')).toThrow('canonical')
    expect(clearPreparedExternalHost(owner)).toBe(true)
    expect(owner.close).toHaveBeenCalledOnce()
    expect(() =>
      publishPreparedExternalHost({
        profilePath: '/profiles/a',
        cutoverId: 'cutover-invalid',
        supervisor: owner,
        result: { kind: 'existing', welcome: { ...welcome, hostVersion: '1.9.6' } }
      })
    ).toThrow('production Node Host')
  })

  it('has no Electron, AppStore, TUI, or dynamic-import dependency', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostExternalRuntimeState.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/electron|AppStore|\.\.\/\.\.\/tui|import\s*\(/i)
  })
})
