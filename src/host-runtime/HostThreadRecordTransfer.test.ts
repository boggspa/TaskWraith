import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_THREAD_RECORD_TRANSFER_DIRECTORY,
  HOST_THREAD_RECORD_TRANSFER_MAX_BYTES,
  HostThreadRecordTransferIntegrityError,
  HostThreadRecordTransferMissingError,
  consumeHostThreadRecordTransfer,
  hostThreadRecordTransferDirectory,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer,
  removeHostThreadRecordTransfer,
  type HostThreadRecordTransferDescriptor,
  type HostThreadRecordTransferFs
} from './HostThreadRecordTransfer'

/** The authenticated Host control line cap this artifact seam exists to bypass. */
const HOST_CONTROL_LINE_MAX_BYTES = 256_000

const temporaryProfiles: string[] = []

afterEach(() => {
  for (const profile of temporaryProfiles.splice(0)) {
    rmSync(profile, { recursive: true, force: true })
  }
})

function createProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'tw-thread-record-transfer-'))
  temporaryProfiles.push(profile)
  return profile
}

/** Real filesystem with selected methods overridden, for staging races deterministically. */
function hookedFs(hooks: Partial<HostThreadRecordTransferFs>): HostThreadRecordTransferFs {
  const base = nodeFs as unknown as HostThreadRecordTransferFs
  const delegate: HostThreadRecordTransferFs = {
    constants: base.constants,
    mkdirSync: (path, options) => base.mkdirSync(path, options),
    realpathSync: (path) => base.realpathSync(path),
    lstatSync: (path) => base.lstatSync(path),
    openSync: (path, flags, mode) => base.openSync(path, flags, mode),
    fstatSync: (fd) => base.fstatSync(fd),
    readSync: (fd, buffer, offset, length, position) =>
      base.readSync(fd, buffer, offset, length, position),
    writeSync: (fd, data) => base.writeSync(fd, data),
    fsyncSync: (fd) => base.fsyncSync(fd),
    fchmodSync: (fd, mode) => base.fchmodSync(fd, mode),
    chmodSync: (path, mode) => base.chmodSync(path, mode),
    closeSync: (fd) => base.closeSync(fd),
    renameSync: (from, to) => base.renameSync(from, to),
    unlinkSync: (path) => base.unlinkSync(path)
  }
  return { ...delegate, ...hooks, constants: base.constants }
}

function publishFixture(
  profile: string,
  record: Record<string, unknown> = { id: 'thread-1', kind: 'ensemble' },
  transferId = 'transfer-1'
): HostThreadRecordTransferDescriptor {
  return publishHostThreadRecordTransfer({ profilePath: profile, transferId, record })
}

describe('hostThreadRecordTransferPath', () => {
  it('derives a direct child of the transfer directory', () => {
    const path = hostThreadRecordTransferPath('/tmp/profile', 'transfer-1')
    expect(path).toBe(
      join('/tmp/profile', HOST_THREAD_RECORD_TRANSFER_DIRECTORY, 'transfer-1.record.json')
    )
  })

  it.each(['..', '../escape', 'a/b', 'a\\b', '', '.hidden', '/absolute', 'x'.repeat(200)])(
    'refuses transfer id %j so no caller can traverse out of the directory',
    (transferId) => {
      expect(() => hostThreadRecordTransferPath('/tmp/profile', transferId)).toThrow(
        HostThreadRecordTransferIntegrityError
      )
    }
  )

  it('refuses a relative or filesystem-root profile path', () => {
    expect(() => hostThreadRecordTransferDirectory('relative/profile')).toThrow(TypeError)
    expect(() => hostThreadRecordTransferDirectory('/')).toThrow(TypeError)
  })
})

