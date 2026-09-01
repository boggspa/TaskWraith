import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { devinCredentialEnvScrubbed } from './DevinCliArgs'
import { resolveDevinCredentialLaunch } from './DevinCredentialLane'

// Every resolution below pins credentialStoreOptions.credentialsPath inside a
// private temp dir, so the developer's real ~/.local/share/devin is never read.
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devin-credential-lane-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A credentials.toml that does not exist. */
const missingStore = (): { credentialsPath: string } => ({
  credentialsPath: join(dir, 'missing', 'credentials.toml')
})

/** A credentials.toml shaped like the one `devin auth login` writes. */
const storedToml = (apiKey: string, apiServerUrl?: string): { credentialsPath: string } => {
  const credentialsPath = join(dir, 'credentials.toml')
  const lines = [`windsurf_api_key = "${apiKey}"`]
  if (apiServerUrl) lines.push(`api_server_url = "${apiServerUrl}"`)
  writeFileSync(credentialsPath, `${lines.join('\n')}\n`, 'utf8')
  return { credentialsPath }
}

describe('resolveDevinCredentialLaunch env-key lane', () => {
  it('normalizes an allowed ambient key into WINDSURF_API_KEY and scrubs the aliases', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        PATH: 'unrelated-path-entry',
        WINDSURF_API_KEY: 'wk-canonical',
        DEVIN_API_KEY: 'dk-alias',
        windsurf_api_key: 'lk-alias'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: missingStore()
    })

    expect(result).toMatchObject({
      lane: 'env-key',
      credentialEnvPresent: true,
      missingApiKey: false,
      settingsApiServerUrlRejected: false,
      apiServerUrl: null
    })
    expect(result.childEnv.WINDSURF_API_KEY).toBe('wk-canonical')
    expect(result.childEnv.DEVIN_API_KEY).toBeUndefined()
    expect(result.childEnv.windsurf_api_key).toBeUndefined()
    expect(result.childEnv.PATH).toBe('unrelated-path-entry')
    expect(Object.keys(result.childEnv).sort()).toEqual(['PATH', 'WINDSURF_API_KEY'])
  })

  it('promotes the DEVIN_API_KEY alias into the canonical var when it is the only key', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: { PATH: 'unrelated-path-entry', DEVIN_API_KEY: '  dk-only  ' },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: missingStore()
    })

    expect(result.lane).toBe('env-key')
    expect(result.childEnv.WINDSURF_API_KEY).toBe('dk-only')
    expect(result.childEnv.DEVIN_API_KEY).toBeUndefined()
  })

  it('admits an env key through storedApiKeyPresent even when the ambient lane is off', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: { PATH: 'unrelated-path-entry', WINDSURF_API_KEY: 'wk-stored' },
      storedApiKeyPresent: true,
      ambientApiKeyAllowed: false,
      credentialStoreOptions: missingStore()
    })

    expect(result).toMatchObject({ lane: 'env-key', missingApiKey: false })
    expect(result.childEnv.WINDSURF_API_KEY).toBe('wk-stored')
  })

  it('never leaks a disallowed ambient key into the child', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        PATH: 'unrelated-path-entry',
        WINDSURF_API_KEY: 'wk-ambient',
        DEVIN_API_KEY: 'dk-ambient',
        windsurf_api_key: 'lk-ambient'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: false,
      credentialStoreOptions: missingStore()
    })

    expect(result).toMatchObject({
      lane: 'none',
      missingApiKey: true,
      apiServerUrl: null,
      settingsApiServerUrlRejected: false
    })
    expect(Object.keys(result.childEnv)).toEqual(['PATH'])
    expect(devinCredentialEnvScrubbed(result.childEnv)).toBe(true)
  })

  it('fails closed when no key exists anywhere', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: { PATH: 'unrelated-path-entry', WINDSURF_API_KEY: '   ' },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: missingStore()
    })

    expect(result).toMatchObject({ lane: 'none', credentialEnvPresent: false, missingApiKey: true })
    expect(Object.keys(result.childEnv)).toEqual(['PATH'])
  })
})

