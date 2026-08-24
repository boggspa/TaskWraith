import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HostDiagnosticServer,
  type HostDiagnosticLeasePort,
  type HostDiagnosticServerPort,
  type HostDiagnosticSignalTarget
} from './HostDiagnosticServer'
import type { HostDiagnosticInstallIdentity } from './HostDiagnosticIdentity'

const profiles: string[] = []
const IDENTITY: HostDiagnosticInstallIdentity = {
  installId: 'a'.repeat(48),
  hostId: `taskwraith-diagnostic-${'a'.repeat(48)}`,
  hostVersion: 'diagnostic-test'
}

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-host-diagnostic-'))
  profiles.push(path)
  return path
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true })
})

function signalTarget(): {
  target: HostDiagnosticSignalTarget
  listeners: Map<NodeJS.Signals, () => void>
} {
  const listeners = new Map<NodeJS.Signals, () => void>()
  return {
    target: {
      once: (signal, listener) => {
        listeners.set(signal, listener)
      },
      removeListener: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal)
      }
    },
    listeners
  }
}

function lease(profilePath: string, release = vi.fn(() => true)): HostDiagnosticLeasePort {
  return { path: profilePath, release }
}

function hostOptions(
  profilePath: string,
  overrides: Partial<ConstructorParameters<typeof HostDiagnosticServer>[0]> = {}
) {
  const signals = signalTarget()
  const authorityLease = lease(profilePath)
  return {
    signals,
    authorityLease,
    options: {
      profilePath,
      mode: 'diagnostic' as const,
      signalTarget: signals.target,
      acquireLease: () => authorityLease,
      resolveInstallIdentity: () => IDENTITY,
      ...overrides
    }
  }
}

describe('HostDiagnosticServer', () => {
  it('acquires authority before creating transport artifacts and releases it after server cleanup', async () => {
    const profilePath = profile()
    const stop = vi.fn(async () => undefined)
    const createServer = vi.fn(
      (): HostDiagnosticServerPort => ({
        start: vi.fn(async () => undefined),
        stop
      })
    )
    const fixture = hostOptions(profilePath, { createServer })
    const host = new HostDiagnosticServer(fixture.options)

    await host.start()
    expect(createServer).toHaveBeenCalledOnce()
    expect(host.identity).toEqual(IDENTITY)
    expect(host.session?.size()).toBe(0)
    expect(host.phase).toBe('running')
    expect(fixture.signals.listeners.has('SIGINT')).toBe(true)
    expect(fixture.signals.listeners.has('SIGTERM')).toBe(true)

    fixture.signals.listeners.get('SIGTERM')?.()
    fixture.signals.listeners.get('SIGINT')?.()
    await host.waitForShutdown()

    expect(stop).toHaveBeenCalledOnce()
    expect(fixture.authorityLease.release).toHaveBeenCalledOnce()
    expect(host.phase).toBe('stopped')
    expect(fixture.signals.listeners.size).toBe(0)
  })

  it('requests stop during server.start and cleans the late listener before it can remain live', async () => {
    const profilePath = profile()
    let finishStart!: () => void
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve
        })
    )
    const stop = vi.fn(async () => undefined)
    const fixture = hostOptions(profilePath, {
      createServer: () => ({ start, stop })
    })
    const host = new HostDiagnosticServer(fixture.options)

    const starting = host.start()
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    fixture.signals.listeners.get('SIGTERM')?.()
    expect(host.phase).toBe('stopping')
    finishStart()

    await starting
    await host.waitForShutdown()
    expect(stop).toHaveBeenCalledOnce()
    expect(fixture.authorityLease.release).toHaveBeenCalledOnce()
    expect(host.phase).toBe('stopped')
  })

  it('observes parent loss before listener startup and releases the lease without starting transport', async () => {
    const profilePath = profile()
    const createServer = vi.fn(
      (): HostDiagnosticServerPort => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      })
    )
    const fixture = hostOptions(profilePath, {
      parentPid: 101,
      isParentAlive: () => false,
      createServer
    })
    const host = new HostDiagnosticServer(fixture.options)

    await host.start()
    await host.waitForShutdown()

    expect(createServer).not.toHaveBeenCalled()
    expect(fixture.authorityLease.release).toHaveBeenCalledOnce()
    expect(host.phase).toBe('stopped')
  })

  it('observes parent loss during server.start and cleans the late listener', async () => {
    const profilePath = profile()
    let finishStart!: () => void
    let parentAlive = true
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve
        })
    )
    const stop = vi.fn(async () => undefined)
    const fixture = hostOptions(profilePath, {
      parentPid: 101,
      parentPollMs: 1,
      isParentAlive: () => parentAlive,
      createServer: () => ({ start, stop })
    })
    const host = new HostDiagnosticServer(fixture.options)

    const starting = host.start()
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    parentAlive = false
    await vi.waitFor(() => expect(host.phase).toBe('stopping'))
    finishStart()

    await starting
    await host.waitForShutdown()
    expect(stop).toHaveBeenCalledOnce()
    expect(fixture.authorityLease.release).toHaveBeenCalledOnce()
    expect(host.phase).toBe('stopped')
  })

  it('honors an explicit stop request during server.start', async () => {
    const profilePath = profile()
    let finishStart!: () => void
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve
        })
    )
    const stop = vi.fn(async () => undefined)
    const fixture = hostOptions(profilePath, {
      createServer: () => ({ start, stop })
    })
    const host = new HostDiagnosticServer(fixture.options)

    const starting = host.start()
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const stopping = host.stop()
    expect(host.phase).toBe('stopping')
    finishStart()

    await starting
    await stopping
    expect(stop).toHaveBeenCalledOnce()
    expect(fixture.authorityLease.release).toHaveBeenCalledOnce()
    expect(host.phase).toBe('stopped')
  })

  it('retains profile authority and reports failure when server cleanup fails', async () => {
    const profilePath = profile()
    const stop = vi.fn(async () => {
      throw new Error('socket cleanup failed')
    })
    const fixture = hostOptions(profilePath, {
      createServer: () => ({ start: async () => undefined, stop })
    })
    const host = new HostDiagnosticServer(fixture.options)

    await host.start()
    await expect(host.stop()).rejects.toThrow(/retaining profile authority/)
    await expect(host.waitForShutdown()).rejects.toThrow(/retaining profile authority/)

    expect(fixture.authorityLease.release).not.toHaveBeenCalled()
    expect(host.phase).toBe('failed')
  })

  it('fails shutdown when exact lease release cannot be proven', async () => {
    const profilePath = profile()
    const release = vi.fn(() => false)
    const fixture = hostOptions(profilePath, {
      acquireLease: () => lease(profilePath, release),
      createServer: () => ({ start: async () => undefined, stop: async () => undefined })
    })
    const host = new HostDiagnosticServer(fixture.options)

    await host.start()
    const shutdown = host.waitForShutdown()
    await expect(host.stop()).rejects.toThrow(/could not prove profile authority release/)
    await expect(shutdown).rejects.toThrow(/could not prove profile authority release/)
    expect(release).toHaveBeenCalledOnce()
    expect(host.phase).toBe('failed')
  })

  it('does not accept a non-diagnostic mode through the programmatic API', () => {
    expect(
      () => new HostDiagnosticServer({ profilePath: profile(), mode: 'production' as 'diagnostic' })
    ).toThrow(/Only diagnostic Host mode/)
  })

  it('rejects a stop request before profile authority acquisition', async () => {
    const host = new HostDiagnosticServer(hostOptions(profile()).options)
    await expect(host.stop()).rejects.toThrow(/must start before stopping/)
    expect(host.phase).toBe('idle')
  })
})
