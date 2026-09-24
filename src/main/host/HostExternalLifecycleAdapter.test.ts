import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as termination from '../../host-client/HostProcessTermination'
import {
  HostShutdownClient,
  HostShutdownIdentityError,
  HostShutdownUnsupportedError
} from '../../host-client/HostShutdownClient'
import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import * as registry from '../../host-runtime/HostRegistry'
import * as processBirth from '../../host-runtime/ProcessBirthIdentity'
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
    expect(createShutdownClient).toHaveBeenCalledWith(PROFILE_A, undefined)
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
    expect(terminate).toHaveBeenCalledWith(PROFILE_A, refused, undefined)
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

  it('carries the attached process identity through socket shutdown and verified fallback', async () => {
    const host = {
      pid: 4101,
      hostId: 'host-1',
      startedAt: '2026-09-23T10:00:00.000Z',
      birthIdentity: 'c'.repeat(64)
    }
    const expected = { pid: host.pid, startedAt: host.startedAt, birthIdentity: host.birthIdentity }
    const refused = new Error('socket unavailable')
    const createShutdownClient = vi.fn(() => ({
      shutdown: vi.fn(async () => {
        throw refused
      })
    }))
    const terminate = vi.fn(async () => ({ kind: 'terminated' as const, pid: host.pid }))
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: supervisor(),
      preparedResult: { kind: 'existing', welcome, host },
      createShutdownClient,
      terminate
    })
    await adapter.start()
    await adapter.stop()
    expect(createShutdownClient).toHaveBeenCalledWith(PROFILE_A, expected)
    expect(terminate).toHaveBeenCalledWith(PROFILE_A, refused, expected)
  })

  it('refuses a successor socket without invoking signal fallback or losing the retry handle', async () => {
    const owner = supervisor()
    const changed = new HostShutdownIdentityError('successor owns the socket', 'mismatch', 5202)
    const terminate = vi.fn()
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: owner,
      preparedResult: {
        kind: 'existing',
        welcome,
        host: {
          pid: 4101,
          hostId: 'host-1',
          startedAt: '2026-09-23T10:00:00.000Z',
          birthIdentity: 'c'.repeat(64)
        }
      },
      createShutdownClient: () => ({
        shutdown: vi.fn(async () => {
          throw changed
        })
      }),
      terminate
    })
    await adapter.start()
    await expect(adapter.stop()).rejects.toBe(changed)
    expect(terminate).not.toHaveBeenCalled()
    expect(owner.close).not.toHaveBeenCalled()
    expect(adapter.isRunning).toBe(true)
    adapter.stopSync()
  })

  it('gives the default explicit-stop client ten seconds to acknowledge and 45 seconds to drain', async () => {
    const shutdown = vi
      .spyOn(HostShutdownClient.prototype, 'shutdown')
      .mockImplementation(async function (this: HostShutdownClient) {
        expect(this).toMatchObject({ timeoutMs: 10_000, removalTimeoutMs: 45_000 })
        return 'stopping'
      })
    const adapter = createHostExternalLifecycleAdapter({
      profilePath: PROFILE_A,
      supervisor: supervisor()
    })
    try {
      await adapter.start()
      await adapter.stop()
      expect(shutdown).toHaveBeenCalledOnce()
    } finally {
      adapter.stopSync()
      shutdown.mockRestore()
    }
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

  describe('legacy attachment identity', () => {
    const host = { pid: 4101, hostId: 'host-1', startedAt: '2026-09-23T10:00:00.000Z' }
    const birthIdentity = 'c'.repeat(64)
    const expected = { pid: host.pid, startedAt: host.startedAt, birthIdentity }
    afterEach(() => vi.restoreAllMocks())

    it('uses the canonical profile for the default explicit socket stop', async () => {
      const canonicalProfile = resolve('/profiles/canonical')
      const canonical = vi
        .spyOn(registry, 'canonicalHostProfilePath')
        .mockReturnValue(canonicalProfile)
      const shutdown = vi
        .spyOn(HostShutdownClient.prototype, 'shutdown')
        .mockImplementation(async function (this: HostShutdownClient) {
          expect(this).toMatchObject({
            profilePath: canonicalProfile,
            expected,
            timeoutMs: 10_000,
            removalTimeoutMs: 45_000
          })
          return 'stopping'
        })
      const terminate = vi.fn()
      const adapter = createHostExternalLifecycleAdapter({
        profilePath: PROFILE_A,
        supervisor: supervisor(),
        preparedResult: { kind: 'existing', welcome, host: { ...host, birthIdentity } },
        terminate
      })
      try {
        await adapter.start()
        await adapter.stop()
        expect(canonical).toHaveBeenCalledWith(PROFILE_A)
        expect(shutdown).toHaveBeenCalledOnce()
        expect(terminate).not.toHaveBeenCalled()
      } finally {
        adapter.stopSync()
      }
    })

    it('uses the birth captured at attachment for explicitly unsupported legacy stop', async () => {
      const unsupported = new HostShutdownUnsupportedError('Host status request is unsupported')
      const shutdown = vi
        .spyOn(HostShutdownClient.prototype, 'shutdown')
        .mockRejectedValue(unsupported)
      const terminate = vi.spyOn(termination, 'terminateHostProcess').mockResolvedValue({
        kind: 'terminated',
        pid: host.pid,
        steps: [],
        swept: []
      })
      const adapter = createHostExternalLifecycleAdapter({
        profilePath: PROFILE_A,
        supervisor: supervisor(),
        preparedResult: { kind: 'existing', welcome, host: { ...host, birthIdentity } }
      })
      await adapter.start()
      await adapter.stop()
      expect(shutdown).toHaveBeenCalledOnce()
      expect(terminate).toHaveBeenCalledExactlyOnceWith({
        profilePath: PROFILE_A,
        expected,
        ports: { shutdown: expect.any(Function) }
      })
      await expect(
        terminate.mock.calls[0][0].ports!.shutdown!(PROFILE_A, { ackMs: 1, drainMs: 1 })
      ).rejects.toBe(unsupported)
      expect(adapter.isStopped).toBe(true)
    })

    it.each(['before stop', 'during shutdown'] as const)(
      'never acquires a successor birth when records change %s and attachment has no birth',
      async (when) => {
        let recordedBirth = birthIdentity
        const processStartedAt = '2026-09-23T09:59:55.000Z'
        vi.spyOn(registry, 'resolveHostRegistryRoot').mockReturnValue(resolve('/unit/registry'))
        const read = vi
          .spyOn(termination, 'readHostTerminationEvidence')
          .mockImplementation(() => ({
            discovery: { pid: host.pid, startedAt: host.startedAt, socketPath: '/unit/socket' },
            lease: {
              pid: host.pid,
              processStartIdentity: recordedBirth,
              processStartedAt,
              acquiredAt: processStartedAt
            },
            registry: { pid: host.pid, birthIdentity: recordedBirth, bootEpoch: null }
          }))
        const observe = vi
          .spyOn(processBirth, 'observeProcessBirthIdentity')
          .mockImplementation(async () => ({
            state: 'live',
            birthIdentity: recordedBirth,
            startedAtMs: Date.parse(processStartedAt)
          }))
        const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
          throw new Error('unit test must never signal a process')
        })
        const createShutdownClient = vi.fn(() => ({
          shutdown: vi.fn(async () => {
            recordedBirth = 'd'.repeat(64)
            throw new Error('pre-welcome socket failure')
          })
        }))
        const terminate = vi.fn(async () => ({ kind: 'terminated' as const, pid: host.pid }))
        const owner = supervisor()
        const adapter = createHostExternalLifecycleAdapter({
          profilePath: PROFILE_A,
          supervisor: owner,
          preparedResult: { kind: 'existing', welcome, host },
          createShutdownClient,
          terminate
        })
        await adapter.start()
        if (when === 'before stop') recordedBirth = 'd'.repeat(64)
        await expect(adapter.stop()).rejects.toMatchObject({
          name: 'HostShutdownIdentityError',
          reason: 'unavailable'
        })
        expect(createShutdownClient).toHaveBeenCalledWith(PROFILE_A, {
          pid: host.pid,
          startedAt: host.startedAt,
          birthIdentity: null
        })
        expect(read).not.toHaveBeenCalled()
        expect(observe).not.toHaveBeenCalled()
        expect(terminate).not.toHaveBeenCalled()
        expect(signal).not.toHaveBeenCalled()
        expect(owner.close).not.toHaveBeenCalled()
        expect(adapter.isRunning).toBe(true)
        adapter.stopSync()
      }
    )

    it.each(['unsupported', 'malformed status', 'post-welcome timeout'] as const)(
      'refuses signal fallback after %s when attachment has no birth',
      async (failure) => {
        const error =
          failure === 'unsupported'
            ? new HostShutdownUnsupportedError('Host status request is unsupported')
            : new HostShutdownIdentityError(failure, 'unavailable', host.pid)
        const terminate = vi.fn()
        const adapter = createHostExternalLifecycleAdapter({
          profilePath: PROFILE_A,
          supervisor: supervisor(),
          preparedResult: { kind: 'existing', welcome, host },
          createShutdownClient: () => ({
            shutdown: vi.fn(async () => {
              throw error
            })
          }),
          terminate
        })
        await adapter.start()
        await expect(adapter.stop()).rejects.toBeInstanceOf(HostShutdownIdentityError)
        expect(terminate).not.toHaveBeenCalled()
        adapter.stopSync()
      }
    )
  })

  it('has no Electron, AppStore, TUI, or dynamic-import dependency', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostExternalLifecycleAdapter.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/electron|AppStore|\.\.\/\.\.\/tui|import\s*\(/i)
  })
})