describe('publishHostThreadRecordTransfer', () => {
  it('round trips a record far larger than the Host control-line limit', () => {
    const profile = createProfile()
    const record = {
      id: 'thread-1',
      kind: 'ensemble',
      messages: [{ role: 'assistant', text: 'x'.repeat(400_000) }]
    }

    const descriptor = publishFixture(profile, record)

    // The whole point of the artifact seam: this record could never ride inline.
    expect(descriptor.byteLength).toBeGreaterThan(HOST_CONTROL_LINE_MAX_BYTES)
    const consumed = consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })
    expect(consumed.record).toEqual(record)
  })

  it('round trips a multi-megabyte record', () => {
    const profile = createProfile()
    const record = { id: 'thread-1', blob: 'y'.repeat(2 * 1024 * 1024) }

    const descriptor = publishFixture(profile, record)

    expect(descriptor.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    expect(consumeHostThreadRecordTransfer({ profilePath: profile, descriptor }).record).toEqual(
      record
    )
  })

  it('returns the digest and byte length of exactly the bytes it wrote', () => {
    const profile = createProfile()
    const record = { id: 'thread-1', nested: { rounds: [1, 2, 3] } }

    const descriptor = publishFixture(profile, record)

    const written = nodeFs.readFileSync(hostThreadRecordTransferPath(profile, 'transfer-1'))
    expect(descriptor.byteLength).toBe(written.byteLength)
    expect(descriptor.sha256).toBe(createHash('sha256').update(written).digest('hex'))
    expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('creates an owner-only directory and artifact and leaves no temporary behind', () => {
    const profile = createProfile()

    publishFixture(profile)

    const directory = hostThreadRecordTransferDirectory(profile)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(hostThreadRecordTransferPath(profile, 'transfer-1')).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toEqual(['transfer-1.record.json'])
  })

  it('preserves unknown desktop-authored fields losslessly', () => {
    const profile = createProfile()
    const record = {
      id: 'thread-1',
      ensembleRoster: [{ participantId: 'p1', enabled: true }],
      activeRound: { roundId: 'r1', lanes: [{ laneId: 'l1', status: 'settled' }] },
      unknownFutureField: { deeply: { nested: [null, 1, 'two', false] } }
    }

    const descriptor = publishFixture(profile, record)

    expect(consumeHostThreadRecordTransfer({ profilePath: profile, descriptor }).record).toEqual(
      record
    )
  })

  it.each([
    ['a non-object record', 'not-a-record'],
    ['an array record', [1, 2, 3]],
    ['a null record', null]
  ])('refuses %s', (_label, record) => {
    const profile = createProfile()
    expect(() =>
      publishHostThreadRecordTransfer({ profilePath: profile, transferId: 'transfer-1', record })
    ).toThrow(HostThreadRecordTransferIntegrityError)
  })

  it('refuses an unserializable record', () => {
    const profile = createProfile()
    const cyclic: Record<string, unknown> = { id: 'thread-1' }
    cyclic.self = cyclic
    expect(() =>
      publishHostThreadRecordTransfer({
        profilePath: profile,
        transferId: 'transfer-1',
        record: cyclic
      })
    ).toThrow(HostThreadRecordTransferIntegrityError)
  })
})

describe('consumeHostThreadRecordTransfer', () => {
  it('returns the exact file identity it read', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    const onDisk = statSync(hostThreadRecordTransferPath(profile, 'transfer-1'))

    const consumed = consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })

    expect(consumed.identity).toEqual({ dev: String(onDisk.dev), ino: String(onDisk.ino) })
    expect(consumed.removed).toBe(true)
  })

  it('removes the artifact after a successful consume so it cannot be replayed', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)

    consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })

    expect(readdirSync(hostThreadRecordTransferDirectory(profile))).toEqual([])
    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      HostThreadRecordTransferMissingError
    )
  })

  it('reports a missing directory and a missing artifact as missing, not integrity failures', () => {
    const profile = createProfile()
    const descriptor: HostThreadRecordTransferDescriptor = {
      transferId: 'transfer-1',
      sha256: 'a'.repeat(64),
      byteLength: 2
    }

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      HostThreadRecordTransferMissingError
    )

    publishFixture(profile, { id: 'thread-1' }, 'transfer-2')
    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      HostThreadRecordTransferMissingError
    )
  })

  it('refuses a symlink standing in for the artifact', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')
    const decoy = join(profile, 'decoy.json')
    writeFileSync(decoy, JSON.stringify({ id: 'attacker' }), { mode: 0o600 })
    unlinkSync(path)
    symlinkSync(decoy, path)

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      HostThreadRecordTransferIntegrityError
    )
    // The symlink target must survive: cleanup never follows the link.
    expect(nodeFs.existsSync(decoy)).toBe(true)
  })

  it('refuses an artifact whose permissions are not owner-only', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    chmodSync(hostThreadRecordTransferPath(profile, 'transfer-1'), 0o644)

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      /lacks owner-only permissions/
    )
  })

  it('refuses a transfer directory whose permissions are not owner-only', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    chmodSync(hostThreadRecordTransferDirectory(profile), 0o755)

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      /lacks owner-only permissions/
    )
  })

  it('refuses a hard-linked artifact, so no second name can observe or outlive it', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')
    const alias = join(profile, 'alias.json')
    linkSync(path, alias)

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      /not a private regular file/
    )
  })

  it('refuses a byte length that disagrees with the descriptor', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')
    nodeFs.appendFileSync(path, ' ')

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      /byte length does not match/
    )
  })

  it('refuses a digest that disagrees with the descriptor at identical length', () => {
    const profile = createProfile()
    const record = { id: 'thread-1', value: 'aaaa' }
    const descriptor = publishFixture(profile, record)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')
    const swapped = JSON.stringify({ id: 'thread-1', value: 'bbbb' })
    expect(Buffer.byteLength(swapped)).toBe(descriptor.byteLength)
    writeFileSync(path, swapped, { mode: 0o600 })

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      /digest does not match/
    )
  })

  it('refuses malformed JSON even when length and digest agree', () => {
    const profile = createProfile()
    publishFixture(profile)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')
    const malformed = Buffer.from('{"id": "thread-1"', 'utf8')
    writeFileSync(path, malformed, { mode: 0o600 })

    const descriptor: HostThreadRecordTransferDescriptor = {
      transferId: 'transfer-1',
      sha256: createHash('sha256').update(malformed).digest('hex'),
      byteLength: malformed.byteLength
    }

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      /not valid JSON/
    )
  })

  it('refuses a JSON body that is not a plain object', () => {
    const profile = createProfile()
    publishFixture(profile)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')
    const body = Buffer.from('[1,2,3]', 'utf8')
    writeFileSync(path, body, { mode: 0o600 })

    expect(() =>
      consumeHostThreadRecordTransfer({
        profilePath: profile,
        descriptor: {
          transferId: 'transfer-1',
          sha256: createHash('sha256').update(body).digest('hex'),
          byteLength: body.byteLength
        }
      })
    ).toThrow(/did not decode to a plain object/)
  })

  it('reaps the exact inode it rejected so a poisoned artifact cannot accumulate', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    nodeFs.appendFileSync(hostThreadRecordTransferPath(profile, 'transfer-1'), ' ')

    expect(() => consumeHostThreadRecordTransfer({ profilePath: profile, descriptor })).toThrow(
      HostThreadRecordTransferIntegrityError
    )
    expect(readdirSync(hostThreadRecordTransferDirectory(profile))).toEqual([])
  })

  it.each([
    ['an uppercase digest', { sha256: 'A'.repeat(64) }],
    ['a short digest', { sha256: 'a'.repeat(63) }],
    ['a negative byte length', { byteLength: -1 }],
    ['a fractional byte length', { byteLength: 1.5 }],
    ['an oversized byte length', { byteLength: HOST_THREAD_RECORD_TRANSFER_MAX_BYTES + 1 }],
    ['an unsafe transfer id', { transferId: '../escape' }]
  ])('refuses a descriptor with %s before touching the filesystem', (_label, overrides) => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)

    expect(() =>
      consumeHostThreadRecordTransfer({
        profilePath: profile,
        descriptor: { ...descriptor, ...overrides } as HostThreadRecordTransferDescriptor
      })
    ).toThrow(HostThreadRecordTransferIntegrityError)
    // The genuine artifact is untouched by a rejected descriptor.
    expect(readdirSync(hostThreadRecordTransferDirectory(profile))).toEqual([
      'transfer-1.record.json'
    ])
  })
})

