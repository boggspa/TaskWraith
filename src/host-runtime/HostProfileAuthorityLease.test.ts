import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_PROFILE_AUTHORITY_LEASE_FILENAME,
  HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES,
  HOST_PROFILE_AUTHORITY_RECLAIM_GUARD_FILENAME,
  HostProfileAuthorityLease,
  HostProfileAuthorityLeaseBlockedError,
  HostProfileAuthorityLeaseBusyError,
  type HostProfileAuthorityLeaseFs,
  type HostProfileAuthorityLeaseOptions,
  type HostProfileAuthorityOwnerLiveness,
  type HostProfileAuthorityProcessIdentity
} from './HostProfileAuthorityLease'

const OWNER_PURPOSE = 'taskwraith:host-profile-authority-owner:v1'
const NOW = new Date('2026-08-24T01:00:00.000Z')
const STARTED_AT = '2026-08-24T00:59:00.000Z'
const temporaryProfiles: string[] = []

afterEach(() => {
  for (const profile of temporaryProfiles.splice(0)) {
    rmSync(profile, { recursive: true, force: true })
  }
})

describe('HostProfileAuthorityLease', () => {
  it('atomically elects one owner and persists a canonical owner-only record', () => {
    const profile = createProfile()
    const first = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 101 }))
    const recordPath = ownerPath(profile)
    const raw = readFileSync(recordPath, 'utf8')

    expect(raw).toBe(`${JSON.stringify(first.owner)}\n`)
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 1,
      purpose: OWNER_PURPOSE,
      pid: 101,
      processStartIdentity: 'process-start-101-v1',
      processStartedAt: STARTED_AT,
      acquiredAt: NOW.toISOString(),
      token: first.owner.token
    })

    expect(
      HostProfileAuthorityLease.peek(hostOptions(profile, { pid: 202, liveness: () => 'live' }))
    ).toMatchObject({
      kind: 'live',
      owner: { pid: 101 }
    })
    const secondOptions = hostOptions(profile, {
      pid: 202,
      liveness: (owner) => (owner.pid === 101 ? 'live' : 'unknown')
    })
    expect(() => HostProfileAuthorityLease.acquire(secondOptions)).toThrow(
      HostProfileAuthorityLeaseBusyError
    )
    expect(readFileSync(recordPath, 'utf8')).toBe(raw)

    if (process.platform !== 'win32') {
      expect(nodeFs.statSync(profile).mode & 0o777).toBe(0o700)
      expect(nodeFs.statSync(recordPath).mode & 0o777).toBe(0o600)
    }

    expect(first.release()).toBe(true)
    expect(first.release()).toBe(false)
    expect(nodeFs.existsSync(recordPath)).toBe(false)
  })

  it('peeks absent and stale owners without mkdir or acquire', () => {
    expect(
      HostProfileAuthorityLease.peek({
        profilePath: join(tmpdir(), 'host-authority-peek-missing')
      })
    ).toEqual({ kind: 'absent' })
    const profile = createProfile()
    expect(HostProfileAuthorityLease.peek({ profilePath: profile })).toEqual({ kind: 'absent' })
    const stale = HostProfileAuthorityLease.acquire(
      hostOptions(profile, { pid: 101, liveness: () => 'stale' })
    )
    expect(
      HostProfileAuthorityLease.peek(hostOptions(profile, { pid: 202, liveness: () => 'stale' }))
    ).toMatchObject({ kind: 'stale', owner: { pid: 101 } })
    expect(stale.release()).toBe(true)
    expect(HostProfileAuthorityLease.peek({ profilePath: profile })).toEqual({ kind: 'absent' })
  })

  it('fails closed on malformed, oversized, and linked owner records', () => {
    const malformedProfile = createProfile()
    writeFileSync(ownerPath(malformedProfile), '{"pid":101}\n', { mode: 0o600 })
    expect(() =>
      HostProfileAuthorityLease.acquire(hostOptions(malformedProfile, { pid: 202 }))
    ).toThrow(HostProfileAuthorityLeaseBlockedError)
    expect(readFileSync(ownerPath(malformedProfile), 'utf8')).toBe('{"pid":101}\n')

    const oversizedProfile = createProfile()
    const oversized = 'x'.repeat(HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES + 1)
    writeFileSync(ownerPath(oversizedProfile), oversized, { mode: 0o600 })
    expect(() =>
      HostProfileAuthorityLease.acquire(hostOptions(oversizedProfile, { pid: 202 }))
    ).toThrow(/record limit/i)
    expect(readFileSync(ownerPath(oversizedProfile), 'utf8')).toBe(oversized)

    if (process.platform !== 'win32') {
      const linkedProfile = createProfile()
      const target = join(linkedProfile, 'foreign-owner.json')
      writeFileSync(target, JSON.stringify(ownerRecord(303, opaqueToken(3))) + '\n', {
        mode: 0o600
      })
      symlinkSync(target, ownerPath(linkedProfile))
      expect(() =>
        HostProfileAuthorityLease.acquire(hostOptions(linkedProfile, { pid: 404 }))
      ).toThrow(HostProfileAuthorityLeaseBlockedError)
      expect(nodeFs.lstatSync(ownerPath(linkedProfile)).isSymbolicLink()).toBe(true)
    }
  })

  it('assertHeld proves the exact unreleased owner inode/token', () => {
    const profile = createProfile()
    const lease = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 101 }))
    expect(() => lease.assertHeld()).not.toThrow()
    writeFileSync(ownerPath(profile), JSON.stringify({ ...lease.owner, pid: 999 }) + '\n')
    if (process.platform !== 'win32') nodeFs.chmodSync(ownerPath(profile), 0o600)
    expect(() => lease.assertHeld()).toThrow(HostProfileAuthorityLeaseBlockedError)
    writeFileSync(ownerPath(profile), JSON.stringify(lease.owner) + '\n')
    if (process.platform !== 'win32') nodeFs.chmodSync(ownerPath(profile), 0o600)
    expect(() => lease.assertHeld()).not.toThrow()
    unlinkSync(ownerPath(profile))
    expect(() => lease.assertHeld()).toThrow(HostProfileAuthorityLeaseBlockedError)

    const replacement = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 202 }))
    expect(() => lease.assertHeld()).toThrow(HostProfileAuthorityLeaseBlockedError)
    expect(() => replacement.assertHeld()).not.toThrow()
    expect(replacement.release()).toBe(true)

    const released = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 303 }))
    expect(released.release()).toBe(true)
    expect(() => released.assertHeld()).toThrow(HostProfileAuthorityLeaseBlockedError)
  })

  it('reclaims only a proven-stale owner and an old lease cannot release its successor', () => {
    const profile = createProfile()
    const stale = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 101 }))
    const replacement = HostProfileAuthorityLease.acquire(
      hostOptions(profile, {
        pid: 202,
        liveness: (owner) => (owner.pid === 101 ? 'stale' : 'live')
      })
    )

    expect(replacement.owner.token).not.toBe(stale.owner.token)
    expect(stale.release()).toBe(false)
    expect(JSON.parse(readFileSync(ownerPath(profile), 'utf8'))).toMatchObject({
      pid: 202,
      token: replacement.owner.token
    })
    expect(nodeFs.existsSync(reclaimGuardPath(profile))).toBe(false)
    expect(replacement.dispose()).toBe(true)
  })

  it('serializes release against a stale-owner reclaimer', () => {
    const profile = createProfile()
    let nestedError: unknown
    const incumbent = HostProfileAuthorityLease.acquire(
      hostOptions(profile, {
        pid: 101,
        onReclaimGuardAcquired: () => {
          try {
            HostProfileAuthorityLease.acquire(
              hostOptions(profile, {
                pid: 202,
                liveness: (owner) => (owner.pid === 101 ? 'stale' : 'live')
              })
            )
          } catch (error) {
            nestedError = error
          }
        }
      })
    )

    expect(incumbent.release()).toBe(true)
    expect(nestedError).toBeInstanceOf(HostProfileAuthorityLeaseBlockedError)
    expect(nodeFs.existsSync(ownerPath(profile))).toBe(false)
    expect(nodeFs.existsSync(reclaimGuardPath(profile))).toBe(false)
  })

  it('does not reclaim live or indeterminate owners', () => {
    for (const liveness of ['live', 'unknown'] as const) {
      const profile = createProfile()
      const incumbent = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 101 }))
      const raw = readFileSync(ownerPath(profile), 'utf8')

      let thrown: unknown
      try {
        HostProfileAuthorityLease.acquire(
          hostOptions(profile, {
            pid: 202,
            liveness: () => liveness
          })
        )
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(HostProfileAuthorityLeaseBusyError)
      expect((thrown as HostProfileAuthorityLeaseBusyError).liveness).toBe(liveness)
      expect(readFileSync(ownerPath(profile), 'utf8')).toBe(raw)
      expect(incumbent.release()).toBe(true)
    }
  })

  it('fails closed rather than adopting a record whose permissions expose its token', () => {
    if (process.platform === 'win32') return
    const profile = createProfile()
    const incumbent = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 101 }))
    nodeFs.chmodSync(ownerPath(profile), 0o644)

    expect(() =>
      HostProfileAuthorityLease.acquire(
        hostOptions(profile, {
          pid: 202,
          liveness: () => 'stale'
        })
      )
    ).toThrow(/owner-only authority-file permissions/i)
    expect(readFileSync(ownerPath(profile), 'utf8')).toBe(`${JSON.stringify(incumbent.owner)}\n`)
  })

  it('serializes stale-owner reclaimers behind an exclusive guard', () => {
    const profile = createProfile()
    const stale = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 101 }))
    let nestedError: unknown
    const winner = HostProfileAuthorityLease.acquire(
      hostOptions(profile, {
        pid: 202,
        liveness: (owner) => {
          if (owner.pid === 101) return 'stale'
          if (owner.pid === 202) return 'live'
          return 'unknown'
        },
        onReclaimGuardAcquired: () => {
          try {
            HostProfileAuthorityLease.acquire(
              hostOptions(profile, {
                pid: 303,
                liveness: (owner) => {
                  if (owner.pid === 101) return 'stale'
                  if (owner.pid === 202) return 'live'
                  return 'unknown'
                }
              })
            )
          } catch (error) {
            nestedError = error
          }
        }
      })
    )

    expect(nestedError).toBeInstanceOf(HostProfileAuthorityLeaseBlockedError)
    expect(readFileSync(ownerPath(profile), 'utf8')).toBe(`${JSON.stringify(winner.owner)}\n`)
    expect(nodeFs.existsSync(reclaimGuardPath(profile))).toBe(false)
    expect(stale.release()).toBe(false)
    expect(winner.release()).toBe(true)
  })

  it('revalidates the exact stale file after acquiring the guard and preserves a raced successor', () => {
    const profile = createProfile()
    const stale = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 101 }))
    const successor = ownerRecord(404, opaqueToken(44))
    const recordPath = ownerPath(profile)

    expect(() =>
      HostProfileAuthorityLease.acquire(
        hostOptions(profile, {
          pid: 202,
          liveness: (owner) => {
            if (owner.pid === 101) return 'stale'
            if (owner.pid === 404) return 'live'
            return 'unknown'
          },
          onReclaimGuardAcquired: () => {
            rmSync(recordPath)
            writeFileSync(recordPath, `${JSON.stringify(successor)}\n`, { mode: 0o600 })
          }
        })
      )
    ).toThrow(HostProfileAuthorityLeaseBusyError)

    expect(readFileSync(recordPath, 'utf8')).toBe(`${JSON.stringify(successor)}\n`)
    expect(nodeFs.existsSync(reclaimGuardPath(profile))).toBe(false)
    expect(stale.release()).toBe(false)
    expect(readFileSync(recordPath, 'utf8')).toBe(`${JSON.stringify(successor)}\n`)
  })

  it('uses injected filesystem, clock, process, and identity seams', () => {
    const profile = createProfile()
    const baseFs = nodeFs as unknown as HostProfileAuthorityLeaseFs
    const observedCreateFlags: number[] = []
    let ownerOnlyMode: number | undefined
    const fs: HostProfileAuthorityLeaseFs = {
      ...baseFs,
      openSync: (path, flags, mode) => {
        if (
          path.endsWith(HOST_PROFILE_AUTHORITY_LEASE_FILENAME) &&
          (flags & baseFs.constants.O_EXCL) !== 0
        ) {
          observedCreateFlags.push(flags)
        }
        return baseFs.openSync(path, flags, mode)
      },
      fchmodSync: (descriptor, mode) => {
        ownerOnlyMode = mode
        baseFs.fchmodSync(descriptor, mode)
      }
    }
    const lease = HostProfileAuthorityLease.acquire(
      hostOptions(profile, {
        pid: 515,
        fs,
        clock: { now: () => new Date(NOW) },
        tokens: [opaqueToken(515)]
      })
    )

    expect(observedCreateFlags).toHaveLength(1)
    expect(observedCreateFlags[0] & baseFs.constants.O_CREAT).not.toBe(0)
    expect(observedCreateFlags[0] & baseFs.constants.O_EXCL).not.toBe(0)
    if (baseFs.constants.O_NOFOLLOW) {
      expect(observedCreateFlags[0] & baseFs.constants.O_NOFOLLOW).not.toBe(0)
    }
    if (process.platform !== 'win32') expect(ownerOnlyMode).toBe(0o600)
    expect(lease.owner).toMatchObject({
      pid: 515,
      token: opaqueToken(515),
      acquiredAt: NOW.toISOString()
    })
    expect(lease.release()).toBe(true)
  })

  it('does not leave a partial owner record behind when exclusive publication fails', () => {
    const profile = createProfile()
    const baseFs = nodeFs as unknown as HostProfileAuthorityLeaseFs
    const writeFailure = new Error('injected authority write failure')
    const fs: HostProfileAuthorityLeaseFs = {
      ...baseFs,
      writeSync: () => {
        throw writeFailure
      }
    }

    expect(() =>
      HostProfileAuthorityLease.acquire(
        hostOptions(profile, {
          pid: 616,
          fs
        })
      )
    ).toThrow(writeFailure)
    expect(nodeFs.existsSync(ownerPath(profile))).toBe(false)
  })

  it('can retry release after a transient owner unlink failure', () => {
    const profile = createProfile()
    const baseFs = nodeFs as unknown as HostProfileAuthorityLeaseFs
    let failOwnerUnlink = true
    const fs: HostProfileAuthorityLeaseFs = {
      ...baseFs,
      unlinkSync: (path) => {
        if (path.endsWith(HOST_PROFILE_AUTHORITY_LEASE_FILENAME) && failOwnerUnlink) {
          failOwnerUnlink = false
          throw new Error('injected owner unlink failure')
        }
        baseFs.unlinkSync(path)
      }
    }
    const lease = HostProfileAuthorityLease.acquire(hostOptions(profile, { pid: 717, fs }))

    expect(() => lease.release()).toThrow(/injected owner unlink failure/)
    expect(nodeFs.existsSync(ownerPath(profile))).toBe(true)
    expect(nodeFs.existsSync(reclaimGuardPath(profile))).toBe(false)
    expect(lease.release()).toBe(true)
  })

  it('rejects an invalid injected clock before creating an owner record', () => {
    const profile = createProfile()
    expect(() =>
      HostProfileAuthorityLease.acquire(
        hostOptions(profile, {
          pid: 101,
          clock: { now: () => new Date('not a date') }
        })
      )
    ).toThrow(/invalid time/i)
    expect(nodeFs.existsSync(ownerPath(profile))).toBe(false)
  })
})

function createProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'taskwraith-host-profile-authority-'))
  temporaryProfiles.push(profile)
  return profile
}

function ownerPath(profile: string): string {
  return join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME)
}

function reclaimGuardPath(profile: string): string {
  return join(profile, HOST_PROFILE_AUTHORITY_RECLAIM_GUARD_FILENAME)
}

function hostOptions(
  profilePath: string,
  input: {
    pid: number
    liveness?: (owner: HostProfileAuthorityProcessIdentity) => HostProfileAuthorityOwnerLiveness
    onReclaimGuardAcquired?: () => void
    tokens?: string[]
    clock?: { now(): Date }
    fs?: HostProfileAuthorityLeaseFs
  }
): HostProfileAuthorityLeaseOptions {
  let nextToken = input.pid
  return {
    profilePath,
    fs: input.fs,
    clock: input.clock || { now: () => new Date(NOW) },
    identity: {
      createOpaqueToken: () => input.tokens?.shift() || opaqueToken(nextToken++)
    },
    processPort: {
      current: {
        pid: input.pid,
        processStartIdentity: `process-start-${input.pid}-v1`,
        processStartedAt: STARTED_AT
      },
      inspectOwner: input.liveness || (() => 'unknown')
    },
    onReclaimGuardAcquired: input.onReclaimGuardAcquired
  }
}

function ownerRecord(pid: number, token: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    purpose: OWNER_PURPOSE,
    pid,
    processStartIdentity: `process-start-${pid}-v1`,
    processStartedAt: STARTED_AT,
    acquiredAt: NOW.toISOString(),
    token
  }
}

function opaqueToken(seed: number): string {
  return seed.toString(16).padStart(64, '0')
}
