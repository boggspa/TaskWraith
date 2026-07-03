import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ExtensionSecretStore,
  extensionSecretKey,
  type ExtensionSecretRef,
  type ExtensionSecretSafeStorage
} from './ExtensionSecretStore'

let tmpDir = ''

const safeStorage: ExtensionSecretSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf-8'),
  decryptString: (encrypted) => encrypted.toString('utf-8').replace(/^enc:/, '')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-extension-secrets-'))
})

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = ''
})

function makeStore(storage: ExtensionSecretSafeStorage = safeStorage): ExtensionSecretStore {
  return new ExtensionSecretStore({
    userDataPath: tmpDir,
    safeStorage: storage,
    now: () => new Date('2026-07-03T12:00:00.000Z')
  })
}

function secretsPath(): string {
  return path.join(tmpDir, 'extension-secrets.json')
}

function encryptedPayload(ref: ExtensionSecretRef, value: string): string {
  return Buffer.from(
    `enc:${JSON.stringify({
      schemaVersion: 1,
      ref,
      value
    })}`,
    'utf-8'
  ).toString('base64')
}

describe('ExtensionSecretStore', () => {
  it('reports status without exposing values', () => {
    const store = makeStore()

    const snapshot = store.getSecretStatusSnapshot()

    expect(snapshot).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-07-03T12:00:00.000Z',
      encryptionAvailable: true,
      secrets: []
    })
    expect(JSON.stringify(snapshot)).not.toContain('super-secret')
  })

  it('stores encrypted user MCP header values at rest and decrypts on main-process demand', () => {
    const store = makeStore()
    const ref = {
      ownerKind: 'userMcpServer' as const,
      ownerId: 'github-mcp',
      fieldKind: 'header' as const,
      fieldName: 'Authorization'
    }

    const result = store.setSecret(ref, 'Bearer super-secret-token')

    expect(result.ok).toBe(true)
    expect(result.snapshot.secrets).toEqual([
      {
        ...ref,
        configured: true,
        updatedAt: '2026-07-03T12:00:00.000Z'
      }
    ])
    expect(JSON.stringify(result)).not.toContain('super-secret-token')
    const stored = fs.readFileSync(secretsPath(), 'utf-8')
    expect(stored).not.toContain('super-secret-token')
    expect(store.loadSecretValue(ref)).toBe('Bearer super-secret-token')
  })

  it('refuses to write when safeStorage encryption is unavailable', () => {
    const store = makeStore({
      ...safeStorage,
      isEncryptionAvailable: () => false
    })

    const result = store.setSecret(
      {
        ownerKind: 'runtimeProfile',
        ownerId: 'codex-default',
        fieldKind: 'env',
        fieldName: 'OPENAI_API_KEY'
      },
      'sk-secret'
    )

    expect(result).toMatchObject({
      ok: false,
      error: 'OS keychain encryption is unavailable; cannot store extension secrets.'
    })
    expect(fs.existsSync(secretsPath())).toBe(false)
  })

  it('clears only the selected secret across runtime profile env and user MCP header records', () => {
    const store = makeStore()
    const runtimeEnv = {
      ownerKind: 'runtimeProfile' as const,
      ownerId: 'codex-default',
      fieldKind: 'env' as const,
      fieldName: 'OPENAI_API_KEY'
    }
    const mcpHeader = {
      ownerKind: 'userMcpServer' as const,
      ownerId: 'github-mcp',
      fieldKind: 'header' as const,
      fieldName: 'Authorization'
    }

    expect(store.setSecret(runtimeEnv, 'sk-runtime-secret').ok).toBe(true)
    expect(store.setSecret(mcpHeader, 'Bearer mcp-secret').ok).toBe(true)

    expect(store.clearSecret(runtimeEnv).ok).toBe(true)
    expect(store.loadSecretValue(runtimeEnv)).toBeNull()
    expect(store.loadSecretValue(mcpHeader)).toBe('Bearer mcp-secret')
    expect(store.getSecretStatusSnapshot().secrets).toEqual([
      {
        ...mcpHeader,
        configured: true,
        updatedAt: '2026-07-03T12:00:00.000Z'
      }
    ])

    expect(store.clearOwnerSecrets('userMcpServer', 'github-mcp')).toBe(1)
    expect(store.loadSecretValue(mcpHeader)).toBeNull()
  })

  it('normalizes malformed records away and ignores non-canonical keys', () => {
    const goodRef = {
      ownerKind: 'runtimeProfile' as const,
      ownerId: 'codex default',
      fieldKind: 'env' as const,
      fieldName: 'ANTHROPIC_API_KEY'
    }
    fs.writeFileSync(
      secretsPath(),
      JSON.stringify(
        {
          schemaVersion: 1,
          secrets: {
            'wrong:key': {
              ...goodRef,
              encryptedValue: encryptedPayload(goodRef, 'wrong-key-secret'),
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z'
            },
            [extensionSecretKey(goodRef)]: {
              ...goodRef,
              encryptedValue: encryptedPayload(goodRef, 'canonical-secret'),
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-02T00:00:00.000Z'
            },
            missingEncryptedValue: {
              ...goodRef,
              encryptedValue: '',
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z'
            },
            invalidOwner: {
              ownerKind: 'workspace',
              ownerId: 'x',
              fieldKind: 'env',
              fieldName: 'TOKEN',
              encryptedValue: Buffer.from('enc:nope').toString('base64')
            }
          }
        },
        null,
        2
      )
    )

    const store = makeStore()

    expect(store.getSecretStatusSnapshot().secrets).toEqual([
      {
        ...goodRef,
        configured: true,
        updatedAt: '2026-07-02T00:00:00.000Z'
      }
    ])
    expect(store.loadSecretValue(goodRef)).toBe('canonical-secret')
  })

  it('rejects unsupported ref shapes and invalid field names', () => {
    const store = makeStore()

    expect(
      store.setSecret(
        {
          ownerKind: 'runtimeProfile',
          ownerId: 'codex-default',
          fieldKind: 'header',
          fieldName: 'Authorization'
        },
        'secret'
      ).ok
    ).toBe(false)
    expect(
      store.setSecret(
        {
          ownerKind: 'userMcpServer',
          ownerId: 'docs',
          fieldKind: 'env',
          fieldName: 'bad-name'
        },
        'secret'
      ).ok
    ).toBe(false)
    expect(
      store.setSecret(
        {
          ownerKind: 'userMcpServer',
          ownerId: 'docs',
          fieldKind: 'header',
          fieldName: 'bad header'
        },
        'secret'
      ).ok
    ).toBe(false)
    expect(fs.existsSync(secretsPath())).toBe(false)
  })

  it('resolves explicit per-ref statuses for launch-time callers', () => {
    const store = makeStore()
    const present = {
      ownerKind: 'runtimeProfile' as const,
      ownerId: 'codex-default',
      fieldKind: 'env' as const,
      fieldName: 'OPENAI_API_KEY'
    }
    const missing = {
      ownerKind: 'runtimeProfile' as const,
      ownerId: 'codex-default',
      fieldKind: 'env' as const,
      fieldName: 'ANTHROPIC_API_KEY'
    }
    const invalid = {
      ownerKind: 'runtimeProfile' as const,
      ownerId: 'codex-default',
      fieldKind: 'header' as const,
      fieldName: 'Authorization'
    }

    store.setSecret(present, 'sk-present')

    expect(store.resolveSecretValues([present, missing, invalid])).toEqual([
      { ref: present, status: 'ok', value: 'sk-present' },
      { ref: missing, status: 'missing' },
      { ref: null, status: 'invalidRef' }
    ])

    const unavailable = makeStore({ ...safeStorage, isEncryptionAvailable: () => false })
    expect(unavailable.resolveSecretValues([present])).toEqual([
      { ref: present, status: 'encryptionUnavailable' }
    ])
  })

  it('does not decrypt ciphertext bound to another logical secret ref', () => {
    const intended = {
      ownerKind: 'userMcpServer' as const,
      ownerId: 'docs',
      fieldKind: 'header' as const,
      fieldName: 'Authorization'
    }
    const other = {
      ownerKind: 'userMcpServer' as const,
      ownerId: 'other',
      fieldKind: 'header' as const,
      fieldName: 'Authorization'
    }
    fs.writeFileSync(
      secretsPath(),
      JSON.stringify(
        {
          schemaVersion: 1,
          secrets: {
            [extensionSecretKey(intended)]: {
              ...intended,
              encryptedValue: encryptedPayload(other, 'wrong-secret'),
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z'
            }
          }
        },
        null,
        2
      )
    )

    const store = makeStore()

    expect(store.resolveSecretValues([intended])).toEqual([
      { ref: intended, status: 'decryptFailed' }
    ])
    expect(store.loadSecretValue(intended)).toBeNull()
  })
})
