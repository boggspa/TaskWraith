import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_GEMINI_API_SECRET_FILENAME,
  AntigravityGeminiApiSecretStore,
  type AntigravityGeminiApiSafeStorage
} from './AntigravityGeminiApiSecretStore'

const UPDATED_AT = '2026-07-23T14:30:00.000Z'
const API_KEY = 'AIza-explicit-user-supplied-test-key'
const PURPOSE = 'taskwraith:antigravity-gemini-api-key:v1'
const directories: string[] = []
const platformRestorers: Array<() => void> = []

function tempUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tw-antigravity-gemini-secret-'))
  directories.push(directory)
  return directory
}

function xorCipher(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0xa5))
}

const secureStorage: AntigravityGeminiApiSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => xorCipher(Buffer.from(plaintext, 'utf8')),
  decryptString: (ciphertext) => xorCipher(ciphertext).toString('utf8'),
  getSelectedStorageBackend: () => 'kwallet6'
}

function makeStore(
  userDataPath: string,
  safeStorage: AntigravityGeminiApiSafeStorage = secureStorage
): AntigravityGeminiApiSecretStore {
  return new AntigravityGeminiApiSecretStore({
    userDataPath,
    safeStorage,
    now: () => new Date(UPDATED_AT)
  })
}

function secretPath(userDataPath: string): string {
  return join(userDataPath, ANTIGRAVITY_GEMINI_API_SECRET_FILENAME)
}

