import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_ENVELOPE_VAULT_DIRECTORY,
  HostEnvelopeVault,
  HostEnvelopeVaultDisposedError,
  HostEnvelopeVaultIndeterminateError,
  HostEnvelopeVaultIntegrityError,
  HostEnvelopeVaultKeyMismatchError,
  type HostEnvelopeVaultCryptoPort,
  type HostEnvelopeVaultFs
} from './HostEnvelopeVault'

const FIXED_TIME = '2026-08-24T01:00:00.000Z'
const temporaryProfiles: string[] = []

afterEach(() => {
  for (const profile of temporaryProfiles.splice(0)) {
    rmSync(profile, { recursive: true, force: true })
  }
})

describe('HostEnvelopeVault', () => {
  it('writes a canonical deterministic AES-256-GCM envelope vector bound to profile and record id', () => {
    const profile = createProfile()
    const masterKey = Buffer.from([...Array(32).keys()])
    const vault = openVault(profile, {
      masterKey,
      random: fixedRandom(['000102030405060708090a0b', '101112131415161718191a1b'])
    })

    const metadata = vault.write('api-key', Buffer.from('vector plaintext', 'utf8'))
    const raw = readEnvelope(profile)
    const envelope = JSON.parse(raw) as Record<string, unknown>

    expect(masterKey.every((byte) => byte === 0)).toBe(true)
    expect(raw).toBe(`${JSON.stringify(envelope)}\n`)
    expect(metadata).toMatchObject({
      recordId: 'api-key',
      generation: 1,
      plaintextByteLength: Buffer.byteLength('vector plaintext')
    })
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      purpose: 'taskwraith:host-envelope-vault:v1',
      recordId: 'api-key',
      generation: 1,
      nonce: 'AAECAwQFBgcICQoL'
    })

    const header = {
      schemaVersion: 1,
      purpose: 'taskwraith:host-envelope-vault:v1',
      profileFingerprint: envelope.profileFingerprint,
      masterKeyId: 'test-key-v1',
      recordId: 'api-key',
      generation: 1,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      plaintextByteLength: Buffer.byteLength('vector plaintext'),
      state: 'active'
    }
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from([...Array(32).keys()]),
      Buffer.from(envelope.nonce as string, 'base64')
    )
    cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'))
    const expectedCiphertext = Buffer.concat([
      cipher.update(Buffer.from('vector plaintext', 'utf8')),
      cipher.final()
    ])
    expect(envelope.ciphertext).toBe(expectedCiphertext.toString('base64'))
    expect(envelope.authTag).toBe(cipher.getAuthTag().toString('base64'))
    expect(raw).not.toContain('vector plaintext')
  })

  it('supports exact record CRUD/list semantics with monotonic generations and fresh nonces', () => {
    const profile = createProfile()
    const vault = openVault(profile, {
      random: fixedRandom([
        '000000000000000000000001',
        '100000000000000000000001',
        '000000000000000000000002',
        '100000000000000000000002',
        '000000000000000000000003',
        '100000000000000000000003',
        '000000000000000000000004',
        '100000000000000000000004',
        '000000000000000000000005',
        '100000000000000000000005'
      ])
    })

    expect(vault.read('missing')).toBeNull()
    expect(vault.write('z-record', Buffer.from('same'))).toMatchObject({ generation: 1 })
    const firstRaw = readEnvelope(profile)
    expect(vault.write('z-record', Buffer.from('same'))).toMatchObject({ generation: 2 })
    const secondRaw = readEnvelope(profile)
    expect(JSON.parse(firstRaw).nonce).not.toBe(JSON.parse(secondRaw).nonce)
    expect(vault.write('a-record', Buffer.from('first'))).toMatchObject({ generation: 1 })
    expect(vault.list().map((record) => record.recordId)).toEqual(['a-record', 'z-record'])
    expect(vault.read('z-record')?.plaintext.toString('utf8')).toBe('same')
    expect(vault.delete('z-record')).toBe(true)
    expect(vault.delete('z-record')).toBe(false)
    expect(vault.write('z-record', Buffer.from('after-delete'))).toMatchObject({ generation: 4 })
  })

  it('rejects ciphertext tampering, profile substitution, malformed envelopes, and unexpected entries', () => {
    const profile = createProfile()
    const master = key(7)
    const vault = openVault(profile, { masterKey: master })
    vault.write('credential', Buffer.from('super-secret'))
    const envelopePath = onlyEnvelopePath(profile)
    const tampered = JSON.parse(readFileSync(envelopePath, 'utf8')) as Record<string, string>
    tampered.ciphertext = tampered.ciphertext.replace(
      /^./,
      tampered.ciphertext.startsWith('A') ? 'B' : 'A'
    )
    writeFileSync(envelopePath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 })
    expect(() => vault.read('credential')).toThrow(HostEnvelopeVaultIntegrityError)

    const sourceProfile = createProfile()
    const targetProfile = createProfile()
    const sourceVault = openVault(sourceProfile, { masterKey: key(8) })
    sourceVault.write('profile-bound', Buffer.from('secret'))
    const targetVault = openVault(targetProfile, { masterKey: key(8) })
    writeFileSync(
      join(vaultDirectory(targetProfile), nodeFs.readdirSync(vaultDirectory(sourceProfile))[0]),
      readFileSync(onlyEnvelopePath(sourceProfile)),
      {
        mode: 0o600
      }
    )
    expect(() => targetVault.read('profile-bound')).toThrow(/different profile/i)

    const malformedProfile = createProfile()
    const malformedVault = openVault(malformedProfile)
    writeFileSync(join(vaultDirectory(malformedProfile), 'unexpected.txt'), 'not an envelope', {
      mode: 0o600
    })
    expect(() => malformedVault.list()).toThrow(/unexpected entry/i)
  })

  it('detects an in-process rollback of a previously observed generation', () => {
    const profile = createProfile()
    const vault = openVault(profile)
    vault.write('rollback', Buffer.from('generation-one'))
    const generationOne = readFileSync(onlyEnvelopePath(profile))
    vault.write('rollback', Buffer.from('generation-two'))
    writeFileSync(onlyEnvelopePath(profile), generationOne, { mode: 0o600 })

    expect(() => vault.read('rollback')).toThrow(/rolled back/i)
  })

  it('distinguishes a rotated master-key epoch from an ordinary wrong-key authentication failure', () => {
    const profile = createProfile()
    const writer = openVault(profile, { masterKey: key(11), masterKeyId: 'epoch-a' })
    writer.write('key-epoch', Buffer.from('secret'))

    const rotated = openVault(profile, { masterKey: key(11), masterKeyId: 'epoch-b' })
    expect(() => rotated.read('key-epoch')).toThrow(HostEnvelopeVaultKeyMismatchError)

    const wrongKey = openVault(profile, { masterKey: key(12), masterKeyId: 'epoch-a' })
    let wrongKeyError: unknown
    try {
      wrongKey.read('key-epoch')
    } catch (error) {
      wrongKeyError = error
    }
    expect(wrongKeyError).toBeInstanceOf(HostEnvelopeVaultIntegrityError)
    expect(wrongKeyError).not.toBeInstanceOf(HostEnvelopeVaultKeyMismatchError)
  })

  it('rejects a pre-existing vault-directory symlink before resolving its target', () => {
    if (process.platform === 'win32') return
    const profile = createProfile()
    const outside = createProfile()
    symlinkSync(outside, vaultDirectory(profile))

    expect(() => openVault(profile)).toThrow(/not a real directory/i)
    expect(nodeFs.readdirSync(outside)).toEqual([])
  })

  it('bounds descriptor reads to the initial size and rejects a file that grows mid-read', () => {
    const profile = createProfile()
    const writer = openVault(profile, { masterKey: key(17) })
    writer.write('growth', Buffer.from('value'))
    const envelopePath = onlyEnvelopePath(profile)
    const baseFs = nodeFs as unknown as HostEnvelopeVaultFs
    let grew = false
    const growingFs: HostEnvelopeVaultFs = {
      ...baseFs,
      readSync: (fd, buffer, offset, length, position) => {
        if (!grew) {
          grew = true
          appendFileSync(envelopePath, 'x')
        }
        return baseFs.readSync(fd, buffer, offset, length, position)
      }
    }
    const reader = openVault(profile, { masterKey: key(17), fs: growingFs })

    expect(() => reader.read('growth')).toThrow(/changed during validation/i)
  })

  it('cleans failed atomic publication without replacing the prior valid record', () => {
    const profile = createProfile()
    const stable = openVault(profile, { masterKey: key(12) })
    stable.write('atomic', Buffer.from('old'))
    const baseFs = nodeFs as unknown as HostEnvelopeVaultFs
    const writeFailure = new Error('injected rename failure')
    const failingFs: HostEnvelopeVaultFs = {
      ...baseFs,
      renameSync: () => {
        throw writeFailure
      }
    }
    const contender = openVault(profile, { masterKey: key(12), fs: failingFs })

    expect(() => contender.write('atomic', Buffer.from('new'))).toThrow(
      HostEnvelopeVaultIndeterminateError
    )
    expect(stable.read('atomic')?.plaintext.toString('utf8')).toBe('old')
    expect(
      nodeFs.readdirSync(vaultDirectory(profile)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
  })

  // @portability-ok The injected fault fires on the post-rename directory fsync, a step the
  // vault deliberately skips on win32, so the indeterminate outcome cannot be provoked there.
  it.skipIf(process.platform === 'win32')(
    'returns an indeterminate outcome after record or tombstone publication may have landed',
    () => {
      const recordProfile = createProfile()
      const baseFs = nodeFs as unknown as HostEnvelopeVaultFs
      let recordFsyncs = 0
      const recordPostRenameFs: HostEnvelopeVaultFs = {
        ...baseFs,
        fsyncSync: (descriptor) => {
          recordFsyncs += 1
          if (recordFsyncs === 2) throw new Error('injected post-rename directory fsync failure')
          baseFs.fsyncSync(descriptor)
        }
      }
      const uncertainRecord = openVault(recordProfile, {
        masterKey: key(18),
        fs: recordPostRenameFs
      })
      expect(() => uncertainRecord.write('record', Buffer.from('may-have-landed'))).toThrow(
        HostEnvelopeVaultIndeterminateError
      )
      expect(
        openVault(recordProfile, { masterKey: key(18) })
          .read('record')
          ?.plaintext.toString()
      ).toBe('may-have-landed')

      const tombstoneProfile = createProfile()
      const stable = openVault(tombstoneProfile, { masterKey: key(19) })
      stable.write('tombstone', Buffer.from('old'))
      let tombstoneFsyncs = 0
      const tombstonePostRenameFs: HostEnvelopeVaultFs = {
        ...baseFs,
        fsyncSync: (descriptor) => {
          tombstoneFsyncs += 1
          if (tombstoneFsyncs === 2) throw new Error('injected tombstone directory fsync failure')
          baseFs.fsyncSync(descriptor)
        }
      }
      const uncertainTombstone = openVault(tombstoneProfile, {
        masterKey: key(19),
        fs: tombstonePostRenameFs
      })
      expect(() => uncertainTombstone.delete('tombstone')).toThrow(
        HostEnvelopeVaultIndeterminateError
      )
      expect(openVault(tombstoneProfile, { masterKey: key(19) }).read('tombstone')).toBeNull()
    }
  )

  it('persists authenticated tombstones across restart, omits them from reads/lists, and rejects rollback', () => {
    const profile = createProfile()
    const vault = openVault(profile, { masterKey: key(13) })
    vault.write('race', Buffer.from('old'))
    const activeGenerationOne = readFileSync(onlyEnvelopePath(profile))
    expect(vault.delete('race')).toBe(true)
    expect(JSON.parse(readEnvelope(profile))).toMatchObject({ state: 'deleted', generation: 2 })
    expect(vault.read('race')).toBeNull()
    expect(vault.list()).toEqual([])
    vault.dispose()

    const restarted = openVault(profile, { masterKey: key(13) })
    expect(restarted.read('race')).toBeNull()
    expect(restarted.list()).toEqual([])
    expect(restarted.write('race', Buffer.from('successor'))).toMatchObject({ generation: 3 })
    writeFileSync(onlyEnvelopePath(profile), activeGenerationOne, { mode: 0o600 })
    expect(() => restarted.read('race')).toThrow(/rolled back/i)
  })

  it('zeroes transferred and retained master-key buffers and fails closed after disposal', () => {
    const profile = createProfile()
    const supplied = key(14)
    let retainedKey: Buffer | null = null
    const vault = openVault(profile, {
      masterKey: supplied,
      crypto: nodeCrypto({
        encrypt: (input) => {
          retainedKey = input.key
          return nodeCrypto().encrypt(input)
        }
      })
    })
    expect(supplied.every((byte) => byte === 0)).toBe(true)
    vault.write('zeroize', Buffer.from('value'))
    vault.dispose()

    expect((retainedKey as unknown as Buffer).every((byte) => byte === 0)).toBe(true)
    expect(() => vault.read('zeroize')).toThrow(HostEnvelopeVaultDisposedError)
    expect(() => vault.write('zeroize', Buffer.from('again'))).toThrow(
      HostEnvelopeVaultDisposedError
    )
    expect(vault.dispose()).toBeUndefined()
  })

  it('rejects invalid master/random ports without persisting a plaintext key or record', () => {
    const profile = createProfile()
    const invalid = Buffer.alloc(31, 0xaa)
    expect(
      () =>
        new HostEnvelopeVault({
          profilePath: profile,
          masterKey: { acquireMasterKey: () => ({ key: invalid, masterKeyId: 'test-key-v1' }) }
        })
    ).toThrow(/exactly 32 bytes/i)
    expect(invalid.every((byte) => byte === 0)).toBe(true)
    expect(nodeFs.readdirSync(vaultDirectory(profile))).toEqual([])

    const vault = openVault(profile, { random: { randomBytes: () => Buffer.alloc(1) } })
    expect(() => vault.write('random', Buffer.from('value'))).toThrow(/nonce source returned/i)
    expect(nodeFs.readdirSync(vaultDirectory(profile))).toEqual([])
  })

  it('contains injected crypto and clock failures without publishing a record', () => {
    const profile = createProfile()
    const cryptoFailure = new Error('injected cipher failure')
    const vault = openVault(profile, {
      crypto: nodeCrypto({
        encrypt: () => {
          throw cryptoFailure
        }
      })
    })
    expect(() => vault.write('crypto-failure', Buffer.from('secret'))).toThrow(
      /publication failed/i
    )
    expect(nodeFs.readdirSync(vaultDirectory(profile))).toEqual([])

    const invalidClock = new HostEnvelopeVault({
      profilePath: createProfile(),
      masterKey: { acquireMasterKey: () => ({ key: key(15), masterKeyId: 'test-key-v1' }) },
      clock: { now: () => new Date('invalid') }
    })
    expect(() => invalidClock.write('clock-failure', Buffer.from('secret'))).toThrow(
      /invalid timestamp/i
    )
  })

  it('uses owner-only file and directory permissions where POSIX modes are supported', () => {
    const profile = createProfile()
    const vault = openVault(profile)
    vault.write('permissions', Buffer.from('value'))

    if (process.platform !== 'win32') {
      expect(nodeFs.statSync(vaultDirectory(profile)).mode & 0o777).toBe(0o700)
      expect(nodeFs.statSync(onlyEnvelopePath(profile)).mode & 0o777).toBe(0o600)
    }
  })
})

function createProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'taskwraith-host-envelope-vault-'))
  temporaryProfiles.push(profile)
  return profile
}

function vaultDirectory(profile: string): string {
  return join(profile, HOST_ENVELOPE_VAULT_DIRECTORY)
}

function onlyEnvelopePath(profile: string): string {
  const names = nodeFs
    .readdirSync(vaultDirectory(profile))
    .filter((name) => name.endsWith('.vault.json'))
  expect(names).toHaveLength(1)
  return join(vaultDirectory(profile), names[0])
}

function readEnvelope(profile: string): string {
  return readFileSync(onlyEnvelopePath(profile), 'utf8')
}

function key(seed = 1): Buffer {
  return Buffer.alloc(32, seed)
}

function openVault(
  profilePath: string,
  overrides: {
    masterKey?: Buffer
    masterKeyId?: string
    fs?: HostEnvelopeVaultFs
    crypto?: HostEnvelopeVaultCryptoPort
    random?: { randomBytes(size: number): Buffer }
  } = {}
): HostEnvelopeVault {
  const masterKey = overrides.masterKey || key()
  return new HostEnvelopeVault({
    profilePath,
    masterKey: {
      acquireMasterKey: () => ({
        key: masterKey,
        masterKeyId: overrides.masterKeyId || 'test-key-v1'
      })
    },
    fs: overrides.fs,
    crypto: overrides.crypto,
    random: overrides.random,
    clock: { now: () => new Date(FIXED_TIME) }
  })
}

function fixedRandom(hexValues: string[]): { randomBytes(size: number): Buffer } {
  const values = [...hexValues]
  return {
    randomBytes: (size) => {
      const value = Buffer.from(values.shift() || '', 'hex')
      if (value.byteLength !== size) throw new Error(`Expected ${size} random bytes.`)
      return value
    }
  }
}

function nodeCrypto(
  overrides: Partial<HostEnvelopeVaultCryptoPort> = {}
): HostEnvelopeVaultCryptoPort {
  return {
    sha256: (input) => createHash('sha256').update(input).digest(),
    encrypt: ({ key, nonce, aad, plaintext }) => {
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(aad)
      return {
        ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
        authTag: cipher.getAuthTag()
      }
    },
    decrypt: ({ key, nonce, aad, ciphertext, authTag }) => {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAAD(aad)
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    },
    ...overrides
  }
}
