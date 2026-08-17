import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MISTRAL_API_KEY_FILENAME,
  MistralApiKeyStore,
  configureMistralApiKeyStore,
  mistralApiKeyStore,
  type MistralSafeStorage
} from './MistralApiKeyStore'

const UPDATED_AT = '2026-08-17T14:30:00.000Z'
const API_KEY = 'mistral-test-byok-api-key-12345'
const directories: string[] = []

function tempUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tw-mistral-api-key-test-'))
  directories.push(directory)
  return directory
}

function xorCipher(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0xa5))
}

const secureStorage: MistralSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => xorCipher(Buffer.from(plaintext, 'utf8')),
  decryptString: (ciphertext) => xorCipher(ciphertext).toString('utf8'),
  getSelectedStorageBackend: () => 'kwallet6'
}

function makeStore(
  userDataPath: string,
  safeStorage: MistralSafeStorage = secureStorage,
  platform?: NodeJS.Platform
): MistralApiKeyStore {
  return new MistralApiKeyStore({
    userDataPath,
    safeStorage,
    now: () => new Date(UPDATED_AT),
    platform
  })
}

function keyFilePath(userDataPath: string): string {
  return join(userDataPath, MISTRAL_API_KEY_FILENAME)
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('MistralApiKeyStore', () => {
  it('reports configured=false when missing', () => {
    const dir = tempUserData()
    const store = makeStore(dir)
    expect(store.getStatus()).toEqual({
      configured: false,
      encryptionAvailable: true
    })
    expect(store.loadApiKey()).toEqual({ status: 'missing' })
  })

  it('stores, encrypts, and retrieves an API key', () => {
    const dir = tempUserData()
    const store = makeStore(dir)

    const mutation = store.setApiKey(API_KEY)
    expect(mutation.ok).toBe(true)
    expect(mutation.status).toEqual({
      configured: true,
      encryptionAvailable: true,
      updatedAt: UPDATED_AT
    })

    const load = store.loadApiKey()
    expect(load).toEqual({ status: 'ok', value: API_KEY })

    // Verify written file permissions on unix
    if (process.platform !== 'win32') {
      const stats = statSync(keyFilePath(dir))
      expect(stats.mode & 0o777).toBe(0o600)
    }
  })

  it('clears a stored API key', () => {
    const dir = tempUserData()
    const store = makeStore(dir)

    store.setApiKey(API_KEY)
    expect(store.getStatus().configured).toBe(true)

    const clearRes = store.clear()
    expect(clearRes.ok).toBe(true)
    expect(store.getStatus().configured).toBe(false)
    expect(store.loadApiKey()).toEqual({ status: 'missing' })
    expect(existsSync(keyFilePath(dir))).toBe(false)
  })

  it('rejects invalid key inputs', () => {
    const dir = tempUserData()
    const store = makeStore(dir)

    expect(store.setApiKey('').ok).toBe(false)
    expect(store.setApiKey('   ').ok).toBe(false)
    expect(store.setApiKey('a'.repeat(5000)).ok).toBe(false)
  })

  it('refuses to store when encryption is unavailable', () => {
    const dir = tempUserData()
    const unencryptedStorage: MistralSafeStorage = {
      isEncryptionAvailable: () => false,
      encryptString: (plaintext) => Buffer.from(plaintext),
      decryptString: (ciphertext) => ciphertext.toString('utf8')
    }
    const store = makeStore(dir, unencryptedStorage)

    expect(store.getStatus().encryptionAvailable).toBe(false)
    const res = store.setApiKey(API_KEY)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('encryptionUnavailable')
  })

  it('detects corrupted or tampered envelopes fail-closed', () => {
    const dir = tempUserData()
    const store = makeStore(dir)
    store.setApiKey(API_KEY)

    // Overwrite with invalid json
    writeFileSync(keyFilePath(dir), '{ corrupt json', 'utf8')
    expect(store.getStatus().configured).toBe(false)
    expect(store.loadApiKey()).toEqual({ status: 'corrupt' })
    expect(store.setApiKey('new-key').error).toBe('existingRecordUnreadable')
  })

  it('manages configure singleton', () => {
    const dir = tempUserData()
    const store = configureMistralApiKeyStore({
      userDataPath: dir,
      safeStorage: secureStorage
    })
    expect(mistralApiKeyStore()).toBe(store)
  })
})
