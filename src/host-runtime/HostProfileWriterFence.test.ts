import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { HostProfileAuthorityLease } from './HostProfileAuthorityLease'
import {
  HOST_PROFILE_WRITER_FENCE_PURPOSE,
  IN_PROCESS_DESKTOP_HOST_ID,
  ProfileWriterLivePeerError,
  assertHostMayOpenProfileWriters,
  clearHostProfileWriterFence,
  inspectProfileWriterPeers,
  readHostProfileWriterFence,
  writeHostProfileWriterFence
} from './HostProfileWriterFence'

const profiles: string[] = []

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'host-profile-writer-fence-'))
  profiles.push(path)
  return path
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('HostProfileWriterFence', () => {
  it('round-trips a host-owned fence with pid', () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: 'host-1',
        generation: 3,
        cutoverId: 'cutover-1',
        pid: 4242
      }
    })
    expect(readHostProfileWriterFence(profilePath)).toEqual({
      schemaVersion: 1,
      purpose: HOST_PROFILE_WRITER_FENCE_PURPOSE,
      state: 'host-owned',
      ownership: {
        hostId: 'host-1',
        generation: 3,
        cutoverId: 'cutover-1',
        pid: 4242
      }
    })
    expect(clearHostProfileWriterFence(profilePath)).toBe(true)
    expect(readHostProfileWriterFence(profilePath)).toBeNull()
  })

  it('treats a live Host authority lease as a live host peer', () => {
    const profilePath = profile()
    const lease = HostProfileAuthorityLease.acquire({
      profilePath,
      processPort: {
        current: {
          pid: 101,
          processStartIdentity: 'process-start-101-v1',
          processStartedAt: '2026-08-24T00:59:00.000Z'
        },
        inspectOwner: () => 'live'
      }
    })
    expect(
      inspectProfileWriterPeers(profilePath, {
        peekLease: () => ({ kind: 'live', owner: lease.owner })
      })
    ).toMatchObject({
      status: 'live-host',
      pid: 101
    })
    lease.release()
  })

  it('fails closed for a live in-process Desktop owner that is not this process', () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: IN_PROCESS_DESKTOP_HOST_ID,
        generation: 0,
        cutoverId: 'legacy-in-process',
        pid: 77
      }
    })
    expect(
      inspectProfileWriterPeers(profilePath, {
        currentPid: process.pid,
        inspectPid: () => 'live',
        peekLease: () => ({ kind: 'absent' })
      })
    ).toMatchObject({ status: 'live-in-process', pid: 77 })
    expect(() =>
      assertHostMayOpenProfileWriters(profilePath, {
        inspectPid: () => 'live',
        peekLease: () => ({ kind: 'absent' })
      })
    ).toThrow(ProfileWriterLivePeerError)
  })

  it('reclaims a stale in-process owner and a host-owned fence with no live lease', () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: IN_PROCESS_DESKTOP_HOST_ID,
        generation: 0,
        cutoverId: 'legacy-in-process',
        pid: 9_999_999
      }
    })
    expect(
      inspectProfileWriterPeers(profilePath, {
        inspectPid: () => 'stale',
        peekLease: () => ({
          kind: 'stale',
          owner: {
            schemaVersion: 1,
            purpose: 'taskwraith:host-profile-authority-owner:v1',
            pid: 9,
            processStartIdentity: 'process-start-9-v1',
            processStartedAt: '2026-08-24T00:59:00.000Z',
            acquiredAt: '2026-08-24T01:00:00.000Z',
            token: 'aa'.repeat(32)
          }
        })
      })
    ).toEqual({ status: 'stale' })
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: { hostId: 'tui-host', generation: 1, cutoverId: 'cutover-old', pid: 12 }
    })
    expect(
      inspectProfileWriterPeers(profilePath, { peekLease: () => ({ kind: 'absent' }) })
    ).toEqual({
      status: 'stale'
    })
  })

  it('fails closed when in-process ownership has no pid', () => {
    const profilePath = profile()
    writeHostProfileWriterFence(profilePath, {
      state: 'host-owned',
      ownership: {
        hostId: IN_PROCESS_DESKTOP_HOST_ID,
        generation: 0,
        cutoverId: 'legacy-in-process'
      }
    })
    expect(
      inspectProfileWriterPeers(profilePath, { peekLease: () => ({ kind: 'absent' }) })
    ).toEqual({
      status: 'unknown',
      reason: 'in-process-owner-missing-pid'
    })
  })
})