describe('resolveDevinCredentialLaunch stored-toml lane', () => {
  it('injects the stored key and endpoint when no env key is present', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: { PATH: 'unrelated-path-entry' },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: storedToml('sk-stored', 'https://stored.devin.example/api')
    })

    expect(result).toMatchObject({
      lane: 'stored-toml',
      credentialEnvPresent: true,
      missingApiKey: false,
      settingsApiServerUrlRejected: false,
      apiServerUrl: 'https://stored.devin.example/api'
    })
    expect(result.childEnv.WINDSURF_API_KEY).toBe('sk-stored')
    expect(result.childEnv.WINDSURF_API_SERVER_URL).toBe('https://stored.devin.example/api')
    expect(result.childEnv.PATH).toBe('unrelated-path-entry')
  })

  it('is reached only after a disallowed ambient key is refused, which it scrubs', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        PATH: 'unrelated-path-entry',
        WINDSURF_API_KEY: 'wk-ambient',
        DEVIN_API_KEY: 'dk-ambient'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: false,
      credentialStoreOptions: storedToml('sk-stored')
    })

    expect(result.lane).toBe('stored-toml')
    expect(result.childEnv.WINDSURF_API_KEY).toBe('sk-stored')
    expect(result.childEnv.DEVIN_API_KEY).toBeUndefined()
    expect(result.apiServerUrl).toBeNull()
    expect('WINDSURF_API_SERVER_URL' in result.childEnv).toBe(false)
  })

  it('reports an invalid stored endpoint as null', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: { PATH: 'unrelated-path-entry' },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: storedToml('sk-stored', 'http://stored.devin.example')
    })

    expect(result.lane).toBe('stored-toml')
    expect(result.apiServerUrl).toBeNull()
  })
})

describe('resolveDevinCredentialLaunch endpoint precedence', () => {
  const envWithBothEndpoints = {
    PATH: 'unrelated-path-entry',
    WINDSURF_API_KEY: 'wk-canonical',
    WINDSURF_API_SERVER_URL: 'https://env.devin.example',
    DEVIN_API_SERVER_URL: 'https://alias.devin.example'
  }

  it('lets a valid settings URL win over both endpoint env vars', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: envWithBothEndpoints,
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      settingsApiServerUrl: 'https://settings.devin.example/base?x=1#frag',
      credentialStoreOptions: missingStore()
    })

    expect(result.lane).toBe('env-key')
    expect(result.settingsApiServerUrlRejected).toBe(false)
    expect(result.apiServerUrl).toBe('https://settings.devin.example/base')
    expect(result.childEnv.WINDSURF_API_SERVER_URL).toBe('https://settings.devin.example/base')
    // The alias is cleared, not merely outranked: inside the CLI an ambient
    // DEVIN_API_SERVER_URL could otherwise outvote the setting.
    expect('DEVIN_API_SERVER_URL' in result.childEnv).toBe(false)
  })

  it('lets a valid settings URL win over the stored api_server_url', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        PATH: 'unrelated-path-entry',
        DEVIN_API_SERVER_URL: 'https://alias.devin.example'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      settingsApiServerUrl: 'https://settings.devin.example/base',
      credentialStoreOptions: storedToml('sk-stored', 'https://stored.devin.example/api')
    })

    expect(result.lane).toBe('stored-toml')
    expect(result.apiServerUrl).toBe('https://settings.devin.example/base')
    expect(result.childEnv.WINDSURF_API_SERVER_URL).toBe('https://settings.devin.example/base')
    expect('DEVIN_API_SERVER_URL' in result.childEnv).toBe(false)
  })

  it('passes an env endpoint through when no settings URL is given', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        PATH: 'unrelated-path-entry',
        WINDSURF_API_KEY: 'wk-canonical',
        WINDSURF_API_SERVER_URL: 'https://env.devin.example/v1'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: missingStore()
    })

    expect(result.lane).toBe('env-key')
    expect(result.settingsApiServerUrlRejected).toBe(false)
    expect(result.childEnv.WINDSURF_API_SERVER_URL).toBe('https://env.devin.example/v1')
    expect(result.apiServerUrl).toBe('https://env.devin.example/v1')
  })

  it('reads the DEVIN_API_SERVER_URL alias when the canonical env var is absent', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        PATH: 'unrelated-path-entry',
        WINDSURF_API_KEY: 'wk-canonical',
        DEVIN_API_SERVER_URL: 'https://alias.devin.example/v1'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: missingStore()
    })

    expect(result.childEnv.WINDSURF_API_SERVER_URL).toBe('https://alias.devin.example/v1')
    expect(result.apiServerUrl).toBe('https://alias.devin.example/v1')
  })

  it('treats a blank settings URL as unset rather than rejected', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: envWithBothEndpoints,
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      settingsApiServerUrl: '   ',
      credentialStoreOptions: missingStore()
    })

    expect(result.settingsApiServerUrlRejected).toBe(false)
    expect(result.apiServerUrl).toBe('https://env.devin.example/')
  })

  it('reports an http non-loopback env endpoint as null', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        PATH: 'unrelated-path-entry',
        WINDSURF_API_KEY: 'wk-canonical',
        WINDSURF_API_SERVER_URL: 'http://env.devin.example'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      credentialStoreOptions: missingStore()
    })

    expect(result.lane).toBe('env-key')
    expect(result.apiServerUrl).toBeNull()
  })

  it.each([
    { settingsApiServerUrl: 'http://rejected-plain.example', marker: 'rejected-plain' },
    {
      settingsApiServerUrl: 'https://user:pass@rejected-creds.devin.example',
      marker: 'rejected-creds'
    },
    { settingsApiServerUrl: 'not a url', marker: 'not a url' }
  ])(
    'flags the invalid settings URL $settingsApiServerUrl as rejected without laundering it',
    ({ settingsApiServerUrl, marker }) => {
      const result = resolveDevinCredentialLaunch({
        resolvedEnv: envWithBothEndpoints,
        storedApiKeyPresent: false,
        ambientApiKeyAllowed: true,
        settingsApiServerUrl,
        credentialStoreOptions: missingStore()
      })

      expect(result.settingsApiServerUrlRejected).toBe(true)
      // The KEY lane still resolves; the caller refuses the launch on the flag.
      expect(result.lane).toBe('env-key')
      expect(result.missingApiKey).toBe(false)
      expect(result.childEnv.WINDSURF_API_KEY).toBe('wk-canonical')
      // The rejected value must never surface anywhere as if it were accepted.
      expect(JSON.stringify(result)).not.toContain(marker)
    }
  )

  it('flags a rejected settings URL on the stored-toml lane too', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: { PATH: 'unrelated-path-entry' },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      settingsApiServerUrl: 'http://rejected-plain.example',
      credentialStoreOptions: storedToml('sk-stored', 'https://stored.devin.example/api')
    })

    expect(result.settingsApiServerUrlRejected).toBe(true)
    expect(result.lane).toBe('stored-toml')
    expect(result.childEnv.WINDSURF_API_KEY).toBe('sk-stored')
    expect(JSON.stringify(result)).not.toContain('rejected-plain')
  })
})

