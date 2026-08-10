import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  exportPrivateKeyDer,
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  type KeyPair
} from '../../shared/e2ee/keys'
import {
  CHANNEL_AGENT_IDENTITY_FILE_SUFFIX,
  CHANNEL_AGENT_MAX_RETIRED_KEYS,
  ChannelAgentIdentityStore,
  ChannelAgentIdentityStoreError,
  channelAgentSeatFileHash,
  type ChannelAgentIdentitySafeStorage,
  type ChannelAgentIdentityStoreErrorCode,
  type ChannelAgentIdentityStoreOptions
} from './ChannelAgentIdentityStore'

const SEAT_ID = 'pooled-agent-1'
const roots: string[] = []
let clock = 1_000
let nonce = 0

interface TestEnvelope {
  schemaVersion: 1
  seatIdHash: string
  encryptedPayload: string
}

interface TestCurrentKey {
  keyGeneration: number
  privateKeyDerB64: string
  publicKeyB64: string
  createdAt: number
}

interface TestRetiredKey {
  keyGeneration: number
  publicKeyB64: string
  createdAt: number
  retiredAt: number
}

interface TestPayload {
  schemaVersion: 1
  agentSeatId: string
  current: TestCurrentKey
  retired: TestRetiredKey[]
}

function xorCipher(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0xa5))
}

const secureStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => xorCipher(Buffer.from(plaintext, 'utf8')),
  decryptString: (ciphertext) => xorCipher(ciphertext).toString('utf8'),
  getSelectedStorageBackend: () => 'kwallet6'
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tw-channel-agent-identity-'))
  roots.push(root)
  return root
}

function tempStorage(): string {
  return join(tempRoot(), 'private', 'channel-agent-identities')
}

function makeStore(
  storageDirectory: string,
  overrides: Partial<ChannelAgentIdentityStoreOptions> = {}
): ChannelAgentIdentityStore {
  return new ChannelAgentIdentityStore({
    safeStorage: secureStorage,
    platform: 'darwin',
    now: () => clock,
    randomId: () => `test-${++nonce}`,
    ...overrides,
    storageDirectory
  })
}

function identityPath(storageDirectory: string, agentSeatId = SEAT_ID): string {
  return join(
    storageDirectory,
    `${channelAgentSeatFileHash(agentSeatId)}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}`
  )
}

function readEnvelope(storageDirectory: string, agentSeatId = SEAT_ID): TestEnvelope {
  return JSON.parse(
    readFileSync(identityPath(storageDirectory, agentSeatId), 'utf8')
  ) as TestEnvelope
}

function readPayload(
  storageDirectory: string,
  agentSeatId = SEAT_ID,
  safeStorage: ChannelAgentIdentitySafeStorage = secureStorage
): TestPayload {
  const envelope = readEnvelope(storageDirectory, agentSeatId)
  return JSON.parse(
    safeStorage.decryptString(Buffer.from(envelope.encryptedPayload, 'base64'))
  ) as TestPayload
}

function writePayload(
  storageDirectory: string,
  payload: TestPayload,
  agentSeatId = SEAT_ID,
  safeStorage: ChannelAgentIdentitySafeStorage = secureStorage
): void {
  const envelope: TestEnvelope = {
    schemaVersion: 1,
    seatIdHash: channelAgentSeatFileHash(agentSeatId),
    encryptedPayload: safeStorage.encryptString(JSON.stringify(payload)).toString('base64')
  }
  writeFileSync(identityPath(storageDirectory, agentSeatId), `${JSON.stringify(envelope)}\n`, {
    mode: 0o600
  })
}

function expectStoreError(
  operation: () => unknown,
  code: ChannelAgentIdentityStoreErrorCode
): ChannelAgentIdentityStoreError {
  let caught: unknown
  try {
    operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ChannelAgentIdentityStoreError)
  expect(caught).toMatchObject({ code })
  return caught as ChannelAgentIdentityStoreError
}

function privateDer(keyPair: Pick<KeyPair, 'privateKey'>): string {
  return exportPrivateKeyDer(keyPair.privateKey).toString('base64')
}

