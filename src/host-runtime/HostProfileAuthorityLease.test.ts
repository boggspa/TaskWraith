import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BIRTH_IDENTITY_REVERIFY_MS,
  HOST_PROFILE_AUTHORITY_LEASE_FILENAME,
  HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES,
  HOST_PROFILE_AUTHORITY_RECLAIM_GUARD_FILENAME,
  HostProfileAuthorityLease,
  HostProfileAuthorityLeaseBlockedError,
  HostProfileAuthorityLeaseBusyError,
  createBirthIdentityProcessPort,
  type HostProfileAuthorityLeaseFs,
  type HostProfileAuthorityLeaseOptions,
  type HostProfileAuthorityOwnerLiveness,
  type HostProfileAuthorityProcessIdentity
} from './HostProfileAuthorityLease'
import {
  PROCESS_BIRTH_IDENTITY_PATTERN,
  observeProcessBirthIdentitySync,
  type ProcessBirthObservation
} from './ProcessBirthIdentity'

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

describe('HostProfileAuthorityLease birth identity', () => {
  // Golden captured from the pre-birth-identity implementation (HEAD 2a71f9580)
  // with the same injected clock, token and process port: the record bytes and
  // key order are unchanged by the default-port change.
  const GOLDEN_RECORD =
    '{"schemaVersion":1,"purpose":"taskwraith:host-profile-authority-owner:v1","pid":515,' +
    '"processStartIdentity":"process-start-515-v1","processStartedAt":"2026-08-24T00:59:00.000Z",' +
    '"acquiredAt":"2026-08-24T01:00:00.000Z",' +
    '"token":"0000000000000000000000000000000000000000000000000000000000000515"}\n'
  const GOLDEN_KEYS = [
    'schemaVersion',
    'purpose',
    'pid',
    'processStartIdentity',
    'processStartedAt',
    'acquiredAt',
    'token'
  ]

  it('writes byte-identical canonical records for injected inputs', () => {
    const profile = createProfile()
    const lease = HostProfileAuthorityLease.acquire(
      hostOptions(profile, { pid: 515, tokens: [opaqueToken(0x515)] })
    )
    expect(readFileSync(ownerPath(profile), 'utf8')).toBe(GOLDEN_RECORD)
    expect(lease.release()).toBe(true)
  })

  it('publishes a re-derivable birth-identity digest through the default process port', () => {
    const profile = createProfile()
    const lease = HostProfileAuthorityLease.acquire({ profilePath: profile })
    const raw = JSON.parse(readFileSync(ownerPath(profile), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw)).toEqual(GOLDEN_KEYS)
    expect(raw.pid).toBe(process.pid)
    const self = observeProcessBirthIdentitySync(process.pid)
    if (self.state === 'live') {
      expect(raw.processStartIdentity).toMatch(PROCESS_BIRTH_IDENTITY_PATTERN)
      expect(raw.processStartIdentity).toBe(self.birthIdentity)
    } else {
      expect(raw.processStartIdentity).toMatch(/^node:\d+:[0-9a-f]+$/)
    }
    expect(HostProfileAuthorityLease.peek({ profilePath: profile })).toMatchObject({
      kind: 'live',
      owner: { pid: process.pid }
    })
    expect(lease.release()).toBe(true)
  })

  it('computes the current identity lazily on first use, not when the port is created', () => {
    const observeSelf = vi.fn((): ProcessBirthObservation => live('c'.repeat(64)))
    const port = createBirthIdentityProcessPort({ pid: 777, observeSelf })
    expect(observeSelf).not.toHaveBeenCalled()
    expect(port.current).toMatchObject({ pid: 777, processStartIdentity: 'c'.repeat(64) })
    expect(port.current).toBe(port.current)
    expect(observeSelf).toHaveBeenCalledOnce()
  })

  it('falls back to a legacy nonce identity when its own birth cannot be observed', () => {
    const port = createBirthIdentityProcessPort({
      pid: 778,
      observeSelf: () => ({ state: 'identity_unavailable' })
    })
    expect(port.current.processStartIdentity).toMatch(/^node:778:[0-9a-f]+$/)
  })

  it('observes itself again after a failed first observation instead of keeping the nonce for life', () => {
    const results: ProcessBirthObservation[] = [
      { state: 'identity_unavailable' },
      live('c'.repeat(64))
    ]
    const observeSelf = vi.fn(
      (): ProcessBirthObservation => results.shift() ?? { state: 'identity_unavailable' }
    )
    const port = createBirthIdentityProcessPort({ pid: 779, observeSelf })
    const legacy = port.current
    expect(legacy.processStartIdentity).toMatch(/^node:779:[0-9a-f]+$/)
    const recovered = port.current
    expect(recovered).toMatchObject({ pid: 779, processStartIdentity: 'c'.repeat(64) })
    expect(recovered.processStartedAt).toBe(legacy.processStartedAt)
    expect(port.current).toBe(recovered)
    expect(observeSelf).toHaveBeenCalledTimes(2)
    // A lease taken after the recovery carries the birth digest.
    const profile = createProfile()
    const lease = HostProfileAuthorityLease.acquire({ profilePath: profile, processPort: port })
    expect(lease.owner.processStartIdentity).toBe('c'.repeat(64))
    expect(lease.release()).toBe(true)
  })

  it('reclaims a lease whose pid was reused', () => {
    const profile = createProfile()
    const bornFirst = 'a'.repeat(64)
    const bornLater = 'b'.repeat(64)
    const stale = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: createBirthIdentityProcessPort({ pid: 101, observeSelf: () => live(bornFirst) })
    })
    expect(stale.owner.processStartIdentity).toBe(bornFirst)
    const observe = vi.fn(
      (pid: number): ProcessBirthObservation =>
        pid === 101 ? live(bornLater) : { state: 'identity_unavailable' }
    )
    const successor = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: createBirthIdentityProcessPort({
        pid: 202,
        observeSelf: () => live('d'.repeat(64)),
        observe
      })
    })
    expect(observe).toHaveBeenCalledWith(101)
    expect(JSON.parse(readFileSync(ownerPath(profile), 'utf8'))).toMatchObject({
      pid: 202,
      processStartIdentity: 'd'.repeat(64)
    })
    expect(stale.release()).toBe(false)
    expect(successor.release()).toBe(true)
  })

  it('keeps a live owner whose birth identity matches', () => {
    const profile = createProfile()
    const born = 'a'.repeat(64)
    const incumbent = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: createBirthIdentityProcessPort({ pid: 101, observeSelf: () => live(born) })
    })
    let thrown: unknown
    try {
      HostProfileAuthorityLease.acquire({
        profilePath: profile,
        processPort: createBirthIdentityProcessPort({
          pid: 202,
          observeSelf: () => live('d'.repeat(64)),
          observe: () => live(born)
        })
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HostProfileAuthorityLeaseBusyError)
    expect((thrown as HostProfileAuthorityLeaseBusyError).liveness).toBe('live')
    expect(incumbent.release()).toBe(true)
  })

  it('degrades an owner whose birth cannot be observed to pid existence and never reclaims one that exists', () => {
    const profile = createProfile()
    const incumbent = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: createBirthIdentityProcessPort({
        pid: 101,
        observeSelf: () => live('a'.repeat(64))
      })
    })
    const raw = readFileSync(ownerPath(profile), 'utf8')
    for (const [error, expected] of [
      [null, 'live'],
      ['EPERM', 'unknown']
    ] as const) {
      const processKill = vi.fn(() => {
        if (error) throw Object.assign(new Error(error), { code: error })
      })
      let thrown: unknown
      try {
        HostProfileAuthorityLease.acquire({
          profilePath: profile,
          processPort: createBirthIdentityProcessPort({
            pid: 202,
            observeSelf: () => live('d'.repeat(64)),
            observe: () => ({ state: 'identity_unavailable' }),
            processKill
          })
        })
      } catch (caught) {
        thrown = caught
      }
      expect(thrown).toBeInstanceOf(HostProfileAuthorityLeaseBusyError)
      expect((thrown as HostProfileAuthorityLeaseBusyError).liveness).toBe(expected)
      expect(processKill).toHaveBeenCalledWith(101, 0)
      expect(readFileSync(ownerPath(profile), 'utf8')).toBe(raw)
    }
    expect(incumbent.release()).toBe(true)
  })

  it('peeks a running owner live when its birth cannot be observed, so peek consumers never refuse it', () => {
    const profile = createProfile()
    const incumbent = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: createBirthIdentityProcessPort({
        pid: 101,
        observeSelf: () => live('a'.repeat(64))
      })
    })
    // `ps` failing (EAGAIN at the process limit, the 2 s timeout) is what the
    // history worker and Desktop writer arbitration used to see as `unknown`.
    const blind = createBirthIdentityProcessPort({
      pid: 202,
      observeSelf: () => live('d'.repeat(64)),
      observe: () => ({ state: 'identity_unavailable' }),
      processKill: () => undefined
    })
    expect(
      HostProfileAuthorityLease.peek({ profilePath: profile, processPort: blind })
    ).toMatchObject({ kind: 'live', owner: { pid: 101 } })
    expect(incumbent.release()).toBe(true)
  })

  it('reads a dead owner as stale and reclaims it', () => {
    const profile = createProfile()
    const dead = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: createBirthIdentityProcessPort({
        pid: 101,
        observeSelf: () => live('a'.repeat(64))
      })
    })
    const successor = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: createBirthIdentityProcessPort({
        pid: 202,
        observeSelf: () => live('d'.repeat(64)),
        observe: () => ({ state: 'dead' })
      })
    })
    expect(dead.release()).toBe(false)
    expect(successor.release()).toBe(true)
  })

  it('judges a legacy nonce owner by pid existence only and never observes its birth', () => {
    const legacyRecord = {
      ...ownerRecord(101, opaqueToken(1)),
      processStartIdentity: 'node:101:172d23b8aef73'
    }
    for (const [error, expected] of [
      [null, 'live'],
      ['ESRCH', 'stale'],
      ['EPERM', 'unknown']
    ] as const) {
      const observe = vi.fn()
      const port = createBirthIdentityProcessPort({
        pid: 202,
        observeSelf: () => live('d'.repeat(64)),
        observe,
        processKill: () => {
          if (error) throw Object.assign(new Error(error), { code: error })
        }
      })
      expect(port.inspectOwner(legacyRecord as HostProfileAuthorityProcessIdentity)).toBe(expected)
      expect(observe).not.toHaveBeenCalled()
    }
  })

  it('judges a record naming its own pid by the cached self birth, never by a fresh observation', () => {
    const observe = vi.fn((): ProcessBirthObservation => live('f'.repeat(64)))
    const port = createBirthIdentityProcessPort({
      pid: 202,
      observeSelf: () => live('d'.repeat(64)),
      observe
    })
    expect(
      port.inspectOwner({
        pid: 202,
        processStartIdentity: 'd'.repeat(64),
        processStartedAt: STARTED_AT
      })
    ).toBe('live')
    // Same pid, other birth: an earlier process that held our pid wrote it.
    expect(
      port.inspectOwner({
        pid: 202,
        processStartIdentity: 'e'.repeat(64),
        processStartedAt: STARTED_AT
      })
    ).toBe('stale')
    expect(observe).not.toHaveBeenCalled()
    // Without a self observation the port falls back to observing the pid.
    const blind = createBirthIdentityProcessPort({
      pid: 202,
      observeSelf: () => ({ state: 'identity_unavailable' }),
      observe
    })
    expect(
      blind.inspectOwner({
        pid: 202,
        processStartIdentity: 'f'.repeat(64),
        processStartedAt: STARTED_AT
      })
    ).toBe('live')
    expect(observe).toHaveBeenCalledWith(202)
  })

  it('observes an owner birth once per re-verify interval and trusts kill(0) in between', () => {
    let clock = 1_000_000
    const born = 'a'.repeat(64)
    const observe = vi.fn((): ProcessBirthObservation => live(born))
    const processKill = vi.fn()
    const port = createBirthIdentityProcessPort({
      pid: 202,
      observeSelf: () => live('d'.repeat(64)),
      observe,
      processKill,
      now: () => clock
    })
    const owner = { pid: 101, processStartIdentity: born, processStartedAt: STARTED_AT }
    expect(port.inspectOwner(owner)).toBe('live')
    expect(observe).toHaveBeenCalledTimes(1)
    for (let check = 0; check < 100; check += 1) {
      clock += Math.floor(BIRTH_IDENTITY_REVERIFY_MS / 101)
      expect(port.inspectOwner(owner)).toBe('live')
    }
    expect(observe).toHaveBeenCalledTimes(1)
    expect(processKill).toHaveBeenCalledTimes(100)
    clock = 1_000_000 + BIRTH_IDENTITY_REVERIFY_MS
    expect(port.inspectOwner(owner)).toBe('live')
    expect(observe).toHaveBeenCalledTimes(2)
  })

  it('reads a trusted owner that died as stale at once, and a record proven stale stays stale', () => {
    let clock = 1_000_000
    const born = 'a'.repeat(64)
    const observe = vi.fn((): ProcessBirthObservation => live(born))
    let alive = true
    const port = createBirthIdentityProcessPort({
      pid: 202,
      observeSelf: () => live('d'.repeat(64)),
      observe,
      processKill: () => {
        if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      },
      now: () => clock
    })
    const owner = { pid: 101, processStartIdentity: born, processStartedAt: STARTED_AT }
    expect(port.inspectOwner(owner)).toBe('live')
    alive = false
    clock += 1
    expect(port.inspectOwner(owner)).toBe('stale')
    // The pid comes back as another process inside the interval: the record
    // it once proved stale is never revived.
    alive = true
    clock += 1
    expect(port.inspectOwner(owner)).toBe('stale')
    expect(observe).toHaveBeenCalledTimes(1)
    // A birth mismatch is final for that record too, without a second `ps`.
    const reused = { pid: 303, processStartIdentity: 'e'.repeat(64), processStartedAt: STARTED_AT }
    expect(port.inspectOwner(reused)).toBe('stale')
    expect(port.inspectOwner(reused)).toBe('stale')
    expect(observe).toHaveBeenCalledTimes(2)
  })

  it('degrades to pid existence when the birth cannot be observed, and never re-observes inside the interval', () => {
    let clock = 1_000_000
    const born = 'a'.repeat(64)
    const observe = vi.fn((): ProcessBirthObservation => ({ state: 'identity_unavailable' }))
    const processKill = vi.fn()
    const port = createBirthIdentityProcessPort({
      pid: 202,
      observeSelf: () => live('d'.repeat(64)),
      observe,
      processKill,
      now: () => clock
    })
    const owner = { pid: 101, processStartIdentity: born, processStartedAt: STARTED_AT }
    for (let check = 0; check < 50; check += 1) {
      expect(port.inspectOwner(owner)).toBe('live')
      clock += 1_000
    }
    expect(observe).toHaveBeenCalledTimes(1)
    expect(processKill).toHaveBeenCalledTimes(50)
    clock = 1_000_000 + BIRTH_IDENTITY_REVERIFY_MS
    observe.mockImplementationOnce(() => live(born))
    expect(port.inspectOwner(owner)).toBe('live')
    expect(observe).toHaveBeenCalledTimes(2)
  })
})

function live(birthIdentity: string): ProcessBirthObservation {
  return { state: 'live', birthIdentity, startedAtMs: null }
}

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
