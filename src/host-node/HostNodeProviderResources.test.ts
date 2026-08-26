import { describe, expect, it } from 'vitest'

import {
  createHostNodeProviderResourcePort,
  hostNodeProviderAuthFlows,
  hostNodeProviderAuthStatus,
  normalizeHostNodeProviderStatus,
  resolveHostNodeProviderBinary
} from './HostNodeProviderResources'

describe('HostNodeProviderResources', () => {
  it('resolves binary candidates without AppStore fallback', () => {
    const missing = resolveHostNodeProviderBinary('nonexistent-provider')
    expect(missing.binaryPath).toBeNull()
    expect(missing.source).toBe('missing')
    expect(typeof missing.error).toBe('string')
  })

  it('normalizes missing binary to unavailable, never omits the row', () => {
    const status = normalizeHostNodeProviderStatus('codex', {
      providerId: 'codex',
      available: false,
      binaryAvailable: false,
      authState: 'unknown'
    })
    expect(status.providerId).toBe('codex')
    expect(status.status).toBe('unavailable')
    expect(status.label).toBe('Codex')
  })

  it('normalizes unauthenticated to auth_required', () => {
    const status = normalizeHostNodeProviderStatus('claude', {
      providerId: 'claude',
      available: true,
      binaryAvailable: true,
      authState: 'unauthenticated'
    })
    expect(status.status).toBe('auth_required')
  })

  it('normalizes ready provider to ready', () => {
    const status = normalizeHostNodeProviderStatus('muse', {
      providerId: 'muse',
      available: true,
      binaryAvailable: true,
      authState: 'authenticated'
    })
    expect(status.status).toBe('ready')
    expect(status.label).toBe('Muse')
  })

  it('normalizes degraded provider to degraded', () => {
    const status = normalizeHostNodeProviderStatus('pi', {
      providerId: 'pi',
      available: false,
      binaryAvailable: true,
      authState: 'unknown'
    })
    expect(status.status).toBe('degraded')
  })

  it('projects auth status honestly', () => {
    const auth = hostNodeProviderAuthStatus('kimi', {
      providerId: 'kimi',
      available: true,
      binaryAvailable: true,
      authState: 'authenticated'
    })
    expect(auth.state).toBe('authenticated')
    const unknown = hostNodeProviderAuthStatus('kimi', {
      providerId: 'kimi',
      available: true,
      binaryAvailable: true,
      authState: 'unknown'
    })
    expect(unknown.state).toBe('unknown')
  })

  it('exposes auth flows only when binary is present and auth is missing', () => {
    const flows = hostNodeProviderAuthFlows('cursor', {
      providerId: 'cursor',
      available: true,
      binaryAvailable: true,
      authState: 'unauthenticated'
    })
    expect(flows.length).toBe(1)
    expect(flows[0].flowId).toBe('cursor:login')
    const ready = hostNodeProviderAuthFlows('cursor', {
      providerId: 'cursor',
      available: true,
      binaryAvailable: true,
      authState: 'authenticated'
    })
    expect(ready).toEqual([])
    const missing = hostNodeProviderAuthFlows('cursor', {
      providerId: 'cursor',
      available: false,
      binaryAvailable: false,
      authState: 'unauthenticated'
    })
    expect(missing).toEqual([])
  })

  it('creates a resource port per provider', () => {
    const port = createHostNodeProviderResourcePort('grok')
    expect(typeof port.resolveBinary).toBe('function')
    expect(typeof port.getAuthState).toBe('function')
    expect(typeof port.getVersion).toBe('function')
  })
})
