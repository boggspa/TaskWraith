import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import type { HostExternalSupervisor } from './HostExternalSupervisor'
import { createHostExternalLifecycleAdapter } from './HostExternalLifecycleAdapter'

// resolve() keeps the fixture canonical on win32 too (the adapter guard
// requires resolve(profilePath) === profilePath, which a POSIX literal fails).
const PROFILE_A = resolve('/profiles/a')

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
      profilePath: PROFILE_A,
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
      profilePath: PROFILE_A,
      supervisor: owner,
      createShutdownClient
    })
    await adapter.start()
    await adapter.stop()
    expect(owner.ensureAvailable).toHaveBeenCalledOnce()
    expect(createShutdownClient).toHaveBeenCalledWith(PROFILE_A)
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
    // Verified termination could not prove the Host gone either.
    const terminate = vi.fn(async () => ({
      kind: 'identity_unavailable' as const,
      pid: 4242,
      detail: 'birth unobservable'
    }))
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: owner,
      createShutdownClient: () => ({ shutdown }),
      terminate
    })
    await adapter.start()
    await expect(adapter.stop()).rejects.toThrow(
      'Host did not stop: lease remains; verified termination ended identity_unavailable (birth unobservable).'
    )
    expect(adapter.isRunning).toBe(true)
    expect(owner.close).not.toHaveBeenCalled()
    await expect(adapter.stop()).resolves.toBeUndefined()
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(owner.close).toHaveBeenCalledOnce()
  })

  /** D9: a refused, timed-out or unauthorized socket stop no longer strands the explicit stop. */
  it('falls back to verified termination when the authenticated stop fails', async () => {
    const owner = supervisor()
    const refused = new Error('connect ECONNREFUSED')
    const shutdown = vi.fn(async () => {
      throw refused
    })
    const terminate = vi.fn(async () => ({ kind: 'terminated' as const, pid: 4242 }))
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: owner,
      createShutdownClient: () => ({ shutdown }),
      terminate
    })
    await adapter.start()
    await expect(adapter.stop()).resolves.toBeUndefined()
    // The socket failure travels with it, so the socket is not asked twice.
    expect(terminate).toHaveBeenCalledWith(PROFILE_A, refused)
    expect(adapter.isRunning).toBe(false)
    expect(adapter.isStopped).toBe(true)
    expect(owner.close).toHaveBeenCalledOnce()
  })

  it('never falls back while the authenticated stop succeeds', async () => {
    const owner = supervisor()
    const terminate = vi.fn()
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: owner,
      createShutdownClient: () => ({ shutdown: vi.fn(async () => 'stopping' as const) }),
      terminate
    })
    await adapter.start()
    await adapter.stop()
    expect(terminate).not.toHaveBeenCalled()
  })

  /**
   * S2 repin (design §2.4): quit is still signal-free and socket-free here.
   * Main releases its Host lease just before it (HostLeaseReasons, pinned in
   * HostExternalDesktopCutover.test.ts), so the Host stops on its own one
   * grace later unless something else holds it.
   */
  it('detaches synchronously on ordinary app quit and never stops or signals the shared Host', async () => {
    const owner = supervisor()
    const shutdown = vi.fn()
    const terminate = vi.fn()
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: owner,
      preparedResult: { kind: 'existing', welcome },
      createShutdownClient: () => ({ shutdown }),
      terminate
    })
    await adapter.start()
    adapter.stopSync()
    expect(shutdown).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
    expect(owner.close).toHaveBeenCalledOnce()
    expect(adapter.isStopped).toBe(true)
  })

  it('reports the attached Host and re-verifies it on demand', async () => {
    const hostA = {
      pid: 4101,
      hostId: 'host-1',
      startedAt: '2026-09-23T10:00:00.000Z',
      payloadVersion: `sha256:${'a'.repeat(64)}`
    }
    const hostB = { ...hostA, pid: 4202, startedAt: '2026-09-23T11:00:00.000Z' }
    const owner = supervisor()
    const ensureAvailable = owner.ensureAvailable as unknown as ReturnType<typeof vi.fn>
    ensureAvailable
      .mockResolvedValueOnce({ kind: 'existing', welcome, host: hostA })
      .mockResolvedValueOnce({ kind: 'launched', pid: 4202, welcome, host: hostB })
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: owner,
      preparedResult: { kind: 'existing', welcome, host: hostA }
    })
    expect(adapter.hostIdentity).toBeNull()
    await adapter.start()
    expect(adapter.hostIdentity).toEqual(hostA)
    // Still the same Host: nothing changed.
    await expect(adapter.ensureLive?.()).resolves.toBe(false)
    // It exited and the supervisor launched another.
    await expect(adapter.ensureLive?.()).resolves.toBe(true)
    expect(adapter.hostIdentity).toEqual(hostB)
    adapter.stopSync()
    await expect(adapter.ensureLive?.()).rejects.toThrow('not attached')
    expect(ensureAvailable).toHaveBeenCalledTimes(2)
  })

  it('has no Electron, AppStore, TUI, or dynamic-import dependency', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostExternalLifecycleAdapter.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/electron|AppStore|\.\.\/\.\.\/tui|import\s*\(/i)
  })
})
