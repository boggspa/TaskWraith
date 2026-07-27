import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MISTRAL_ADMIN_KEY_FILENAME,
  MistralAdminKeyStore,
  type MistralAdminSafeStorage
} from './MistralAdminKeyStore'

/** Reversible stand-in for Electron safeStorage — enough to exercise the
 *  envelope round trip without an Electron runtime. */
function fakeSafeStorage(
  overrides: Partial<MistralAdminSafeStorage> = {}
): MistralAdminSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => {
      const raw = ciphertext.toString('utf8')
      if (!raw.startsWith('enc:')) throw new Error('not our ciphertext')
      return raw.slice(4)
    },
    ...overrides
  }
}

describe('MistralAdminKeyStore', () => {
  let dir: string
  const secretPath = () => join(dir, MISTRAL_ADMIN_KEY_FILENAME)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-mistral-admin-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function store(safeStorage = fakeSafeStorage()): MistralAdminKeyStore {
    return new MistralAdminKeyStore({
      userDataPath: dir,
      safeStorage,
      now: () => new Date('2026-07-27T12:00:00.000Z')
    })
  }

  it('reports unconfigured before anything is stored', () => {
    expect(store().getStatus()).toEqual({ configured: false, encryptionAvailable: true })
    expect(store().loadApiKey()).toEqual({ status: 'missing' })
  })

  it('round-trips a key and never writes it in plaintext', () => {
    const s = store()
    const result = s.setApiKey('  admin-key-123  ')
    expect(result.ok).toBe(true)
    expect(result.status.configured).toBe(true)
    expect(result.status.updatedAt).toBe('2026-07-27T12:00:00.000Z')
    expect(s.loadApiKey()).toEqual({ status: 'ok', value: 'admin-key-123' })
    // The key must not appear anywhere in the file as typed.
    expect(readFileSync(secretPath(), 'utf8')).not.toContain('admin-key-123')
  })

  it('writes the record 0600 so another local account cannot read it', () => {
    store().setApiKey('admin-key-123')
    if (process.platform === 'win32') return
    expect(statSync(secretPath()).mode & 0o777).toBe(0o600)
  })

  it('rejects an empty or oversized key rather than storing junk', () => {
    const s = store()
    expect(s.setApiKey('   ').error).toBe('invalidApiKey')
    expect(s.setApiKey('x'.repeat(4_097)).error).toBe('invalidApiKey')
    expect(s.getStatus().configured).toBe(false)
  })

  it('refuses to store when encryption is unavailable', () => {
    const s = store(fakeSafeStorage({ isEncryptionAvailable: () => false }))
    const result = s.setApiKey('admin-key-123')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('encryptionUnavailable')
    expect(s.loadApiKey()).toEqual({ status: 'encryptionUnavailable' })
  })

  it('reports a corrupt record as CONFIGURED so no UI offers a silent overwrite', () => {
    writeFileSync(secretPath(), '{ not json', { mode: 0o600 })
    const s = store()
    expect(s.getStatus().configured).toBe(true)
    expect(s.loadApiKey().status).toBe('corrupt')
  })

  it('blocks a write over an unreadable record until it is explicitly cleared', () => {
    // THE recovery boundary: silently replacing a record we could not decrypt
    // would destroy a key the user may still be able to recover.
    writeFileSync(secretPath(), '{ not json', { mode: 0o600 })
    const s = store()
    const blocked = s.setApiKey('replacement')
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toBe('existingRecordUnreadable')

    expect(s.clear().ok).toBe(true)
    expect(s.setApiKey('replacement').ok).toBe(true)
    expect(s.loadApiKey()).toEqual({ status: 'ok', value: 'replacement' })
  })

  it('surfaces a decrypt failure distinctly from corruption', () => {
    store().setApiKey('admin-key-123')
    const broken = store(
      fakeSafeStorage({
        decryptString: () => {
          throw new Error('wrong keychain')
        }
      })
    )
    expect(broken.loadApiKey()).toEqual({ status: 'decryptFailed' })
  })

  it('rejects an envelope whose schema does not match exactly', () => {
    // Extra or missing keys must fail the exact-object check rather than being
    // tolerated — that check is what makes a tampered file inert.
    writeFileSync(
      secretPath(),
      JSON.stringify({
        schemaVersion: 1,
        purpose: 'taskwraith:mistral-admin-api-key-envelope:v1',
        updatedAt: '2026-07-27T12:00:00.000Z',
        encryptedPayload: Buffer.from('enc:{}', 'utf8').toString('base64'),
        extra: 'field'
      }),
      { mode: 0o600 }
    )
    expect(store().loadApiKey().status).toBe('corrupt')
  })

  it('rejects a payload carrying another store’s purpose', () => {
    // Guards against a key file being moved between stores.
    const payload = JSON.stringify({
      schemaVersion: 1,
      purpose: 'taskwraith:antigravity-gemini-api-key:v1',
      apiKey: 'admin-key-123'
    })
    writeFileSync(
      secretPath(),
      JSON.stringify({
        schemaVersion: 1,
        purpose: 'taskwraith:mistral-admin-api-key-envelope:v1',
        updatedAt: '2026-07-27T12:00:00.000Z',
        encryptedPayload: Buffer.from(`enc:${payload}`, 'utf8').toString('base64')
      }),
      { mode: 0o600 }
    )
    expect(store().loadApiKey().status).toBe('corrupt')
  })

  it('clears to a clean unconfigured state and tolerates a missing file', () => {
    const s = store()
    s.setApiKey('admin-key-123')
    expect(s.clear()).toEqual({
      ok: true,
      status: { configured: false, encryptionAvailable: true }
    })
    expect(s.loadApiKey()).toEqual({ status: 'missing' })
    // Clearing again is a no-op, not an error.
    expect(s.clear().ok).toBe(true)
  })

  it('requires an absolute userData path', () => {
    expect(
      () => new MistralAdminKeyStore({ userDataPath: 'relative', safeStorage: fakeSafeStorage() })
    ).toThrow(TypeError)
  })
})