describe('replacement-safe cleanup', () => {
  it('never unlinks a successor swapped in after the read', () => {
    const profile = createProfile()
    const record = { id: 'thread-1', kind: 'ensemble' }
    const descriptor = publishFixture(profile, record)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')

    let swapped = false
    const fs = hookedFs({
      closeSync: (fd) => {
        ;(nodeFs as unknown as HostThreadRecordTransferFs).closeSync(fd)
        if (swapped) return
        swapped = true
        // The verified inode disappears and a different file takes the name,
        // exactly as a racing attacker would arrange it.
        unlinkSync(path)
        writeFileSync(path, JSON.stringify({ id: 'successor' }), { mode: 0o600 })
      }
    })

    const consumed = consumeHostThreadRecordTransfer({ profilePath: profile, descriptor, fs })

    // The read still returns the record that was actually verified...
    expect(consumed.record).toEqual(record)
    // ...but cleanup declines to delete a file it never validated.
    expect(consumed.removed).toBe(false)
    expect(JSON.parse(nodeFs.readFileSync(path, 'utf8'))).toEqual({ id: 'successor' })
  })

  it('reports removal honestly when the artifact vanished before cleanup', () => {
    const profile = createProfile()
    const descriptor = publishFixture(profile)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')

    let removedEarly = false
    const fs = hookedFs({
      closeSync: (fd) => {
        ;(nodeFs as unknown as HostThreadRecordTransferFs).closeSync(fd)
        if (removedEarly) return
        removedEarly = true
        unlinkSync(path)
      }
    })

    expect(consumeHostThreadRecordTransfer({ profilePath: profile, descriptor, fs }).removed).toBe(
      false
    )
  })
})

describe('removeHostThreadRecordTransfer', () => {
  it('removes an abandoned artifact and reports whether anything was removed', () => {
    const profile = createProfile()
    publishFixture(profile)

    expect(removeHostThreadRecordTransfer({ profilePath: profile, transferId: 'transfer-1' })).toBe(
      true
    )
    expect(removeHostThreadRecordTransfer({ profilePath: profile, transferId: 'transfer-1' })).toBe(
      false
    )
  })

  it('refuses to delete through a symlink standing in for the artifact', () => {
    const profile = createProfile()
    publishFixture(profile)
    const path = hostThreadRecordTransferPath(profile, 'transfer-1')
    const victim = join(profile, 'victim.json')
    writeFileSync(victim, '{}', { mode: 0o600 })
    unlinkSync(path)
    symlinkSync(victim, path)

    expect(() =>
      removeHostThreadRecordTransfer({ profilePath: profile, transferId: 'transfer-1' })
    ).toThrow(HostThreadRecordTransferIntegrityError)
    expect(nodeFs.existsSync(victim)).toBe(true)
  })

  it('refuses an unsafe transfer id', () => {
    const profile = createProfile()
    expect(() =>
      removeHostThreadRecordTransfer({ profilePath: profile, transferId: '../escape' })
    ).toThrow(HostThreadRecordTransferIntegrityError)
  })
})
