import { describe, expect, it } from 'vitest'
import {
  KIMI_DEFAULT_OAUTH_CREDENTIAL_NAME,
  kimiOAuthCredentialFileName,
  kimiOAuthCredentialName
} from './kimiOAuthCredentialSlot'

const GLOBAL_LOGIN_CONFIG = [
  'default_model = "kimi-code/k3"',
  '',
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'api_key = ""',
  'base_url = "https://api.kimi.ai/coding/v1"',
  '',
  '[providers."managed:kimi-code".oauth]',
  'storage = "file"',
  'key = "oauth/kimi-code-env-0e4f99c69cc27850"',
  'oauth_host = "https://auth.kimi.ai"',
  '',
  '[services.moonshot_search.oauth]',
  'key = "oauth/some-other-slot"'
].join('\n')

describe('kimiOAuthCredentialName', () => {
  it('follows the env-scoped slot a global-region `kimi login` records', () => {
    expect(kimiOAuthCredentialName(GLOBAL_LOGIN_CONFIG)).toBe('kimi-code-env-0e4f99c69cc27850')
    expect(kimiOAuthCredentialFileName(GLOBAL_LOGIN_CONFIG)).toBe(
      'kimi-code-env-0e4f99c69cc27850.json'
    )
  })

  it('keeps the historical default slot when config names none', () => {
    expect(kimiOAuthCredentialName(undefined)).toBe(KIMI_DEFAULT_OAUTH_CREDENTIAL_NAME)
    expect(kimiOAuthCredentialName('')).toBe(KIMI_DEFAULT_OAUTH_CREDENTIAL_NAME)
    expect(kimiOAuthCredentialFileName('default_model = "kimi-code/k3"\n')).toBe('kimi-code.json')
    expect(
      kimiOAuthCredentialName(
        '[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\n'
      )
    ).toBe('kimi-code')
  })

  it('reads only the managed provider oauth table, not services or comments', () => {
    expect(
      kimiOAuthCredentialName(
        [
          '[services.moonshot_fetch.oauth]',
          'key = "oauth/kimi-code-env-aaaaaaaaaaaaaaaa"',
          '[providers."managed:kimi-code".oauth]',
          '# key = "oauth/kimi-code-env-bbbbbbbbbbbbbbbb"'
        ].join('\n')
      )
    ).toBe(KIMI_DEFAULT_OAUTH_CREDENTIAL_NAME)
  })

  it('accepts single-quoted table and key forms', () => {
    expect(
      kimiOAuthCredentialName(
        "[providers.'managed:kimi-code'.oauth]\nkey = 'oauth/kimi-code-env-0123456789abcdef'\n"
      )
    ).toBe('kimi-code-env-0123456789abcdef')
  })

  it('refuses a slot that could escape credentials/', () => {
    for (const key of ['oauth/../secrets', 'oauth/.hidden', 'oauth/a/b', 'oauth/', 'oauth/a..b']) {
      const config = `[providers."managed:kimi-code".oauth]\nkey = "${key}"\n`
      expect(kimiOAuthCredentialName(config)).toBeNull()
      expect(kimiOAuthCredentialFileName(config)).toBeNull()
    }
  })
})
