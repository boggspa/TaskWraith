import { describe, expect, it, vi } from 'vitest'
import {
  isMuseBinaryResolvable,
  isMuseConfiguredForAdmission,
  isMuseCredentialPresent,
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
        apiKeyLength: 48
      })
    })

    it('rejects empty or malformed auth.json', () => {
      expect(parseMuseAuthJsonCredential(null).present).toBe(false)
      expect(parseMuseAuthJsonCredential('{').present).toBe(false)
      expect(
        parseMuseAuthJsonCredential(JSON.stringify({ providers: { meta: { api_key: '' } } }))
          .present
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
