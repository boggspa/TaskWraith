import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PI_PROVIDER_KEYS_FILENAME, PiKeyStore, type PiSafeStorage } from './PiKeyStore'

/** Reversible stand-in for Electron safeStorage; never a real cipher. */
function fakeSafeStorage(overrides: Partial<PiSafeStorage> = {}): PiSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => {
      const raw = ciphertext.toString('utf8')
      if (!raw.startsWith('enc:')) throw new Error('bad ciphertext')
      return raw.slice(4)
    },
    ...overrides
  }
}

describe('PiKeyStore', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-key-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Neutralise ONLY the Linux backend gate. On Linux the store additionally
  // requires an ENCRYPTED safeStorage backend, so a suite that inherits the
  // runner's platform asserts the runner's keyring instead of this class —
  // every classification below passed on macOS and returned
  // `encryptionUnavailable` on headless Linux CI.
  //
  // But do NOT pin a single platform either: the store also branches on
  // `win32` for `O_NOFOLLOW` and mode enforcement, so telling a Windows runner
  // it is darwin makes it attempt POSIX operations Windows cannot satisfy and
  // `setKey` starts returning false. Substitute darwin only where the gate
  // would otherwise fire; everywhere else run as the real host.
  const HOST_PLATFORM: NodeJS.Platform = process.platform === 'linux' ? 'darwin' : process.platform
  const makeStore = (
    safeStorage = fakeSafeStorage(),
    platform: NodeJS.Platform = HOST_PLATFORM
  ): PiKeyStore =>
    new PiKeyStore({
      userDataPath: dir,
      safeStorage,
      platform,
      now: () => new Date('2026-07-25T12:00:00.000Z')
    })

  it('reports an empty status before anything is stored', () => {
    const status = makeStore().getStatus()
    expect(status).toEqual({
      encryptionAvailable: true,
      configuredUpstreams: [],
      recordUnreadable: false
    })
  })

  it('stores, reloads and clears keys per upstream', () => {
    const store = makeStore()
    expect(store.setKey('deepseek', 'ds-key').ok).toBe(true)
    expect(store.setKey('zai', 'zai-key').ok).toBe(true)

    const status = store.getStatus()
    expect(status.configuredUpstreams).toEqual(['deepseek', 'zai'])
    expect(status.updatedAt).toBe('2026-07-25T12:00:00.000Z')

    const loaded = store.loadKeys()
    expect(loaded).toEqual({ status: 'ok', keys: { deepseek: 'ds-key', zai: 'zai-key' } })

    expect(store.clearKey('deepseek').ok).toBe(true)
    expect(store.getStatus().configuredUpstreams).toEqual(['zai'])
    // Clearing the last key removes the record entirely.
    expect(store.clearKey('zai').ok).toBe(true)
    expect(store.loadKeys()).toEqual({ status: 'missing' })
  })

  it('refuses upstreams outside the policy allowlist', () => {
    const store = makeStore()
    for (const upstream of ['anthropic', 'openai', 'xai', '', 'DEEPSEEK']) {
      const result = store.setKey(upstream, 'k')
      expect(result.ok, upstream).toBe(false)
      expect(result.error).toBe('invalidUpstream')
    }
    expect(store.getStatus().configuredUpstreams).toEqual([])
  })

  it('stores an OpenRouter key through the same encrypted upstream store', () => {
    const store = makeStore()

    expect(store.setKey('openrouter', 'or-key').ok).toBe(true)
    expect(store.getStatus().configuredUpstreams).toEqual(['openrouter'])
    expect(store.loadKeys()).toEqual({ status: 'ok', keys: { openrouter: 'or-key' } })
  })

  it('refuses blank and oversized keys', () => {
    const store = makeStore()
    expect(store.setKey('deepseek', '   ').error).toBe('invalidApiKey')
    expect(store.setKey('deepseek', 'x'.repeat(4_097)).error).toBe('invalidApiKey')
  })

  it('writes the envelope 0600 with no plaintext key on disk', () => {
    const store = makeStore()
    store.setKey('groq', 'super-secret-value')
    const path = join(dir, PI_PROVIDER_KEYS_FILENAME)
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('super-secret-value')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('reports an unreadable record and refuses writes until clearAll', () => {
    const store = makeStore()
    store.setKey('deepseek', 'ds-key')
    writeFileSync(join(dir, PI_PROVIDER_KEYS_FILENAME), '{"not":"an envelope"}\n', 'utf8')

    const status = store.getStatus()
    expect(status.recordUnreadable).toBe(true)
    expect(status.configuredUpstreams).toEqual([])

    const blocked = store.setKey('zai', 'zai-key')
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toBe('existingRecordUnreadable')

    expect(store.clearAll().ok).toBe(true)
    expect(store.setKey('zai', 'zai-key').ok).toBe(true)
  })

  it('fails closed when encryption is unavailable', () => {
    const store = makeStore(fakeSafeStorage({ isEncryptionAvailable: () => false }))
    const result = store.setKey('deepseek', 'ds-key')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('encryptionUnavailable')
    expect(store.loadKeys()).toEqual({ status: 'encryptionUnavailable' })
  })

  it('drops payload entries for upstreams outside the allowlist on read', () => {
    const safeStorage = fakeSafeStorage()
    const store = makeStore(safeStorage)
    // Hand-craft an envelope whose payload smuggles a hosted-provider key.
    const payload = JSON.stringify({
      schemaVersion: 1,
      purpose: 'taskwraith:pi-provider-keys:v1',
      keys: { deepseek: 'ds-key', anthropic: 'sk-ant-smuggled' }
    })
    const envelope = {
      schemaVersion: 1,
      purpose: 'taskwraith:pi-provider-keys-envelope:v1',
      updatedAt: '2026-07-25T12:00:00.000Z',
      encryptedPayload: safeStorage.encryptString(payload).toString('base64')
    }
    writeFileSync(join(dir, PI_PROVIDER_KEYS_FILENAME), JSON.stringify(envelope) + '\n', 'utf8')
    // A non-allowlisted key in the payload invalidates the whole record rather
    // than silently loading the allowed half.
    expect(store.loadKeys()).toEqual({ status: 'corrupt' })
  })

  it('rejects a decryptable payload with the wrong purpose', () => {
    const safeStorage = fakeSafeStorage()
    const store = makeStore(safeStorage)
    const payload = JSON.stringify({
      schemaVersion: 1,
      purpose: 'taskwraith:antigravity-gemini-api-key:v1',
      keys: { deepseek: 'ds-key' }
    })
    const envelope = {
      schemaVersion: 1,
      purpose: 'taskwraith:pi-provider-keys-envelope:v1',
      updatedAt: '2026-07-25T12:00:00.000Z',
      encryptedPayload: safeStorage.encryptString(payload).toString('base64')
    }
    writeFileSync(join(dir, PI_PROVIDER_KEYS_FILENAME), JSON.stringify(envelope) + '\n', 'utf8')
    expect(store.loadKeys()).toEqual({ status: 'corrupt' })
  })

  describe('Linux storage backend', () => {
    // These were previously untested in both directions: the gate only ever ran
    // when CI happened to be Linux, and there it made every other case fail for
    // an unrelated reason rather than proving anything about the gate itself.
    const linuxStore = (backend?: string): PiKeyStore =>
      makeStore(
        fakeSafeStorage({ getSelectedStorageBackend: backend ? () => backend : undefined }),
        'linux'
      )

    it('accepts a real keyring backend', () => {
      for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
        expect(linuxStore(backend).getStatus().encryptionAvailable, backend).toBe(true)
      }
    })

    it('fails closed on a plaintext backend rather than storing a key in the clear', () => {
      // `basic_text` is safeStorage's unencrypted fallback. Reporting encryption
      // as available here would persist provider API keys in readable form.
      const store = linuxStore('basic_text')
      expect(store.getStatus().encryptionAvailable).toBe(false)
      expect(store.loadKeys()).toEqual({ status: 'encryptionUnavailable' })
      const result = store.setKey('deepseek', 'ds-key')
      expect(result.ok).toBe(false)
      expect(result.error).toBe('encryptionUnavailable')
    })

    it('fails closed when the backend cannot be determined at all', () => {
      expect(linuxStore().getStatus().encryptionAvailable).toBe(false)
    })

    it('does not impose the backend requirement off Linux', () => {
      // macOS Keychain and Windows DPAPI expose no backend selector; requiring
      // one there would disable the store on both.
      expect(makeStore(fakeSafeStorage(), 'darwin').getStatus().encryptionAvailable).toBe(true)
      expect(makeStore(fakeSafeStorage(), 'win32').getStatus().encryptionAvailable).toBe(true)
    })
  })
})
