import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WebSessionCookieStore,
  type WebSessionSafeStorage,
  type WebSessionStoreIdentity
} from './WebSessionCookieStore'
import {
  MISTRAL_WEB_SESSION_FILENAME,
  MISTRAL_WEB_SESSION_IDENTITY
} from '../mistral/MistralWebSessionStore'
import {
  OLLAMA_WEB_SESSION_FILENAME,
  OLLAMA_WEB_SESSION_IDENTITY
} from '../ollama/OllamaWebSessionStore'
import { MISTRAL_ADMIN_KEY_FILENAME } from '../mistral/MistralAdminKeyStore'

/** Reversible stand-in for Electron safeStorage — enough to exercise the
 *  envelope round trip without an Electron runtime. */
function fakeSafeStorage(overrides: Partial<WebSessionSafeStorage> = {}): WebSessionSafeStorage {
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

const COOKIE = 'ory_session_x=abc123; csrf_token=def456; intercom-id=ghi789'

describe('WebSessionCookieStore', () => {
  let dir: string
  const secretPath = () => join(dir, MISTRAL_WEB_SESSION_IDENTITY.filename)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-web-session-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Neutralise ONLY the Linux encrypted-backend gate. On Linux this store also
  // requires an encrypted safeStorage backend, so a suite that inherits the
  // runner's platform asserts the runner's keyring instead of this class.
  //
  // Do NOT simply pin 'darwin': the store also branches on win32 for
  // O_NOFOLLOW and mode enforcement, so telling a Windows runner it is darwin
  // sends it down POSIX paths Windows cannot satisfy. Substitute darwin only
  // where the gate would otherwise fire; run as the real host everywhere else.
  const HOST_PLATFORM: NodeJS.Platform = process.platform === 'linux' ? 'darwin' : process.platform

  function store(
    safeStorage = fakeSafeStorage(),
    platform: NodeJS.Platform = HOST_PLATFORM,
    identity: WebSessionStoreIdentity = MISTRAL_WEB_SESSION_IDENTITY
  ): WebSessionCookieStore {
    return new WebSessionCookieStore({
      identity,
      userDataPath: dir,
      safeStorage,
      platform,
      now: () => new Date('2026-08-18T12:00:00.000Z')
    })
  }

  it('reports unconfigured before anything is stored', () => {
    expect(store().getStatus()).toEqual({ configured: false, encryptionAvailable: true })
    expect(store().loadCookie()).toEqual({ status: 'missing' })
  })

  it('round-trips a cookie header and never writes it in plaintext', () => {
    const s = store()
    const result = s.setCookie(`  ${COOKIE}  `)
    expect(result.ok).toBe(true)
    expect(result.status.configured).toBe(true)
    expect(result.status.updatedAt).toBe('2026-08-18T12:00:00.000Z')
    expect(s.loadCookie()).toEqual({ status: 'ok', value: COOKIE })
    // The cookie must not appear anywhere in the file as typed.
    expect(readFileSync(secretPath(), 'utf8')).not.toContain('abc123')
  })

  it('writes the record 0600 so another local account cannot read it', () => {
    store().setCookie(COOKIE)
    if (process.platform === 'win32') return
    expect(statSync(secretPath()).mode & 0o777).toBe(0o600)
  })

  it('rejects an empty or oversized cookie rather than storing junk', () => {
    const s = store()
    expect(s.setCookie('   ').error).toBe('invalidCookie')
    expect(s.setCookie('x'.repeat(32_769)).error).toBe('invalidCookie')
    expect(s.getStatus().configured).toBe(false)
  })

  it('accepts a cookie header right at the 32 KiB cap', () => {
    // Console sessions join several cookies into one header; the old 4 KiB
    // API-key cap rejected real captures.
    expect(store().setCookie(`big=${'x'.repeat(32_764)}`).ok).toBe(true)
  })

  it('rejects control bytes — a cookie header is one line, anything else is header injection', () => {
    const s = store()
    expect(s.setCookie('a=1\r\nHost: evil.example').error).toBe('invalidCookie')
    expect(s.setCookie('a=1\nb=2').error).toBe('invalidCookie')
    expect(s.setCookie('a=1\tb=2').error).toBe('invalidCookie')
  })

  it('refuses to store when encryption is unavailable', () => {
    const s = store(fakeSafeStorage({ isEncryptionAvailable: () => false }))
    const result = s.setCookie(COOKIE)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('encryptionUnavailable')
    expect(s.loadCookie()).toEqual({ status: 'encryptionUnavailable' })
  })

  it('reports a corrupt record as CONFIGURED so no UI offers a silent overwrite', () => {
    writeFileSync(secretPath(), '{ not json', { mode: 0o600 })
    const s = store()
    expect(s.getStatus().configured).toBe(true)
    expect(s.loadCookie().status).toBe('corrupt')
  })

  it('blocks a write over an unreadable record until it is explicitly cleared', () => {
    // THE recovery boundary: silently replacing a record we could not decrypt
    // would destroy a session the user may still be able to recover.
    writeFileSync(secretPath(), '{ not json', { mode: 0o600 })
    const s = store()
    const blocked = s.setCookie(COOKIE)
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toBe('existingRecordUnreadable')

    expect(s.clear().ok).toBe(true)
    expect(s.setCookie(COOKIE).ok).toBe(true)
    expect(s.loadCookie()).toEqual({ status: 'ok', value: COOKIE })
  })

  it('surfaces a decrypt failure distinctly from corruption', () => {
    store().setCookie(COOKIE)
    const broken = store(
      fakeSafeStorage({
        decryptString: () => {
          throw new Error('wrong keychain')
        }
      })
    )
    expect(broken.loadCookie()).toEqual({ status: 'decryptFailed' })
  })

  it('rejects an envelope whose schema does not match exactly', () => {
    // Extra or missing keys must fail the exact-object check rather than being
    // tolerated — that check is what makes a tampered file inert.
    writeFileSync(
      secretPath(),
      JSON.stringify({
        schemaVersion: 1,
        purpose: MISTRAL_WEB_SESSION_IDENTITY.envelopePurpose,
        updatedAt: '2026-08-18T12:00:00.000Z',
        encryptedPayload: Buffer.from('enc:{}', 'utf8').toString('base64'),
        extra: 'field'
      }),
      { mode: 0o600 }
    )
    expect(store().loadCookie().status).toBe('corrupt')
  })

  it("rejects a payload carrying another store's purpose — the collision this class exists to prevent", () => {
    // The first cut of the web-session stores shipped with the Mistral ADMIN
    // KEY identity constants, so all three stores read and wrote the same
    // file. A Mistral-purpose payload surfacing through an Ollama-identity
    // store must read as corrupt, never as a session.
    const payload = JSON.stringify({
      schemaVersion: 1,
      purpose: MISTRAL_WEB_SESSION_IDENTITY.secretPurpose,
      cookie: COOKIE
    })
    writeFileSync(
      secretPath(),
      JSON.stringify({
        schemaVersion: 1,
        purpose: MISTRAL_WEB_SESSION_IDENTITY.envelopePurpose,
        updatedAt: '2026-08-18T12:00:00.000Z',
        encryptedPayload: Buffer.from(`enc:${payload}`, 'utf8').toString('base64')
      }),
      { mode: 0o600 }
    )
    // Same bytes, Mistral identity: fine. Ollama identity pointed at the same
    // file (filename overridden to force the collision): corrupt.
    expect(store().loadCookie()).toEqual({ status: 'ok', value: COOKIE })
    const collided = store(fakeSafeStorage(), HOST_PLATFORM, {
      ...OLLAMA_WEB_SESSION_IDENTITY,
      filename: MISTRAL_WEB_SESSION_IDENTITY.filename
    })
    expect(collided.loadCookie().status).toBe('corrupt')
  })

  it('clears to a clean unconfigured state and tolerates a missing file', () => {
    const s = store()
    s.setCookie(COOKIE)
    expect(s.clear()).toEqual({
      ok: true,
      status: { configured: false, encryptionAvailable: true }
    })
    expect(s.loadCookie()).toEqual({ status: 'missing' })
    // Clearing again is a no-op, not an error.
    expect(s.clear().ok).toBe(true)
  })

  it('requires an absolute userData path', () => {
    expect(
      () =>
        new WebSessionCookieStore({
          identity: MISTRAL_WEB_SESSION_IDENTITY,
          userDataPath: 'relative',
          safeStorage: fakeSafeStorage()
        })
    ).toThrow(TypeError)
  })

  it('requires a complete identity with distinct purposes', () => {
    const base = MISTRAL_WEB_SESSION_IDENTITY
    for (const identity of [
      { ...base, filename: '' },
      { ...base, secretPurpose: '' },
      { ...base, envelopePurpose: '' },
      { ...base, envelopePurpose: base.secretPurpose }
    ]) {
      expect(
        () =>
          new WebSessionCookieStore({ identity, userDataPath: dir, safeStorage: fakeSafeStorage() })
      ).toThrow(TypeError)
    }
  })

  describe('provider identities', () => {
    it('every identity constant is distinct across the web-session stores AND the admin key store', () => {
      // The regression this suite pins: the first cut shipped all three
      // stores with filename 'mistral-admin-api-key.json' and the admin-key
      // purposes, so importing a web session clobbered the Admin API key.
      const identities = [MISTRAL_WEB_SESSION_IDENTITY, OLLAMA_WEB_SESSION_IDENTITY]
      const claimed = identities.flatMap((identity) => [
        identity.filename,
        identity.secretPurpose,
        identity.envelopePurpose
      ])
      // The admin store's purposes are module-private; the literals are pinned
      // here so a copy-paste regression cannot silently re-collide with them.
      const reserved = [
        MISTRAL_ADMIN_KEY_FILENAME,
        'taskwraith:mistral-admin-api-key:v1',
        'taskwraith:mistral-admin-api-key-envelope:v1'
      ]
      const all = [...claimed, ...reserved]
      expect(new Set(all).size).toBe(all.length)
      expect(MISTRAL_WEB_SESSION_FILENAME).toBe('mistral-web-session.json')
      expect(OLLAMA_WEB_SESSION_FILENAME).toBe('ollama-web-session.json')
    })

    it('a cookie stored under one provider identity never loads under the other', () => {
      const mistral = store()
      mistral.setCookie(COOKIE)
      const ollamaAtSamePath = store(fakeSafeStorage(), HOST_PLATFORM, {
        ...OLLAMA_WEB_SESSION_IDENTITY,
        filename: MISTRAL_WEB_SESSION_IDENTITY.filename
      })
      expect(ollamaAtSamePath.loadCookie().status).toBe('corrupt')
    })
  })
})
