import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import type { HostExternalSupervisor } from './HostExternalSupervisor'
import { createHostExternalLifecycleAdapter } from './HostExternalLifecycleAdapter'

const welcome: HostBootstrapWelcome = {
  type: 'host.welcome',
  protocolVersion: 2,
  controlProtocolCompat: 1,
  projectionVersion: 2,
  hostId: 'host-1',
  hostVersion: 'node-host-v1',
  sessionId: 'session-1',
  generation: 1,
  cursor: 0,
  authenticatedClient: {
    clientId: 'desktop-external',
    clientClass: 'desktop',
    clientVersion: '1.0.0'
  },
  capabilities: [
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
    ensureAvailable: vi.fn(async () => ({ kind: 'existing' as const, welcome })),
    close: vi.fn()
  } as unknown as HostExternalSupervisor
}

describe('HostExternalLifecycleAdapter', () => {
  it('adopts prepared readiness without probing and projects independent health', async () => {
    const owner = supervisor()
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: '/profiles/a',
      supervisor: owner,
      preparedResult: { kind: 'launched', pid: 42, welcome }
    })
    await Promise.all([adapter.start(), adapter.start()])
    expect(owner.ensureAvailable).not.toHaveBeenCalled()
    expect(adapter.isRunning).toBe(true)
    expect(adapter.healthProvider()).toMatchObject({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false
    })
  })

  it('probes on demand and explicitly shuts down through the lifecycle client', async () => {
    const owner = supervisor()
    const shutdown = vi.fn(async () => 'stopping' as const)
    const createShutdownClient = vi.fn(() => ({ shutdown }))
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: '/profiles/a',
      supervisor: owner,
      createShutdownClient
    })
    await adapter.start()
    await adapter.stop()
    expect(owner.ensureAvailable).toHaveBeenCalledOnce()
    expect(createShutdownClient).toHaveBeenCalledWith('/profiles/a')
    expect(shutdown).toHaveBeenCalledOnce()
    expect(owner.close).toHaveBeenCalledOnce()
    expect(adapter.isRunning).toBe(false)
    expect(adapter.isStopped).toBe(true)
  })

  it('retains a failed explicit-stop handle for a successful retry', async () => {
    const owner = supervisor()
    const shutdown = vi
      .fn<() => Promise<'stopping'>>()
      .mockRejectedValueOnce(new Error('lease remains'))
      .mockResolvedValueOnce('stopping')
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: '/profiles/a',
      supervisor: owner,
      createShutdownClient: () => ({ shutdown })
    })
    await adapter.start()
    await expect(adapter.stop()).rejects.toThrow('lease remains')
    expect(adapter.isRunning).toBe(true)
    expect(owner.close).not.toHaveBeenCalled()
    await expect(adapter.stop()).resolves.toBeUndefined()
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(owner.close).toHaveBeenCalledOnce()
  })

  it('detaches synchronously on ordinary app quit and never stops the shared Host', async () => {
    const owner = supervisor()
    const shutdown = vi.fn()
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: '/profiles/a',
      supervisor: owner,
      preparedResult: { kind: 'existing', welcome },
      createShutdownClient: () => ({ shutdown })
    })
    await adapter.start()
    adapter.stopSync()
    expect(shutdown).not.toHaveBeenCalled()
    expect(owner.close).toHaveBeenCalledOnce()
    expect(adapter.isStopped).toBe(true)
  })

  it('has no Electron, AppStore, TUI, or dynamic-import dependency', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostExternalLifecycleAdapter.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/electron|AppStore|\.\.\/\.\.\/tui|import\s*\(/i)
  })
})