afterEach(() => {
  clock = 1_000
  nonce = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ChannelAgentIdentityStore', () => {
  it('persists distinct stable-seat identities with encrypted private material and strict modes', () => {
    const storageDirectory = tempStorage()
    const firstStore = makeStore(storageDirectory)
    expect(firstStore.load(SEAT_ID)).toBeNull()

    const first = firstStore.loadOrCreate(SEAT_ID)
    const secondSeat = firstStore.loadOrCreate('persisted-chat-seat-2')
    const reloaded = makeStore(storageDirectory).loadOrCreate(SEAT_ID)

    expect(reloaded).toMatchObject({
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      publicKeyB64: first.publicKeyB64,
      fingerprint: first.fingerprint,
      createdAt: 1_000
    })
    expect(privateDer(reloaded)).toBe(privateDer(first))
    expect(secondSeat.publicKeyB64).not.toBe(first.publicKeyB64)
    expect(readdirSync(storageDirectory).sort()).toEqual(
      [identityPath(storageDirectory), identityPath(storageDirectory, 'persisted-chat-seat-2')]
        .map((path) => path.slice(storageDirectory.length + 1))
        .sort()
    )

    const rawEnvelope = readFileSync(identityPath(storageDirectory), 'utf8')
    const envelope = readEnvelope(storageDirectory)
    expect(Object.keys(envelope).sort()).toEqual([
      'encryptedPayload',
      'schemaVersion',
      'seatIdHash'
    ])
    expect(rawEnvelope).not.toContain(SEAT_ID)
    expect(rawEnvelope).not.toContain(first.publicKeyB64)
    expect(rawEnvelope).not.toContain(privateDer(first))
    expect(statSync(storageDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(identityPath(storageDirectory)).mode & 0o777).toBe(0o600)
    expect(firstStore.publicHistory(SEAT_ID)).toEqual({
      current: expect.objectContaining({
        agentSeatId: SEAT_ID,
        keyGeneration: 1,
        publicKeyB64: first.publicKeyB64
      }),
      retired: []
    })
  })

  it('uses no-clobber creation and returns the identity that won a re-entrant race', () => {
    const storageDirectory = tempStorage()
    let winner: ReturnType<ChannelAgentIdentityStore['loadOrCreate']> | undefined
    const racingStorage: ChannelAgentIdentitySafeStorage = {
      ...secureStorage,
      encryptString: (plaintext) => {
        winner ??= makeStore(storageDirectory).loadOrCreate(SEAT_ID)
        return secureStorage.encryptString(plaintext)
      }
    }

    const observed = makeStore(storageDirectory, { safeStorage: racingStorage }).loadOrCreate(
      SEAT_ID
    )
    expect(winner).toBeDefined()
    expect(observed.publicKeyB64).toBe(winner!.publicKeyB64)
    expect(privateDer(observed)).toBe(privateDer(winner!))
    expect(readdirSync(storageDirectory)).toEqual([
      `${channelAgentSeatFileHash(SEAT_ID)}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}`
    ])
  })

  it('rotates monotonically, retains public history, and removes prior private material at rest', () => {
    const storageDirectory = tempStorage()
    const store = makeStore(storageDirectory)
    const first = store.loadOrCreate(SEAT_ID)
    const firstPrivateDer = privateDer(first)

    clock = 2_000
    const rotated = store.rotate(SEAT_ID)
    expect(rotated.identity).toMatchObject({
      agentSeatId: SEAT_ID,
      keyGeneration: 2,
      createdAt: 2_000
    })
    expect(rotated.identity.publicKeyB64).not.toBe(first.publicKeyB64)
    expect(rotated.retired).toEqual({
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      publicKeyB64: first.publicKeyB64,
      fingerprint: first.fingerprint,
      createdAt: 1_000,
      retiredAt: 2_000
    })
    expect(rotated.history).toEqual({
      current: expect.objectContaining({ keyGeneration: 2 }),
      retired: [rotated.retired]
    })

    const payload = readPayload(storageDirectory)
    expect(payload.current.privateKeyDerB64).toBe(privateDer(rotated.identity))
    expect(payload.retired).toEqual([
      {
        keyGeneration: 1,
        publicKeyB64: first.publicKeyB64,
        createdAt: 1_000,
        retiredAt: 2_000
      }
    ])
    expect(JSON.stringify(payload)).not.toContain(firstPrivateDer)

    const reloaded = makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    expect(reloaded.publicKeyB64).toBe(rotated.identity.publicKeyB64)
    expect(privateDer(reloaded)).toBe(privateDer(rotated.identity))

    clock = 3_000
    const third = store.rotate(SEAT_ID)
    expect(third.identity.keyGeneration).toBe(3)
    expect(third.history.retired.map((entry) => entry.keyGeneration)).toEqual([1, 2])
    expect(third.history.retired.map((entry) => entry.retiredAt)).toEqual([2_000, 3_000])
  })

  it('refuses clock rollback and repeated key material without changing the durable identity', () => {
    const storageDirectory = tempStorage()
    const original = makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    const before = readFileSync(identityPath(storageDirectory), 'utf8')

    clock = 999
    expectStoreError(() => makeStore(storageDirectory).rotate(SEAT_ID), 'recovery_blocked')
    expect(readFileSync(identityPath(storageDirectory), 'utf8')).toBe(before)

    clock = 2_000
    expectStoreError(
      () =>
        makeStore(storageDirectory, {
          generateKeyPair: () => ({
            privateKey: original.privateKey,
            publicKey: original.publicKey
          })
        }).rotate(SEAT_ID),
      'persistence_failed'
    )
    expect(readFileSync(identityPath(storageDirectory), 'utf8')).toBe(before)
  })

  it('preserves the committed winner when another rotation lands during encryption', () => {
    const storageDirectory = tempStorage()
    makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    clock = 2_000
    let winner: ReturnType<ChannelAgentIdentityStore['rotate']> | undefined
    const racingStorage: ChannelAgentIdentitySafeStorage = {
      ...secureStorage,
      encryptString: (plaintext) => {
        winner ??= makeStore(storageDirectory).rotate(SEAT_ID)
        return secureStorage.encryptString(plaintext)
      }
    }

    expectStoreError(
      () => makeStore(storageDirectory, { safeStorage: racingStorage }).rotate(SEAT_ID),
      'recovery_blocked'
    )
    expect(winner).toBeDefined()
    const durable = makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    expect(durable.publicKeyB64).toBe(winner!.identity.publicKeyB64)
    expect(durable.keyGeneration).toBe(2)
    expect(readdirSync(storageDirectory).every((name) => !name.includes('.tmp-'))).toBe(true)
  })

  it('leaves the prior generation intact when rotation encryption fails', () => {
    const storageDirectory = tempStorage()
    const original = makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    const before = readFileSync(identityPath(storageDirectory), 'utf8')
    const leakingStorage: ChannelAgentIdentitySafeStorage = {
      ...secureStorage,
      encryptString: () => {
        throw new Error(`do not project ${privateDer(original)}`)
      }
    }
    clock = 2_000

    const error = expectStoreError(
      () => makeStore(storageDirectory, { safeStorage: leakingStorage }).rotate(SEAT_ID),
      'persistence_failed'
    )
    expect(error.message).not.toContain(privateDer(original))
    expect(readFileSync(identityPath(storageDirectory), 'utf8')).toBe(before)
    expect(makeStore(storageDirectory).loadOrCreate(SEAT_ID).publicKeyB64).toBe(
      original.publicKeyB64
    )
  })

  it('refuses unavailable or non-encrypted safeStorage without minting an identity', () => {
    const unavailableDirectory = tempStorage()
    expectStoreError(
      () =>
        makeStore(unavailableDirectory, {
          safeStorage: { ...secureStorage, isEncryptionAvailable: () => false }
        }).loadOrCreate(SEAT_ID),
      'safe_storage_unavailable'
    )
    expect(existsSync(unavailableDirectory)).toBe(false)

    for (const backend of ['basic_text', 'plaintext', 'unknown', '']) {
      const storageDirectory = tempStorage()
      expectStoreError(
        () =>
          makeStore(storageDirectory, {
            platform: 'linux',
            safeStorage: { ...secureStorage, getSelectedStorageBackend: () => backend }
          }).loadOrCreate(SEAT_ID),
        'safe_storage_unavailable'
      )
      expect(existsSync(storageDirectory)).toBe(false)
    }

    const storageDirectory = tempStorage()
    const error = expectStoreError(
      () =>
        makeStore(storageDirectory, {
          safeStorage: {
            ...secureStorage,
            isEncryptionAvailable: () => {
              throw new Error('SECRET_SAFE_STORAGE_DIAGNOSTIC')
            }
          }
        }).loadOrCreate(SEAT_ID),
      'safe_storage_unavailable'
    )
    expect(error.message).not.toContain('SECRET_SAFE_STORAGE_DIAGNOSTIC')
  })

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'accepts the explicitly encrypted Linux safeStorage backend %s',
    (backend) => {
      const storageDirectory = tempStorage()
      const identity = makeStore(storageDirectory, {
        platform: 'linux',
        safeStorage: { ...secureStorage, getSelectedStorageBackend: () => backend }
      }).loadOrCreate(SEAT_ID)
      expect(identity.keyGeneration).toBe(1)
    }
  )

  it('rejects malformed encryption output before publishing an identity file', () => {
    for (const encrypted of [Buffer.alloc(0), Buffer.alloc(200 * 1024), 'not-a-buffer']) {
      const storageDirectory = tempStorage()
      const unsafeStorage: ChannelAgentIdentitySafeStorage = {
        ...secureStorage,
        encryptString: () => encrypted as Buffer
      }
      expectStoreError(
        () => makeStore(storageDirectory, { safeStorage: unsafeStorage }).loadOrCreate(SEAT_ID),
        'persistence_failed'
      )
      expect(existsSync(identityPath(storageDirectory))).toBe(false)
      expect(
        existsSync(storageDirectory) &&
          readdirSync(storageDirectory).some((name) => name.includes('.tmp-'))
      ).toBe(false)
    }

    const first = generateIdentityKeyPair()
    const second = generateIdentityKeyPair()
    const storageDirectory = tempStorage()
    expectStoreError(
      () =>
        makeStore(storageDirectory, {
          generateKeyPair: () => ({
            privateKey: first.privateKey,
            publicKey: second.publicKey
          })
        }).loadOrCreate(SEAT_ID),
      'persistence_failed'
    )
    expect(existsSync(identityPath(storageDirectory))).toBe(false)
  })

  it('quarantines malformed envelopes, blocks regeneration, and requires explicit erasure', () => {
    const storageDirectory = tempStorage()
    const original = makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    writeFileSync(identityPath(storageDirectory), '{not-json', { mode: 0o600 })

    expectStoreError(() => makeStore(storageDirectory).load(SEAT_ID), 'recovery_blocked')
    expect(existsSync(identityPath(storageDirectory))).toBe(false)
    const corrupt = readdirSync(storageDirectory).filter((name) => name.includes('.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expectStoreError(() => makeStore(storageDirectory).loadOrCreate(SEAT_ID), 'recovery_blocked')

    expect(makeStore(storageDirectory).erase(SEAT_ID)).toBe(1)
    const replacement = makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    expect(replacement.publicKeyB64).not.toBe(original.publicKeyB64)
  })

  it('quarantines malformed decrypted state and mismatched private/public keys', () => {
    for (const mutation of ['extra-field', 'mismatched-key', 'broken-history'] as const) {
      const storageDirectory = tempStorage()
      const store = makeStore(storageDirectory)
      store.loadOrCreate(SEAT_ID)
      if (mutation === 'broken-history') {
        clock = 2_000
        store.rotate(SEAT_ID)
      }
      const payload = readPayload(storageDirectory)
      if (mutation === 'extra-field') {
        ;(payload as TestPayload & { unexpected?: boolean }).unexpected = true
      } else if (mutation === 'mismatched-key') {
        payload.current.publicKeyB64 = exportRawEd25519PublicKey(
          generateIdentityKeyPair().publicKey
        ).toString('base64')
      } else {
        payload.retired[0].retiredAt += 1
      }
      writePayload(storageDirectory, payload)

      expectStoreError(() => makeStore(storageDirectory).load(SEAT_ID), 'recovery_blocked')
      expect(readdirSync(storageDirectory).some((name) => name.includes('.corrupt-'))).toBe(true)
    }
  })

  it('blocks decrypt failures and in-flight file changes without replacing the identity', () => {
    const decryptFailureDirectory = tempStorage()
    makeStore(decryptFailureDirectory).loadOrCreate(SEAT_ID)
    const failurePath = identityPath(decryptFailureDirectory)
    const before = readFileSync(failurePath, 'utf8')
    const failingStorage: ChannelAgentIdentitySafeStorage = {
      ...secureStorage,
      decryptString: () => {
        throw new Error('SECRET_DECRYPT_FAILURE')
      }
    }
    const decryptError = expectStoreError(
      () =>
        makeStore(decryptFailureDirectory, { safeStorage: failingStorage }).loadOrCreate(SEAT_ID),
      'recovery_blocked'
    )
    expect(decryptError.message).not.toContain('SECRET_DECRYPT_FAILURE')
    expect(readFileSync(failurePath, 'utf8')).toBe(before)
    expect(readdirSync(decryptFailureDirectory).some((name) => name.includes('.corrupt-'))).toBe(
      false
    )

    const changedDirectory = tempStorage()
    makeStore(changedDirectory).loadOrCreate(SEAT_ID)
    const changedPath = identityPath(changedDirectory)
    let changed = false
    const changingStorage: ChannelAgentIdentitySafeStorage = {
      ...secureStorage,
      decryptString: (ciphertext) => {
        if (!changed) {
          changed = true
          writeFileSync(changedPath, `${readFileSync(changedPath, 'utf8')} `)
        }
        return secureStorage.decryptString(ciphertext)
      }
    }
    expectStoreError(
      () => makeStore(changedDirectory, { safeStorage: changingStorage }).load(SEAT_ID),
      'recovery_blocked'
    )
    expect(existsSync(changedPath)).toBe(true)
    expect(readdirSync(changedDirectory).some((name) => name.includes('.corrupt-'))).toBe(false)
  })

  it('repairs file and directory modes and quarantines an identity-path symlink without following it', () => {
    const storageDirectory = tempStorage()
    makeStore(storageDirectory).loadOrCreate(SEAT_ID)
    const path = identityPath(storageDirectory)
    chmodSync(storageDirectory, 0o755)
    chmodSync(path, 0o644)

    expect(makeStore(storageDirectory).load(SEAT_ID)).not.toBeNull()
    expect(statSync(storageDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const external = join(tempRoot(), 'external-ciphertext.json')
    const original = readFileSync(path, 'utf8')
    writeFileSync(external, original, { mode: 0o600 })
    rmSync(path)
    symlinkSync(external, path)

    expectStoreError(() => makeStore(storageDirectory).load(SEAT_ID), 'recovery_blocked')
    expect(readFileSync(external, 'utf8')).toBe(original)
    expect(existsSync(path)).toBe(false)
    expect(makeStore(storageDirectory).erase(SEAT_ID)).toBe(1)
    expect(readFileSync(external, 'utf8')).toBe(original)
  })

  it('removes stale owned files and purges only this store without following symlinks', () => {
    const storageDirectory = tempStorage()
    const store = makeStore(storageDirectory)
    store.loadOrCreate(SEAT_ID)
    store.loadOrCreate('seat-2')

    const thirdHash = channelAgentSeatFileHash('seat-3')
    const staleFile = join(
      storageDirectory,
      `${thirdHash}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}.tmp-stale`
    )
    const external = join(tempRoot(), 'external-sentinel')
    writeFileSync(staleFile, 'stale')
    writeFileSync(external, 'preserve')
    symlinkSync(external, `${identityPath(storageDirectory, 'seat-3')}.tmp-stale-symlink`)
    store.loadOrCreate('seat-3')
    expect(existsSync(staleFile)).toBe(false)
    expect(readFileSync(external, 'utf8')).toBe('preserve')

    writeFileSync(join(storageDirectory, 'sentinel.txt'), 'preserve')
    writeFileSync(join(storageDirectory, 'f'.repeat(64) + '.identity.json.backup'), 'preserve')
    expect(store.purgeAll()).toBe(3)
    expect(readdirSync(storageDirectory).sort()).toEqual([
      'f'.repeat(64) + '.identity.json.backup',
      'sentinel.txt'
    ])
    expect(readFileSync(external, 'utf8')).toBe('preserve')
  })

  it('bounds history and rejects unsafe seat ids while hashing path-shaped identifiers', () => {
    for (const invalid of ['', ' leading', 'trailing ', 'line\nbreak', 'x'.repeat(513)]) {
      const storageDirectory = tempStorage()
      expectStoreError(() => makeStore(storageDirectory).loadOrCreate(invalid), 'invalid_seat')
      expect(existsSync(storageDirectory)).toBe(false)
    }

    const root = tempRoot()
    const storageDirectory = join(root, 'identities')
    const pathShapedSeat = '../still-a-protocol-identifier'
    makeStore(storageDirectory).loadOrCreate(pathShapedSeat)
    expect(dirname(identityPath(storageDirectory, pathShapedSeat))).toBe(storageDirectory)
    expect(readdirSync(root)).toEqual(['identities'])

    const store = makeStore(storageDirectory)
    store.loadOrCreate(SEAT_ID)
    for (let generation = 0; generation < CHANNEL_AGENT_MAX_RETIRED_KEYS; generation += 1) {
      clock += 1
      store.rotate(SEAT_ID)
    }
    const before = readFileSync(identityPath(storageDirectory), 'utf8')
    clock += 1
    expectStoreError(() => store.rotate(SEAT_ID), 'recovery_blocked')
    expect(readFileSync(identityPath(storageDirectory), 'utf8')).toBe(before)
    expect(store.publicHistory(SEAT_ID)?.retired).toHaveLength(CHANNEL_AGENT_MAX_RETIRED_KEYS)
  })

  it('rejects a symlinked storage directory instead of mutating its target', () => {
    const root = tempRoot()
    const target = join(root, 'target')
    const storageDirectory = join(root, 'identity-link')
    mkdirSync(target)
    writeFileSync(join(target, 'sentinel'), 'preserve')
    symlinkSync(target, storageDirectory)

    expectStoreError(() => makeStore(storageDirectory).loadOrCreate(SEAT_ID), 'recovery_blocked')
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('preserve')
    expect(readdirSync(target)).toEqual(['sentinel'])
  })
})
