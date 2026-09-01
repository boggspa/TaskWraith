import { describe, expect, it, vi } from 'vitest'
import {
  isMuseBinaryResolvable,
  isMuseConfiguredForAdmission,
  isMuseCredentialPresent,
  museAuthJsonUsesKeychainStorage,
  museCredentialFromEnv,
  parseMuseAuthJsonCredential,
  parseMuseHelp,
  parseMuseVersion,
  probeMuseCli
} from './MuseProbe'

describe('MuseProbe', () => {
  describe('parseMuseVersion', () => {
    it('extracts the parenthetical Muse Code build id', () => {
      expect(parseMuseVersion('Muse Code 0.1.0 (0.1.0-R708.1)')).toBe('0.1.0-R708.1')
    })

    it('falls back to the first semver token', () => {
      expect(parseMuseVersion('muse 0.1.0')).toBe('0.1.0')
    })

    it('returns null for junk', () => {
      expect(parseMuseVersion('')).toBeNull()
      expect(parseMuseVersion('unknown')).toBeNull()
    })
  })

  describe('parseMuseAuthJsonCredential', () => {
    it('accepts meta api_key without retaining the secret', () => {
      const evidence = parseMuseAuthJsonCredential(
        JSON.stringify({
          schema_version: 1,
          providers: { meta: { api_key: 'x'.repeat(48) } }
        })
      )
      expect(evidence).toEqual({
        present: true,
        source: 'auth-json-meta',
        credentialKind: 'api-key',
        apiKeyLength: 48
      })
    })

    it('accepts the OAuth credential written by muse login without retaining its tokens', () => {
      const evidence = parseMuseAuthJsonCredential(
        JSON.stringify({
          schema_version: 1,
          providers: {
            meta: {
              mechanism: 'oauth',
              access_token: 'oauth-access-secret',
              refresh_token: 'oauth-refresh-secret',
              expires_at: 1_900_000_000
            }
          }
        })
      )

      expect(evidence).toEqual({
        present: true,
        source: 'auth-json-meta',
        credentialKind: 'oauth',
        apiKeyLength: null
      })
      expect(JSON.stringify(evidence)).not.toContain('oauth-access-secret')
      expect(JSON.stringify(evidence)).not.toContain('oauth-refresh-secret')
    })

    it('accepts Muse schema-v2 OAuth keychain metadata without requiring an inline token', () => {
      expect(
        parseMuseAuthJsonCredential(
          JSON.stringify({
            schema_version: 2,
            providers: {
              meta: {
                mechanism: 'oauth',
                storage: 'keychain',
                obtained_via: 'device_code'
              }
            }
          })
        )
      ).toEqual({
        present: true,
        source: 'auth-json-meta',
        credentialKind: 'oauth',
        apiKeyLength: null
      })
    })

    it.each([
      ['missing schema version', undefined, 'oauth', 'keychain'],
      ['older schema version', 1, 'oauth', 'keychain'],
      ['string schema version', '2', 'oauth', 'keychain'],
      ['unknown newer schema version', 3, 'oauth', 'keychain'],
      ['missing storage', 2, 'oauth', undefined],
      ['wrong storage', 2, 'oauth', 'file'],
      ['wrong mechanism', 2, 'api-key', 'keychain']
    ])(
      'rejects incomplete schema-v2 keychain metadata: %s',
      (_label, schema, mechanism, storage) => {
        expect(
          parseMuseAuthJsonCredential(
            JSON.stringify({
              ...(schema === undefined ? {} : { schema_version: schema }),
              providers: {
                meta: {
                  mechanism,
                  ...(storage === undefined ? {} : { storage })
                }
              }
            })
          ).present
        ).toBe(false)
      }
    )

    it('rejects empty or malformed auth.json', () => {
      expect(parseMuseAuthJsonCredential(null).present).toBe(false)
      expect(parseMuseAuthJsonCredential('{').present).toBe(false)
      expect(
        parseMuseAuthJsonCredential(JSON.stringify({ providers: { meta: { api_key: '' } } }))
          .present
      ).toBe(false)
      expect(
        parseMuseAuthJsonCredential(
          JSON.stringify({ providers: { meta: { mechanism: 'oauth', access_token: '' } } })
        ).present
      ).toBe(false)
    })
  })

  describe('museAuthJsonUsesKeychainStorage', () => {
    it('recognizes the schema-v2 keychain locator written by subscription-era muse login', () => {
      expect(
        museAuthJsonUsesKeychainStorage(
          JSON.stringify({
            schema_version: 2,
            providers: {
              meta: {
                mechanism: 'oauth',
                storage: 'keychain',
                obtained_via: 'device_code'
              }
            }
          })
        )
      ).toBe(true)
    })

    it('is false for inline api_key and inline oauth token documents', () => {
      expect(
        museAuthJsonUsesKeychainStorage(
          JSON.stringify({ schema_version: 1, providers: { meta: { api_key: 'k'.repeat(32) } } })
        )
      ).toBe(false)
      expect(
        museAuthJsonUsesKeychainStorage(
          JSON.stringify({
            schema_version: 1,
            providers: { meta: { mechanism: 'oauth', access_token: 'inline-token' } }
          })
        )
      ).toBe(false)
      // An inline api_key wins even when keychain markers are also present,
      // mirroring parseMuseAuthJsonCredential branch order.
      expect(
        museAuthJsonUsesKeychainStorage(
          JSON.stringify({
            schema_version: 2,
            providers: {
              meta: { api_key: 'k'.repeat(32), mechanism: 'oauth', storage: 'keychain' }
            }
          })
        )
      ).toBe(false)
    })

    it('is false for malformed, empty, or non-v2 documents', () => {
      expect(museAuthJsonUsesKeychainStorage(null)).toBe(false)
      expect(museAuthJsonUsesKeychainStorage('')).toBe(false)
      expect(museAuthJsonUsesKeychainStorage('{')).toBe(false)
      expect(
        museAuthJsonUsesKeychainStorage(
          JSON.stringify({
            schema_version: 3,
            providers: { meta: { mechanism: 'oauth', storage: 'keychain' } }
          })
        )
      ).toBe(false)
      expect(
        museAuthJsonUsesKeychainStorage(
          JSON.stringify({
            schema_version: 2,
            providers: { meta: { mechanism: 'oauth', storage: 'file' } }
          })
        )
      ).toBe(false)
    })
  })

  describe('museCredentialFromEnv', () => {
    it('treats non-empty META_API_KEY as present', () => {
      expect(museCredentialFromEnv('abc').present).toBe(true)
      expect(museCredentialFromEnv('').present).toBe(false)
      expect(museCredentialFromEnv(undefined).present).toBe(false)
    })
  })

  describe('parseMuseHelp', () => {
    it('extracts flags and subcommands from a Commands block', () => {
      const help = parseMuseHelp(`Usage: muse [options] [command]

Options:
  --version   Show version
  -h, --help  Display help

Commands:
  exec        Run a headless turn
  login       Authenticate
  skills      Manage skills
`)
      expect(help.flags).toContain('--version')
      expect(help.flags).toContain('--help')
      expect(help.subcommands).toEqual(['exec', 'login', 'skills'])
    })
  })

  describe('admission helpers (pi-shaped)', () => {
    it('requires binary AND credential for configured=true', async () => {
      const deps = {
        resolveBinary: vi.fn(async () => ({ binaryPath: '/tmp/muse', source: 'path' })),
        readAuthJsonText: vi.fn(async () =>
          JSON.stringify({ providers: { meta: { api_key: 'k'.repeat(16) } } })
        )
      }
      await expect(isMuseBinaryResolvable(deps)).resolves.toBe(true)
      await expect(isMuseCredentialPresent(deps)).resolves.toBe(true)
      await expect(isMuseConfiguredForAdmission(deps)).resolves.toBe(true)
    })

    it('fails closed when binary is missing even with credentials', async () => {
      const deps = {
        resolveBinary: vi.fn(async () => ({ binaryPath: null, error: 'not found' })),
        readMetaApiKeyEnv: () => 'present'
      }
      await expect(isMuseConfiguredForAdmission(deps)).resolves.toBe(false)
    })

    it('fails closed when credential is missing even with binary', async () => {
      const deps = {
        resolveBinary: vi.fn(async () => ({ binaryPath: '/tmp/muse' })),
        readAuthJsonText: vi.fn(async () => null),
        readMetaApiKeyEnv: () => null
      }
      await expect(isMuseConfiguredForAdmission(deps)).resolves.toBe(false)
    })

    it('accepts injected credential without reading auth.json', async () => {
      const deps = {
        resolveBinary: vi.fn(async () => ({ binaryPath: '/tmp/muse' })),
        hasInjectedCredential: vi.fn(async () => true),
        readAuthJsonText: vi.fn(async () => {
          throw new Error('should not read auth.json when injected')
        })
      }
      await expect(isMuseCredentialPresent(deps)).resolves.toBe(true)
      expect(deps.readAuthJsonText).not.toHaveBeenCalled()
    })
  })

  describe('probeMuseCli', () => {
    it('aggregates binary, credential, version, and help inventory', async () => {
      const findings = await probeMuseCli({
        resolveBinary: async () => ({ binaryPath: '/bin/muse', source: 'path' }),
        readAuthJsonText: async () =>
          JSON.stringify({ providers: { meta: { api_key: 'secret-key' } } }),
        capture: async (_cmd, args) => {
          if (args.includes('--version')) {
            return {
              stdout: 'Muse Code 0.1.0 (0.1.0-R708.1)\n',
              stderr: '',
              code: 0
            }
          }
          return {
            stdout: `Usage: muse

Options:
  --help

Commands:
  exec   Run
`,
            stderr: '',
            code: 0
          }
        }
      })
      expect(findings.binaryResolvable).toBe(true)
      expect(findings.credentialPresent).toBe(true)
      expect(findings.configured).toBe(true)
      expect(findings.version).toBe('0.1.0-R708.1')
      expect(findings.subcommands).toContain('exec')
      expect(findings.errors).toEqual([])
    })
  })
})
