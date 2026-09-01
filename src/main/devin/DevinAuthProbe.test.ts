import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeDevinCredentialState } from './DevinAuthProbe'

describe('probeDevinCredentialState', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devin-auth-probe-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const absent = () => ({ credentialsPath: join(dir, 'missing', 'credentials.toml') })

  it('reports an ambient WINDSURF_API_KEY as the env-key lane', () => {
    expect(
      probeDevinCredentialState({
        env: { PATH: '/usr/bin', WINDSURF_API_KEY: 'sk-live' },
        ambientApiKeyAllowed: true,
        credentialStoreOptions: absent()
      })
    ).toEqual({ credentialPresent: true, authSource: 'env-key', authState: 'windsurf-api-key' })
  })

  it('accepts the DEVIN_API_KEY alias on the same lane', () => {
    expect(
      probeDevinCredentialState({
        env: { DEVIN_API_KEY: 'sk-alias' },
        ambientApiKeyAllowed: true,
        credentialStoreOptions: absent()
      })
    ).toMatchObject({ credentialPresent: true, authSource: 'env-key' })
  })

  it('ignores an ambient key when the BYOK gate is off and nothing is stored', () => {
    expect(
      probeDevinCredentialState({
        env: { WINDSURF_API_KEY: 'sk-live' },
        ambientApiKeyAllowed: false,
        credentialStoreOptions: absent()
      })
    ).toEqual({ credentialPresent: false, authSource: null, authState: 'missing' })
  })

  it('reports the credentials.toml written by `devin auth login` as the stored lane', () => {
    const credentialsPath = join(dir, 'credentials.toml')
    writeFileSync(
      credentialsPath,
      'windsurf_api_key = "sk-stored"\napi_server_url = "https://api.example.test"\n'
    )
    expect(
      probeDevinCredentialState({
        env: { PATH: '/usr/bin' },
        ambientApiKeyAllowed: true,
        credentialStoreOptions: { credentialsPath }
      })
    ).toEqual({ credentialPresent: true, authSource: 'stored-toml', authState: 'authenticated' })
  })

  it('is missing when neither lane holds a credential', () => {
    expect(
      probeDevinCredentialState({
        env: { PATH: '/usr/bin' },
        ambientApiKeyAllowed: true,
        credentialStoreOptions: absent()
      })
    ).toEqual({ credentialPresent: false, authSource: null, authState: 'missing' })
  })

  it('never throws on an unreadable credentials path', () => {
    expect(() =>
      probeDevinCredentialState({
        env: {},
        ambientApiKeyAllowed: true,
        // A directory, not a file: readFileSync fails and the store must swallow it.
        credentialStoreOptions: { credentialsPath: dir }
      })
    ).not.toThrow()
  })
})