describe('resolveDevinCredentialLaunch rejected settings endpoint', () => {
  it('never falls through to the env endpoint when the Settings URL is invalid', () => {
    // A user who typed a custom server must not have the run quietly sent to a
    // different one. index.ts refuses to launch on the flag; the lane itself
    // must also stop injecting any other endpoint so no caller can launder one.
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: {
        WINDSURF_API_KEY: 'wk',
        WINDSURF_API_SERVER_URL: 'https://env.example.test'
      },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      settingsApiServerUrl: 'http://not-loopback.example.test',
      credentialStoreOptions: missingStore()
    })
    expect(result.settingsApiServerUrlRejected).toBe(true)
    expect(result.lane).toBe('env-key')
    expect(result.apiServerUrl).toBeNull()
    expect(result.childEnv.WINDSURF_API_SERVER_URL).toBeUndefined()
    expect(result.childEnv.DEVIN_API_SERVER_URL).toBeUndefined()
  })

  it('never falls through to the stored endpoint when the Settings URL is invalid', () => {
    const result = resolveDevinCredentialLaunch({
      resolvedEnv: { PATH: 'unrelated-path-entry' },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      settingsApiServerUrl: 'https://user:secret@example.test',
      credentialStoreOptions: storedToml('sk-stored', 'https://stored.example.test')
    })
    expect(result.settingsApiServerUrlRejected).toBe(true)
    expect(result.lane).toBe('stored-toml')
    expect(result.apiServerUrl).toBeNull()
    expect(result.childEnv.WINDSURF_API_SERVER_URL).toBeUndefined()
  })
})
