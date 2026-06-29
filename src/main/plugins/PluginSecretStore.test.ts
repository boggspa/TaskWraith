import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginHost } from './PluginHost'
import { PluginSecretStore, type PluginSecretSafeStorage } from './PluginSecretStore'
import type { TaskWraithPluginManifest } from './PluginManifest'

const SECRET_MANIFEST: TaskWraithPluginManifest = {
  schemaVersion: 1,
  id: 'secret-bundle',
  publisher: 'acme',
  name: 'Secret Bundle',
  version: '1.0.0',
  description: 'A declarative bundle with a secret slot.',
  capabilities: [
    {
      kind: 'connectors',
      id: 'github-connector',
      label: 'GitHub connector'
    }
  ],
  secrets: [
    {
      id: 'github-token',
      label: 'GitHub token',
      envVar: 'GITHUB_TOKEN',
      required: true,
      description: 'Token used by materialized connector bindings.'
    }
  ]
}

let tmpDir = ''

const safeStorage: PluginSecretSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf-8'),
  decryptString: (encrypted) => encrypted.toString('utf-8').replace(/^enc:/, '')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-plugin-secrets-'))
})

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = ''
})

function makeHost(): PluginHost {
  return new PluginHost({
    userDataPath: tmpDir,
    builtInManifests: [SECRET_MANIFEST],
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    platform: 'darwin',
    env: {}
  })
}

function makeStore(storage: PluginSecretSafeStorage = safeStorage): PluginSecretStore {
  return new PluginSecretStore({
    userDataPath: tmpDir,
    safeStorage: storage,
    now: () => new Date('2026-06-29T12:00:00.000Z')
  })
}

describe('PluginSecretStore', () => {
  it('reports declared secret slots without exposing values', () => {
    const host = makeHost()
    const store = makeStore()
    const snapshot = store.getSecretStatusSnapshot(host.getCatalogSnapshot())

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      encryptionAvailable: true,
      secrets: [
        {
          pluginId: 'secret-bundle',
          secretId: 'github-token',
          label: 'GitHub token',
          required: true,
          configured: false,
          installed: false,
          enabled: false,
          envVar: 'GITHUB_TOKEN'
        }
      ]
    })
    expect(JSON.stringify(snapshot)).not.toContain('super-secret')
  })

  it('encrypts secret values at rest and only returns status to the renderer', () => {
    const host = makeHost()
    host.installPlugin('secret-bundle')
    const store = makeStore()

    const result = store.setSecret(
      host.getCatalogSnapshot(),
      'secret-bundle',
      'github-token',
      'super-secret-token'
    )

    expect(result.ok).toBe(true)
    expect(result.snapshot?.secrets[0]).toMatchObject({
      configured: true,
      updatedAt: '2026-06-29T12:00:00.000Z'
    })
    expect(JSON.stringify(result)).not.toContain('super-secret-token')
    const stored = fs.readFileSync(path.join(tmpDir, 'plugins', 'plugin-secrets.json'), 'utf-8')
    expect(stored).not.toContain('super-secret-token')
    expect(store.loadSecretValue('secret-bundle', 'github-token')).toBe('super-secret-token')
  })

  it('refuses to store a secret when safeStorage is unavailable', () => {
    const host = makeHost()
    host.installPlugin('secret-bundle')
    const store = makeStore({
      ...safeStorage,
      isEncryptionAvailable: () => false
    })

    const result = store.setSecret(
      host.getCatalogSnapshot(),
      'secret-bundle',
      'github-token',
      'super-secret-token'
    )

    expect(result).toMatchObject({
      ok: false,
      error: 'OS keychain encryption is unavailable; cannot store plugin secrets.'
    })
    expect(fs.existsSync(path.join(tmpDir, 'plugins', 'plugin-secrets.json'))).toBe(false)
  })

  it('clears individual and plugin-wide secret records', () => {
    const host = makeHost()
    host.installPlugin('secret-bundle')
    const store = makeStore()

    store.setSecret(host.getCatalogSnapshot(), 'secret-bundle', 'github-token', 'super-secret-token')
    expect(store.loadSecretValue('secret-bundle', 'github-token')).toBe('super-secret-token')

    expect(store.clearSecret(host.getCatalogSnapshot(), 'secret-bundle', 'github-token').ok).toBe(
      true
    )
    expect(store.loadSecretValue('secret-bundle', 'github-token')).toBeNull()

    store.setSecret(host.getCatalogSnapshot(), 'secret-bundle', 'github-token', 'super-secret-token')
    expect(store.clearPluginSecrets('secret-bundle')).toBe(1)
    expect(store.loadSecretValue('secret-bundle', 'github-token')).toBeNull()
  })
})
