import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  API_USAGE_KEY_IDENTITIES,
  API_USAGE_KEY_PROVIDER_IDS,
  ApiUsageKeyStore,
  isApiUsageKeyProviderId,
  type ApiUsageKeyProviderId,
  type ApiUsageKeySafeStorage
} from './ApiUsageKeyStore'
import { MISTRAL_ADMIN_KEY_FILENAME } from '../mistral/MistralAdminKeyStore'

function fakeSafeStorage(overrides: Partial<ApiUsageKeySafeStorage> = {}): ApiUsageKeySafeStorage {
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

describe('ApiUsageKeyStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-api-usage-key-'))
  })
  afterEach(() => {
    // mkdtemp-only removal: `dir` is always the fresh temp directory above.
    rmSync(dir, { recursive: true, force: true })
  })

  // Linux demands an encrypted safeStorage backend; substitute darwin only
  // where that gate would fire, run as the real host everywhere else.
  const HOST_PLATFORM: NodeJS.Platform = process.platform === 'linux' ? 'darwin' : process.platform

  function store(
    provider: ApiUsageKeyProviderId = 'anthropic',
    safeStorage = fakeSafeStorage(),
    platform: NodeJS.Platform = HOST_PLATFORM
  ): ApiUsageKeyStore {
    return new ApiUsageKeyStore({
      provider,
      userDataPath: dir,
      safeStorage,
      platform,
      now: () => new Date('2026-10-08T01:00:00.000Z')
    })
  }

  it('keeps the two identities distinct from each other and from the Mistral admin store', () => {
    const filenames = API_USAGE_KEY_PROVIDER_IDS.map((p) => API_USAGE_KEY_IDENTITIES[p].filename)
    const purposes = API_USAGE_KEY_PROVIDER_IDS.flatMap((p) => [
      API_USAGE_KEY_IDENTITIES[p].secretPurpose,
      API_USAGE_KEY_IDENTITIES[p].envelopePurpose
    ])
    expect(new Set(filenames).size).toBe(filenames.length)
    expect(new Set(purposes).size).toBe(purposes.length)
    expect(filenames).not.toContain(MISTRAL_ADMIN_KEY_FILENAME)
    expect(purposes).not.toContain('taskwraith:mistral-admin-api-key:v1')
    expect(isApiUsageKeyProviderId('anthropic')).toBe(true)
    expect(isApiUsageKeyProviderId('mistral')).toBe(false)
  })

  it('round-trips a key per provider without ever writing it in plaintext', () => {
    const anthropic = store('anthropic')
    const openai = store('openai')
    expect(anthropic.getStatus()).toEqual({ configured: false, encryptionAvailable: true })
    expect(anthropic.setApiKey('  sk-ant-admin01-abc  ').ok).toBe(true)
    expect(openai.setApiKey('sk-admin-xyz').ok).toBe(true)

    expect(anthropic.loadApiKey()).toEqual({ status: 'ok', value: 'sk-ant-admin01-abc' })
    expect(openai.loadApiKey()).toEqual({ status: 'ok', value: 'sk-admin-xyz' })
    expect(anthropic.getStatus()).toEqual({
      configured: true,
      encryptionAvailable: true,
      updatedAt: '2026-10-08T01:00:00.000Z'
    })

    for (const provider of API_USAGE_KEY_PROVIDER_IDS) {
      const path = join(dir, API_USAGE_KEY_IDENTITIES[provider].filename)
      const raw = readFileSync(path, 'utf8')
      expect(raw).not.toContain('sk-ant-admin01-abc')
      expect(raw).not.toContain('sk-admin-xyz')
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses a payload whose purpose belongs to the other provider', () => {
    // Write an Anthropic envelope under the OpenAI filename: the exact-purpose
    // check must reject it rather than hand one lane the other's key.
    store('anthropic').setApiKey('sk-ant-admin01-abc')
    const anthropicPath = join(dir, API_USAGE_KEY_IDENTITIES.anthropic.filename)
    const openaiPath = join(dir, API_USAGE_KEY_IDENTITIES.openai.filename)
    writeFileSync(openaiPath, readFileSync(anthropicPath), { mode: 0o600 })
    expect(store('openai').loadApiKey()).toEqual({ status: 'corrupt' })
    // Corrupt reports as configured so the UI never offers a silent overwrite.
    expect(store('openai').getStatus().configured).toBe(true)
    expect(store('openai').setApiKey('sk-new').error).toBe('existingRecordUnreadable')
    expect(store('openai').clear().ok).toBe(true)
    expect(store('openai').getStatus().configured).toBe(false)
  })

  it('rejects empty keys and fails closed without encryption', () => {
    expect(store().setApiKey('   ').error).toBe('invalidApiKey')
    const unencrypted = store('anthropic', fakeSafeStorage({ isEncryptionAvailable: () => false }))
    expect(unencrypted.setApiKey('sk-ant-admin01-abc').error).toBe('encryptionUnavailable')
    expect(unencrypted.loadApiKey()).toEqual({ status: 'encryptionUnavailable' })
  })

  it('reports decryptFailed when safeStorage cannot open the stored payload', () => {
    store().setApiKey('sk-ant-admin01-abc')
    const broken = store(
      'anthropic',
      fakeSafeStorage({
        decryptString: () => {
          throw new Error('keychain locked')
        }
      })
    )
    expect(broken.loadApiKey()).toEqual({ status: 'decryptFailed' })
  })
})
