import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostProfileAuthorityLease } from '../../host-runtime/HostProfileAuthorityLease'
import {
  HOST_PROFILE_WRITER_FENCE_PURPOSE,
  writeHostProfileWriterFence
} from '../../host-runtime/HostProfileWriterFence'
import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import { createLegacyStoreWriterGate } from '../store/LegacyStoreWriterGate'
import { readDesktopWriterFence } from './LegacyStoreWriterGatePersistence'
import type { PreparedExternalHost } from './HostExternalRuntimeState'
import type { HostExternalSupervisor } from './HostExternalSupervisor'
import { createHostExternalPreparation } from './HostExternalPreparation'

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

function supervisor(result: 'existing' | 'launched', order: string[] = []) {
  return {
    ensureAvailable: vi.fn(async () => {
      order.push('ready')
      return result === 'existing'
        ? { kind: 'existing' as const, welcome }
        : { kind: 'launched' as const, pid: 42, welcome }
    }),
    close: vi.fn(() => order.push('detach'))
  } as unknown as HostExternalSupervisor
}

const profiles: string[] = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'external-prep-fence-'))
  profiles.push(path)
  return path
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('HostExternalPreparation', () => {
  it('orders migration, writer drain, Host readiness, ownership, and publication', async () => {
    const order: string[] = []
    const gate = createLegacyStoreWriterGate()
    const owner = supervisor('existing', order)
    const publish = vi.fn((input: PreparedExternalHost) => {
      order.push('publish')
      expect(gate.snapshot()).toMatchObject({ state: 'host-owned', inFlight: 0 })
      return input
    })
    const preparation = createHostExternalPreparation({
      profilePath: '/profiles/a',
      migrateLegacyUserData: () => {
        order.push('migrate')
      },
      writerGate: gate,
      createSupervisor: () => {
        order.push('supervisor')
        expect(gate.snapshot().state).toBe('draining')
        return owner
      },
      createCutoverId: () => 'cutover-1',
      publishPrepared: publish,
      clearPrepared: vi.fn(() => true),
      createShutdownClient: () => ({ shutdown: vi.fn() })
    })

    await expect(preparation.prepare()).resolves.toMatchObject({
      profilePath: '/profiles/a',
      cutoverId: 'cutover-1',
      result: { kind: 'existing', welcome: { hostId: 'host-1', generation: 3 } }
    })
    expect(order).toEqual(['migrate', 'supervisor', 'ready', 'publish'])
    expect(gate.snapshot()).toMatchObject({
      state: 'host-owned',
      ownership: { hostId: 'host-1', generation: 3, cutoverId: 'cutover-1' }
    })
    expect(preparation.phase).toBe('prepared')
  })

  it('shuts down only a Host launched by the failed Desktop transaction', async () => {
    const gate = createLegacyStoreWriterGate()
    const order: string[] = []
    const owner = supervisor('launched', order)
    const shutdown = vi.fn(async () => {
      order.push('shutdown')
      return 'stopping' as const
    })
    const clear = vi.fn(() => {
      order.push('clear')
      owner.close()
      return true
    })
    const preparation = createHostExternalPreparation({
      profilePath: '/profiles/a',
      migrateLegacyUserData: vi.fn(),
      writerGate: gate,
      createSupervisor: () => owner,
      createCutoverId: () => 'cutover-1',
      publishPrepared: (input) => input,
      clearPrepared: clear,
      createShutdownClient: () => ({ shutdown })
    })

    await preparation.prepare()
    await Promise.all([preparation.cleanup(), preparation.cleanup()])
    expect(shutdown).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
    expect(owner.close).toHaveBeenCalledOnce()
    expect(order.indexOf('shutdown')).toBeLessThan(order.indexOf('clear'))
    expect(preparation.phase).toBe('cleaned')
  })

  it('rolls a failed readiness attempt back to open without stopping an existing Host', async () => {
    const gate = createLegacyStoreWriterGate()
    const owner = supervisor('existing')
    vi.mocked(owner.ensureAvailable).mockRejectedValueOnce(new Error('offline'))
    const shutdown = vi.fn()
    const preparation = createHostExternalPreparation({
      profilePath: '/profiles/a',
      migrateLegacyUserData: vi.fn(),
      writerGate: gate,
      createSupervisor: () => owner,
      publishPrepared: (input) => input,
      clearPrepared: vi.fn(() => true),
      createShutdownClient: () => ({ shutdown })
    })

    await expect(preparation.prepare()).rejects.toThrow('offline')
    expect(gate.snapshot().state).toBe('open')
    expect(shutdown).not.toHaveBeenCalled()
    expect(owner.close).toHaveBeenCalledOnce()
    expect(preparation.phase).toBe('failed')
  })

  it('preserves ownership-transfer failure when launched-Host cleanup also fails', async () => {
    let state: 'open' | 'draining' = 'open'
    const rollback = vi.fn(() => {
      state = 'open'
      return true
    })
    const log = vi.fn()
    const owner = supervisor('launched')
    const preparation = createHostExternalPreparation({
      profilePath: '/profiles/a',
      migrateLegacyUserData: vi.fn(),
      writerGate: {
        beginDrain: () => {
          state = 'draining'
          return true
        },
        awaitDrained: async () => undefined,
        markHostOwned: () => false,
        rollbackDrain: rollback,
        snapshot: () => ({ state, inFlight: 0, hostOwned: false })
      },
      createSupervisor: () => owner,
      publishPrepared: (input) => input,
      clearPrepared: vi.fn(() => true),
      createShutdownClient: () => ({
        shutdown: vi.fn(async () => {
          throw new Error('shutdown\nfailed')
        })
      }),
      log
    })

    await expect(preparation.prepare()).rejects.toThrow('ownership could not transfer')
    expect(rollback).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cleanup failed: shutdown failed'))
  })

  it('does not import Electron, AppStore, TUI, or the main composition root', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostExternalPreparation.ts'),
      'utf8'
    )
    expect(source).not.toMatch(
      /electron|AppStore|\.\.\/\.\.\/tui|from ['"]\.\.\/index|import\s*\(/i
    )
  })

  it('attaches to a live Host without overwriting the durable ownership record', async () => {
    const profilePath = profile()
    const lease = HostProfileAuthorityLease.acquire({ profilePath })
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: 'tui-host',
        generation: 4,
        cutoverId: 'cutover-existing',
        pid: lease.owner.pid
      }
    })
    const gate = createLegacyStoreWriterGate()
    const owner = supervisor('existing')
    const preparation = createHostExternalPreparation({
      profilePath,
      migrateLegacyUserData: vi.fn(),
      writerGate: gate,
      createSupervisor: () => owner,
      createCutoverId: () => 'cutover-should-not-write',
      publishPrepared: (input) => input,
      clearPrepared: vi.fn(() => true),
      createShutdownClient: () => ({ shutdown: vi.fn() })
    })

    await expect(preparation.prepare()).resolves.toMatchObject({
      profilePath,
      cutoverId: 'cutover-existing',
      result: { kind: 'existing', welcome: { hostId: 'host-1' } }
    })
    expect(gate.snapshot()).toMatchObject({
      state: 'host-owned',
      ownership: {
        hostId: 'tui-host',
        generation: 4,
        cutoverId: 'cutover-existing'
      }
    })
    expect(readDesktopWriterFence(profilePath)).toEqual({
      schemaVersion: 1,
      purpose: HOST_PROFILE_WRITER_FENCE_PURPOSE,
      state: 'host-owned',
      ownership: {
        hostId: 'tui-host',
        generation: 4,
        cutoverId: 'cutover-existing',
        pid: lease.owner.pid
      }
    })
    expect(gate.beginDrain()).toBe(false)
    expect(lease.release()).toBe(true)
  })

  it('persists the default writer gate so the Host can see ownership', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/host/HostExternalPreparation.ts'),
      'utf8'
    )
    expect(source).toContain(
      'persistLegacyStoreWriterGate(options.profilePath, legacyStoreWriterGate)'
    )
  })
})
