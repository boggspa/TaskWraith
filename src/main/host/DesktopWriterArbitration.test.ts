import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { HostProfileAuthorityLease } from '../../host-runtime/HostProfileAuthorityLease'
import {
  IN_PROCESS_DESKTOP_HOST_ID,
  writeHostProfileWriterFence
} from '../../host-runtime/HostProfileWriterFence'
import { createLegacyStoreWriterGate } from '../store/LegacyStoreWriterGate'
import {
  ProfileWriterLivePeerError,
  arbitrateDesktopProfileWriters
} from './DesktopWriterArbitration'
import { drainLegacyStoreForInProcessHost } from './LegacyInProcessHostWriter'
import { readDesktopWriterFence } from './LegacyStoreWriterGatePersistence'

const profiles: string[] = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'desktop-writer-arb-'))
  profiles.push(path)
  return path
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('arbitrateDesktopProfileWriters', () => {
  it('hydrates a live Host owner for external prepare and refuses in-process fallback', () => {
    const profilePath = profile()
    const lease = HostProfileAuthorityLease.acquire({ profilePath })
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: 'tui-host',
        generation: 1,
        cutoverId: 'cutover-tui',
        pid: lease.owner.pid
      }
    })
    const attach = createLegacyStoreWriterGate()
    expect(
      arbitrateDesktopProfileWriters({
        profilePath,
        gate: attach,
        intent: 'external-prepare'
      })
    ).toBe('already-host-owned')
    expect(attach.snapshot().ownership).toMatchObject({
      hostId: 'tui-host',
      cutoverId: 'cutover-tui'
    })
    const fallback = createLegacyStoreWriterGate()
    expect(() =>
      arbitrateDesktopProfileWriters({
        profilePath,
        gate: fallback,
        intent: 'in-process'
      })
    ).toThrow(ProfileWriterLivePeerError)
    expect(fallback.snapshot().state).toBe('open')
    expect(readDesktopWriterFence(profilePath)?.ownership?.cutoverId).toBe('cutover-tui')
    expect(lease.release()).toBe(true)
  })

  it('reclaims stale ownership so a restart can open writers', () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: IN_PROCESS_DESKTOP_HOST_ID,
        generation: 0,
        cutoverId: 'dead-desktop',
        pid: 9_999_999
      }
    })
    const gate = createLegacyStoreWriterGate()
    expect(
      arbitrateDesktopProfileWriters({
        profilePath,
        gate,
        intent: 'in-process',
        inspect: {
          inspectPid: () => 'stale',
          peekLease: () => ({ kind: 'absent' })
        }
      })
    ).toBe('open')
    expect(gate.snapshot().state).toBe('open')
    expect(readDesktopWriterFence(profilePath)).toBeNull()
  })

  it('fails closed when two in-process Desktops start against one live ownership record', async () => {
    const profilePath = profile()
    const first = createLegacyStoreWriterGate()
    await drainLegacyStoreForInProcessHost({ profilePath, writerGate: first })
    const owned = readDesktopWriterFence(profilePath)
    const second = createLegacyStoreWriterGate()
    await expect(
      drainLegacyStoreForInProcessHost({
        profilePath,
        writerGate: second,
        inspect: {
          currentPid: -1,
          inspectPid: () => 'live',
          peekLease: () => ({ kind: 'absent' })
        }
      })
    ).rejects.toThrow(ProfileWriterLivePeerError)
    expect(readDesktopWriterFence(profilePath)).toEqual(owned)
    expect(second.snapshot().state).toBe('open')
  })
})
