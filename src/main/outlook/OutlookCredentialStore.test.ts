import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OUTLOOK_CREDENTIAL_FILENAME,
  OutlookCredentialStore,
  type OutlookCredentials,
  type OutlookSafeStorage
} from './OutlookCredentialStore'

let dirs: string[] = []

function makeUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-outlook-store-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/** Reversible stand-in for Electron safeStorage — never the real crypto. */
function fakeSafeStorage(overrides: Partial<OutlookSafeStorage> = {}): OutlookSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => {
      const text = ciphertext.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    },
    ...overrides
  }
}

const CREDENTIALS: OutlookCredentials = {
  clientId: '11111111-2222-3333-4444-555555555555',
  tenant: 'common',
  scopeMode: 'read',
  account: 'alice@example.com',
  tokens: {
    accessToken: 'ACCESS',
    refreshToken: 'REFRESH',
    expiresAtMs: 1_800_003_600_000,
    scopes: ['Mail.Read'],
    account: 'alice@example.com'
  }
}

describe('save / load / status', () => {
  it('round-trips credentials and reports a projection without secrets', () => {
    const userData = makeUserData()
    const store = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage(),
      platform: 'darwin',
      now: () => new Date('2026-07-25T10:00:00.000Z')
    })

    const saved = store.save(CREDENTIALS)
    expect(saved.ok).toBe(true)
    expect(saved.status).toEqual({
      connected: true,
      encryptionAvailable: true,
      account: 'alice@example.com',
      scopeMode: 'read',
      updatedAt: '2026-07-25T10:00:00.000Z'
    })

    const loaded = store.load()
    expect(loaded).toEqual({ status: 'ok', credentials: CREDENTIALS })

    // The status projection is the renderer-facing shape: no token material.
    const projected = JSON.stringify(saved.status)
    expect(projected).not.toContain('ACCESS')
    expect(projected).not.toContain('REFRESH')
    expect(projected).not.toContain(userData)
  })

  it('writes an owner-only file whose contents contain no plaintext token', () => {
    const userData = makeUserData()
    const store = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage(),
      platform: 'darwin'
    })
    store.save(CREDENTIALS)
    const filePath = join(userData, OUTLOOK_CREDENTIAL_FILENAME)
    // Windows has no POSIX mode bits — NTFS reports 0666 whatever chmod asked
    // for — so the owner-only claim is only assertable where it is enforceable.
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
    }
    const raw = readFileSync(filePath, 'utf8')
    const envelope = JSON.parse(raw)
    expect(envelope.purpose).toBe('taskwraith:outlook-graph-credentials-envelope:v1')
    // Only the encrypted payload — the fake cipher is reversible, so assert
    // the envelope shape rather than absence of the substring.
    expect(Object.keys(envelope).sort()).toEqual([
      'encryptedPayload',
      'purpose',
      'schemaVersion',
      'updatedAt'
    ])
  })

  it('refuses to store anything when encryption is unavailable', () => {
    const userData = makeUserData()
    const store = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
      platform: 'darwin'
    })
    const result = store.save(CREDENTIALS)
    expect(result.ok).toBe(false)
    expect(result.status).toEqual({ connected: false, encryptionAvailable: false })
    expect(() => statSync(join(userData, OUTLOOK_CREDENTIAL_FILENAME))).toThrow()
    expect(store.load()).toEqual({ status: 'encryptionUnavailable' })
  })

  it('treats unlisted Linux backends as unavailable (no plaintext fallback)', () => {
    const userData = makeUserData()
    const basic = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
      platform: 'linux'
    })
    expect(basic.save(CREDENTIALS).ok).toBe(false)

    const libsecret = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => 'gnome_libsecret' }),
      platform: 'linux'
    })
    expect(libsecret.save(CREDENTIALS).ok).toBe(true)
  })
})

describe('failure modes', () => {
  it('reports missing when nothing is stored', () => {
    const store = new OutlookCredentialStore({
      userDataPath: makeUserData(),
      safeStorage: fakeSafeStorage(),
      platform: 'darwin'
    })
    expect(store.status()).toEqual({ connected: false, encryptionAvailable: true })
    expect(store.load()).toEqual({ status: 'missing' })
  })

  it('reports a corrupt envelope as connected so the UI offers disconnect', () => {
    const userData = makeUserData()
    writeFileSync(join(userData, OUTLOOK_CREDENTIAL_FILENAME), 'not json\n', 'utf8')
    const store = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage(),
      platform: 'darwin'
    })
    expect(store.status()).toEqual({ connected: true, encryptionAvailable: true })
    expect(store.load()).toEqual({ status: 'corrupt' })
  })

  it('reports decryptFailed without throwing when the cipher rejects', () => {
    const userData = makeUserData()
    const store = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage(),
      platform: 'darwin'
    })
    store.save(CREDENTIALS)
    const broken = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage({
        decryptString: () => {
          throw new Error('key rotated')
        }
      }),
      platform: 'darwin'
    })
    expect(broken.load()).toEqual({ status: 'decryptFailed' })
  })

  it('rejects a payload missing an access token', () => {
    const userData = makeUserData()
    const safeStorage = fakeSafeStorage()
    const store = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage,
      platform: 'darwin'
    })
    store.save(CREDENTIALS)
    // Re-encrypt a payload with the token stripped.
    const filePath = join(userData, OUTLOOK_CREDENTIAL_FILENAME)
    const envelope = JSON.parse(readFileSync(filePath, 'utf8'))
    const payload = JSON.parse(
      safeStorage.decryptString(Buffer.from(envelope.encryptedPayload, 'base64'))
    )
    delete payload.tokens.accessToken
    envelope.encryptedPayload = safeStorage
      .encryptString(JSON.stringify(payload))
      .toString('base64')
    writeFileSync(filePath, JSON.stringify(envelope), 'utf8')
    expect(store.load()).toEqual({ status: 'corrupt' })
  })

  it('clears cleanly and is idempotent', () => {
    const userData = makeUserData()
    const store = new OutlookCredentialStore({
      userDataPath: userData,
      safeStorage: fakeSafeStorage(),
      platform: 'darwin'
    })
    store.save(CREDENTIALS)
    expect(store.clear()).toEqual({
      ok: true,
      status: { connected: false, encryptionAvailable: true }
    })
    expect(store.clear().ok).toBe(true)
    expect(store.status().connected).toBe(false)
  })
})