function emulateProcessPlatform(platform: NodeJS.Platform): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor?.configurable) {
    throw new Error('process.platform is not configurable in this Node test runtime')
  }
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: descriptor.enumerable,
    value: platform
  })
  platformRestorers.push(() => Object.defineProperty(process, 'platform', descriptor))
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const restore of platformRestorers.splice(0).reverse()) restore()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AntigravityGeminiApiSecretStore', () => {
  it.each(['darwin', 'win32'] as const)(
    'round-trips one encrypted key on %s without exposing it in status or storage',
    (platform) => {
      emulateProcessPlatform(platform)
      const userDataPath = tempUserData()
      const store = makeStore(userDataPath)

      const mutation = store.setApiKey(`  ${API_KEY}  `)

      expect(mutation).toEqual({
        ok: true,
        status: {
          configured: true,
          encryptionAvailable: true,
          updatedAt: UPDATED_AT
        }
      })
      expect(store.getStatus()).toEqual(mutation.status)
      expect(Object.keys(store.getStatus()).sort()).toEqual([
        'configured',
        'encryptionAvailable',
        'updatedAt'
      ])
      expect(store.loadApiKey()).toEqual({ status: 'ok', value: API_KEY })

      const atRest = readFileSync(secretPath(userDataPath), 'utf8')
      expect(atRest).not.toContain(API_KEY)
      expect(JSON.stringify(mutation)).not.toContain(API_KEY)
      expect(JSON.stringify(store.getStatus())).not.toContain(API_KEY)
      expect(readdirSync(userDataPath)).toEqual([ANTIGRAVITY_GEMINI_API_SECRET_FILENAME])
    }
  )

  it('creates the dedicated file with owner-only permissions', () => {
    const userDataPath = tempUserData()
    expect(makeStore(userDataPath).setApiKey(API_KEY).ok).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(secretPath(userDataPath)).mode & 0o777).toBe(0o600)
    }
  })

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'accepts the reviewed encrypted Linux backend %s',
    (backend) => {
      emulateProcessPlatform('linux')
      const userDataPath = tempUserData()
      const store = makeStore(userDataPath, {
        ...secureStorage,
        getSelectedStorageBackend: () => backend
      })

      expect(store.setApiKey(API_KEY).ok).toBe(true)
      expect(store.loadApiKey()).toEqual({ status: 'ok', value: API_KEY })
    }
  )

  it.each(['basic_text', 'unknown', 'plaintext', ''] as const)(
    'fails closed for the Linux safeStorage backend %j',
    (backend) => {
      emulateProcessPlatform('linux')
      const userDataPath = tempUserData()
      const store = makeStore(userDataPath, {
        ...secureStorage,
        getSelectedStorageBackend: () => backend
      })

      expect(store.getStatus()).toEqual({
        configured: false,
        encryptionAvailable: false
      })
      expect(store.setApiKey(API_KEY)).toEqual({
        ok: false,
        error: 'encryptionUnavailable',
        status: { configured: false, encryptionAvailable: false }
      })
      expect(store.loadApiKey()).toEqual({ status: 'encryptionUnavailable' })
      expect(existsSync(secretPath(userDataPath))).toBe(false)
    }
  )

  it('fails closed when Linux safeStorage has no selected backend', () => {
    emulateProcessPlatform('linux')
    const userDataPath = tempUserData()
    const store = makeStore(userDataPath, {
      ...secureStorage,
      getSelectedStorageBackend: undefined
    })

    expect(store.setApiKey(API_KEY).error).toBe('encryptionUnavailable')
    expect(store.loadApiKey()).toEqual({ status: 'encryptionUnavailable' })
    expect(existsSync(secretPath(userDataPath))).toBe(false)
  })

  it('fails closed when safeStorage is unavailable on Darwin and Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      emulateProcessPlatform(platform)
      const userDataPath = tempUserData()
      const store = makeStore(userDataPath, {
        ...secureStorage,
        isEncryptionAvailable: () => false
      })

      expect(store.setApiKey(API_KEY).error).toBe('encryptionUnavailable')
      expect(store.loadApiKey()).toEqual({ status: 'encryptionUnavailable' })
      expect(existsSync(secretPath(userDataPath))).toBe(false)
      platformRestorers.pop()?.()
    }
  })

  it('rejects empty and oversized key input without creating storage', () => {
    const userDataPath = tempUserData()
    const store = makeStore(userDataPath)

    for (const input of ['', ' \n\t ', 'x'.repeat(4_097)]) {
      const result = store.setApiKey(input)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('invalidApiKey')
    }
    expect(existsSync(secretPath(userDataPath))).toBe(false)
  })

  it('clears the key idempotently without requiring safeStorage', () => {
    const userDataPath = tempUserData()
    const store = makeStore(userDataPath)
    expect(store.clear()).toEqual({
      ok: true,
      status: { configured: false, encryptionAvailable: true }
    })
    expect(store.setApiKey(API_KEY).ok).toBe(true)

    const unavailable = makeStore(userDataPath, {
      ...secureStorage,
      isEncryptionAvailable: () => false
    })
    expect(unavailable.clear()).toEqual({
      ok: true,
      status: { configured: false, encryptionAvailable: false }
    })
    expect(unavailable.clear().ok).toBe(true)
    expect(existsSync(secretPath(userDataPath))).toBe(false)
  })

  it('returns typed failures when safeStorage callbacks throw and never logs their text', () => {
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {})
    ]
    const secretBearingError = new Error(`callback leaked ${API_KEY}`)
    const userDataPath = tempUserData()

    const availabilityFailure = makeStore(userDataPath, {
      ...secureStorage,
      isEncryptionAvailable: () => {
        throw secretBearingError
      }
    })
    expect(availabilityFailure.setApiKey(API_KEY).error).toBe('encryptionUnavailable')
    expect(availabilityFailure.loadApiKey()).toEqual({ status: 'encryptionUnavailable' })

    const encryptFailure = makeStore(userDataPath, {
      ...secureStorage,
      encryptString: () => {
        throw secretBearingError
      }
    })
    const encryptResult = encryptFailure.setApiKey(API_KEY)
    expect(encryptResult.error).toBe('encryptFailed')
    expect(JSON.stringify(encryptResult)).not.toContain(API_KEY)

    const emptyEncryption = makeStore(userDataPath, {
      ...secureStorage,
      encryptString: () => Buffer.alloc(0)
    })
    expect(emptyEncryption.setApiKey(API_KEY).error).toBe('encryptFailed')

    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  it('fails closed when Linux backend detection throws', () => {
    emulateProcessPlatform('linux')
    const userDataPath = tempUserData()
    const store = makeStore(userDataPath, {
      ...secureStorage,
      getSelectedStorageBackend: () => {
        throw new Error(`backend leaked ${API_KEY}`)
      }
    })

    const result = store.setApiKey(API_KEY)
    expect(result.error).toBe('encryptionUnavailable')
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(existsSync(secretPath(userDataPath))).toBe(false)
  })

  it('returns decryptFailed without surfacing a secret-bearing callback error', () => {
    const userDataPath = tempUserData()
    expect(makeStore(userDataPath).setApiKey(API_KEY).ok).toBe(true)
    const store = makeStore(userDataPath, {
      ...secureStorage,
      decryptString: () => {
        throw new Error(`decrypt leaked ${API_KEY}`)
      }
    })

    const result = store.loadApiKey()
    expect(result).toEqual({ status: 'decryptFailed' })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it.each([
    ['wrong purpose', { schemaVersion: 1, purpose: 'other-purpose', apiKey: API_KEY }],
    ['wrong schema', { schemaVersion: 2, purpose: PURPOSE, apiKey: API_KEY }],
    ['extra field', { schemaVersion: 1, purpose: PURPOSE, apiKey: API_KEY, unexpected: true }],
    ['empty key', { schemaVersion: 1, purpose: PURPOSE, apiKey: '' }]
  ])('rejects and preserves an encrypted payload with %s', (_label, inner) => {
    const userDataPath = tempUserData()
    const path = secretPath(userDataPath)
    const envelope = {
      schemaVersion: 1,
      purpose: 'taskwraith:antigravity-gemini-api-key-envelope:v1',
      updatedAt: UPDATED_AT,
      encryptedPayload: secureStorage.encryptString(JSON.stringify(inner)).toString('base64')
    }
    writeFileSync(path, JSON.stringify(envelope) + '\n', { mode: 0o600 })
    const before = readFileSync(path, 'utf8')
    const store = makeStore(userDataPath)

    expect(store.loadApiKey()).toEqual({ status: 'corrupt' })
    expect(store.setApiKey('replacement-key')).toMatchObject({
      ok: false,
      error: 'existingRecordUnreadable'
    })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('tolerates malformed and oversized records without replacing them', () => {
    for (const persisted of ['{not json', 'x'.repeat(64 * 1024 + 1)]) {
      const userDataPath = tempUserData()
      const path = secretPath(userDataPath)
      writeFileSync(path, persisted, { mode: 0o600 })
      const store = makeStore(userDataPath)

      expect(store.getStatus()).toEqual({
        configured: true,
        encryptionAvailable: true
      })
      expect(store.loadApiKey()).toEqual({ status: 'corrupt' })
      expect(store.setApiKey('replacement-key').error).toBe('existingRecordUnreadable')
      expect(readFileSync(path, 'utf8')).toBe(persisted)
    }
  })

  it('tolerates a non-regular secret path without traversing or replacing it', () => {
    const userDataPath = tempUserData()
    const path = secretPath(userDataPath)
    mkdirSync(path)
    const store = makeStore(userDataPath)

    expect(store.getStatus()).toEqual({
      configured: true,
      encryptionAvailable: true
    })
    expect(store.loadApiKey()).toEqual({ status: 'unreadable' })
    expect(store.setApiKey('replacement-key').error).toBe('existingRecordUnreadable')
    expect(lstatSync(path).isDirectory()).toBe(true)
  })

  it('keeps configured status while safeStorage is temporarily unavailable', () => {
    const userDataPath = tempUserData()
    expect(makeStore(userDataPath).setApiKey(API_KEY).ok).toBe(true)

    const unavailable = makeStore(userDataPath, {
      ...secureStorage,
      isEncryptionAvailable: () => false
    })
    expect(unavailable.getStatus()).toEqual({
      configured: true,
      encryptionAvailable: false,
      updatedAt: UPDATED_AT
    })
    expect(unavailable.loadApiKey()).toEqual({ status: 'encryptionUnavailable' })
  })
})
