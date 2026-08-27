import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  HostProfileAuthorityLease,
  HostProfileAuthorityLeaseBusyError
} from '../../host-runtime/HostProfileAuthorityLease'
import {
  IN_PROCESS_DESKTOP_HOST_ID,
  writeHostProfileWriterFence
} from '../../host-runtime/HostProfileWriterFence'
import { createLegacyStoreWriterGate } from '../store/LegacyStoreWriterGate'
import { ProfileWriterLivePeerError } from './DesktopWriterArbitration'
import {
  DESKTOP_WRITER_FENCE_PURPOSE,
  persistLegacyStoreWriterGate,
  readDesktopWriterFence
} from './LegacyStoreWriterGatePersistence'
import {
  LEGACY_IN_PROCESS_CUTOVER_ID,
  LEGACY_IN_PROCESS_HOST_ID,
  drainLegacyStoreForInProcessHost
} from './LegacyInProcessHostWriter'

const profiles: string[] = []
const heldLeases: Array<{ release(): boolean }> = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'legacy-in-process-host-'))
  profiles.push(path)
  return path
}

function hold(lease: { release(): boolean } | null | undefined): typeof lease {
  if (lease) heldLeases.push(lease)
  return lease
}

afterEach(() => {
  while (heldLeases.length > 0) heldLeases.pop()!.release()
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('drainLegacyStoreForInProcessHost', () => {
  it('drains AppStore writers and marks the in-process Host as owner', async () => {
    const profilePath = profile()
    const gate = createLegacyStoreWriterGate()
    const lease = gate.admit({ operation: 'save', pathFamily: 'chats' })!
    let drained = false
    const waiting = drainLegacyStoreForInProcessHost({ profilePath, writerGate: gate }).then(
      (authority) => {
        drained = true
        return authority
      }
    )
    expect(drained).toBe(false)
    expect(gate.snapshot().state).toBe('draining')
    expect(readDesktopWriterFence(profilePath)).toMatchObject({ state: 'draining' })
    expect(lease.release()).toBe(true)
    const authority = hold(await waiting)
    expect(drained).toBe(true)
    expect(authority).not.toBeNull()
    authority!.assertHeld()
    expect(gate.snapshot()).toMatchObject({
      state: 'host-owned',
      hostOwned: true,
      ownership: {
        hostId: LEGACY_IN_PROCESS_HOST_ID,
        generation: 0,
        cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID,
        pid: process.pid
      }
    })
    expect(readDesktopWriterFence(profilePath)).toEqual({
      schemaVersion: 1,
      purpose: DESKTOP_WRITER_FENCE_PURPOSE,
      state: 'host-owned',
      ownership: {
        hostId: LEGACY_IN_PROCESS_HOST_ID,
        generation: 0,
        cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID,
        pid: process.pid
      }
    })
    expect(gate.admit({ operation: 'save', pathFamily: 'chats' })).toBeNull()
    expect(HostProfileAuthorityLease.peek({ profilePath }).kind).toBe('live')
  })

  it('is a no-op when the gate is already host-owned', async () => {
    const profilePath = profile()
    const gate = createLegacyStoreWriterGate()
    expect(gate.beginDrain()).toBe(true)
    expect(
      gate.markHostOwned({ hostId: 'existing-host', generation: 4, cutoverId: 'cutover-existing' })
    ).toBe(true)
    await drainLegacyStoreForInProcessHost({ profilePath, writerGate: gate })
    expect(gate.snapshot().ownership).toEqual({
      hostId: 'existing-host',
      generation: 4,
      cutoverId: 'cutover-existing'
    })
    expect(readDesktopWriterFence(profilePath)).toBeNull()
    expect(HostProfileAuthorityLease.peek({ profilePath }).kind).toBe('absent')
  })

  it('refuses in-process fallback when a live Host lease already owns the profile', async () => {
    const profilePath = profile()
    const lease = hold(HostProfileAuthorityLease.acquire({ profilePath }))
    const gate = createLegacyStoreWriterGate()
    await expect(
      drainLegacyStoreForInProcessHost({ profilePath, writerGate: gate })
    ).rejects.toThrow(ProfileWriterLivePeerError)
    expect(gate.snapshot().state).toBe('open')
    expect(readDesktopWriterFence(profilePath)).toBeNull()
    expect(lease.release()).toBe(true)
  })

  it('does not overwrite a live in-process peer ownership record', async () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: IN_PROCESS_DESKTOP_HOST_ID,
        generation: 0,
        cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID,
        pid: 77
      }
    })
    const gate = createLegacyStoreWriterGate()
    await expect(
      drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: gate,
        inspect: {
          currentPid: process.pid,
          inspectPid: () => 'live',
          peekLease: () => ({ kind: 'absent' })
        }
      })
    ).rejects.toThrow(ProfileWriterLivePeerError)
    expect(readDesktopWriterFence(profilePath)?.ownership).toEqual({
      hostId: IN_PROCESS_DESKTOP_HOST_ID,
      generation: 0,
      cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID,
      pid: 77
    })
    expect(gate.snapshot().state).toBe('open')
    expect(HostProfileAuthorityLease.peek({ profilePath }).kind).toBe('absent')
  })

  it('reclaims a stale in-process fence then takes ownership', async () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: IN_PROCESS_DESKTOP_HOST_ID,
        generation: 0,
        cutoverId: 'stale-cutover',
        pid: 9_999_999
      }
    })
    const gate = createLegacyStoreWriterGate()
    hold(
      await drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: gate,
        inspect: {
          inspectPid: () => 'stale',
          peekLease: () => ({ kind: 'absent' })
        }
      })
    )
    expect(readDesktopWriterFence(profilePath)).toMatchObject({
      state: 'host-owned',
      ownership: {
        hostId: LEGACY_IN_PROCESS_HOST_ID,
        cutoverId: LEGACY_IN_PROCESS_CUTOVER_ID,
        pid: process.pid
      }
    })
    expect(HostProfileAuthorityLease.peek({ profilePath }).kind).toBe('live')
  })

  it('is a no-op when this process already owns the in-process fence', async () => {
    const profilePath = profile()
    const gate = createLegacyStoreWriterGate()
    hold(await drainLegacyStoreForInProcessHost({ profilePath, writerGate: gate }))
    const first = readDesktopWriterFence(profilePath)
    await drainLegacyStoreForInProcessHost({
      profilePath,
      writerGate: createLegacyStoreWriterGate()
    })
    expect(readDesktopWriterFence(profilePath)).toEqual(first)
  })

  it('holds the authority lease so a concurrent Host acquire cannot open writers', async () => {
    const profilePath = profile()
    const lease = hold(
      await drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: createLegacyStoreWriterGate()
      })
    )
    expect(lease).not.toBeNull()
    expect(() => HostProfileAuthorityLease.acquire({ profilePath })).toThrow(
      HostProfileAuthorityLeaseBusyError
    )
    lease!.assertHeld()
  })

  it('loses to a Host that acquires the authority lease during the in-process TOCTOU window', async () => {
    const profilePath = profile()
    const gate = createLegacyStoreWriterGate()
    let hostLease: HostProfileAuthorityLease | undefined
    await expect(
      drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: gate,
        onBeforeAcquire: () => {
          hostLease = HostProfileAuthorityLease.acquire({ profilePath })
        }
      })
    ).rejects.toThrow(ProfileWriterLivePeerError)
    expect(hostLease).toBeDefined()
    hold(hostLease)
    hostLease!.assertHeld()
    expect(readDesktopWriterFence(profilePath)).toBeNull()
    expect(gate.snapshot().state).toBe('open')
  })

  it('elects exactly one winner when two in-process drains race the authority lease', async () => {
    const profilePath = profile()
    let resume!: () => void
    const barrier = new Promise<void>((resolve) => {
      resume = resolve
    })
    let ready = 0
    const waitForPeer = async (): Promise<void> => {
      ready += 1
      if (ready === 2) resume()
      await barrier
    }

    const results = await Promise.allSettled([
      drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: createLegacyStoreWriterGate(),
        onBeforeAcquire: waitForPeer
      }),
      drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: createLegacyStoreWriterGate(),
        onBeforeAcquire: waitForPeer
      })
    ])

    const won = results.filter(
      (result): result is PromiseFulfilledResult<HostProfileAuthorityLease | null> =>
        result.status === 'fulfilled'
    )
    const lost = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toBeInstanceOf(ProfileWriterLivePeerError)
    const winner = hold(won[0]!.value)
    expect(winner).not.toBeNull()
    winner!.assertHeld()
    expect(HostProfileAuthorityLease.peek({ profilePath }).kind).toBe('live')
    expect(() => HostProfileAuthorityLease.acquire({ profilePath })).toThrow(
      HostProfileAuthorityLeaseBusyError
    )
  })

  it('releases the authority lease when in-process ownership transfer fails', async () => {
    const profilePath = profile()
    await expect(
      drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: {
          beginDrain: () => false,
          awaitDrained: async () => undefined,
          markHostOwned: () => false,
          rollbackDrain: () => false,
          snapshot: () => ({ state: 'open', inFlight: 0, hostOwned: false })
        }
      })
    ).rejects.toThrow(/could not begin/)
    expect(HostProfileAuthorityLease.peek({ profilePath }).kind).toBe('absent')
    expect(readDesktopWriterFence(profilePath)).toBeNull()
  })
})

describe('persistLegacyStoreWriterGate', () => {
  it('clears the durable fence when drain rolls back to open', async () => {
    const profilePath = profile()
    const gate = persistLegacyStoreWriterGate(profilePath, createLegacyStoreWriterGate())
    expect(gate.beginDrain()).toBe(true)
    expect(readDesktopWriterFence(profilePath)?.state).toBe('draining')
    expect(gate.rollbackDrain()).toBe(true)
    expect(gate.snapshot().state).toBe('open')
    expect(readDesktopWriterFence(profilePath)).toBeNull()
  })
})
