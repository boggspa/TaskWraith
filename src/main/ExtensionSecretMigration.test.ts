import { describe, expect, it, vi } from 'vitest'
import type { ExtensionSecretRef } from './ExtensionSecretStore'
import {
  migrateRuntimeProfilePlaintextSecrets,
  migrateUserMcpServerPlaintextSecrets
} from './ExtensionSecretMigration'

describe('ExtensionSecretMigration', () => {
  it('moves likely user MCP plaintext secrets into refs and preserves non-secrets', () => {
    const setSecret = vi.fn(() => ({ ok: true }))

    const result = migrateUserMcpServerPlaintextSecrets(
      [
        {
          id: 'github',
          name: 'GitHub',
          env: {
            GITHUB_TOKEN: 'ghp_plaintext',
            LOG_LEVEL: 'debug'
          },
          headers: {
            Authorization: 'Bearer plaintext',
            'X-Trace': 'keep'
          }
        }
      ],
      setSecret
    )

    expect(result).toMatchObject({ changed: true, migrated: 2, failed: 0 })
    expect(result.value).toEqual([
      {
        id: 'github',
        name: 'GitHub',
        env: { LOG_LEVEL: 'debug' },
        headers: { 'X-Trace': 'keep' },
        secretRefs: {
          env: ['GITHUB_TOKEN'],
          headers: ['Authorization']
        }
      }
    ])
    expect(setSecret).toHaveBeenCalledWith(
      {
        ownerKind: 'userMcpServer',
        ownerId: 'github',
        fieldKind: 'env',
        fieldName: 'GITHUB_TOKEN'
      },
      'ghp_plaintext'
    )
  })

  it('keeps plaintext in place when encrypted storage rejects a value', () => {
    const setSecret = vi.fn((ref: ExtensionSecretRef) => ({
      ok: ref.fieldName !== 'Authorization'
    }))

    const result = migrateUserMcpServerPlaintextSecrets(
      [
        {
          id: 'mixed',
          name: 'Mixed',
          env: { API_TOKEN: 'api-secret' },
          headers: { Authorization: 'Bearer header-secret' }
        }
      ],
      setSecret
    )

    expect(result).toMatchObject({ changed: true, migrated: 1, failed: 1 })
    expect(result.value).toEqual([
      {
        id: 'mixed',
        name: 'Mixed',
        headers: { Authorization: 'Bearer header-secret' },
        secretRefs: { env: ['API_TOKEN'] }
      }
    ])
  })

  it('migrates runtime profile env secrets and leaves env references visible', () => {
    const setSecret = vi.fn(() => ({ ok: true }))

    const result = migrateRuntimeProfilePlaintextSecrets(
      [
        {
          id: 'profile-1',
          name: 'Profile',
          env: {
            OPENAI_API_KEY: 'sk-plaintext',
            ANTHROPIC_API_KEY: '$ANTHROPIC_API_KEY',
            DEBUG: '1'
          }
        }
      ],
      setSecret
    )

    expect(result).toMatchObject({ changed: true, migrated: 1, failed: 0 })
    expect(result.value).toEqual([
      {
        id: 'profile-1',
        name: 'Profile',
        env: {
          ANTHROPIC_API_KEY: '$ANTHROPIC_API_KEY',
          DEBUG: '1'
        },
        secretRefs: { env: ['OPENAI_API_KEY'] }
      }
    ])
  })
})
