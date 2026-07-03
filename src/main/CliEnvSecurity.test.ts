import { describe, expect, it } from 'vitest'
import { scrubCliEnv, shouldScrubCliEnvKey } from './CliEnvSecurity'

describe('CliEnvSecurity', () => {
  it('scrubs release, signing, and publishing credentials', () => {
    for (const key of [
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'APP_STORE_CONNECT_API_KEY',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'HOMEBREW_GITHUB_API_TOKEN',
      'YARN_NPM_AUTH_TOKEN',
      'FASTLANE_SESSION',
      'MATCH_PASSWORD',
      'TWINE_API_TOKEN',
      'CARGO_REGISTRY_TOKEN',
      'CARGO_REGISTRY_ACME_TOKEN'
    ]) {
      expect(shouldScrubCliEnvKey(key), key).toBe(true)
    }
  })

  it('preserves ordinary execution environment entries', () => {
    expect(
      scrubCliEnv({
        PATH: '/bin',
        SAFE_FLAG: '1',
        GITHUB_TOKEN: 'secret',
        TWINE_API_TOKEN: 'secret'
      })
    ).toEqual({
      PATH: '/bin',
      SAFE_FLAG: '1'
    })
  })
})
