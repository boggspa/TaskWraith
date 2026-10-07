import { describe, expect, it } from 'vitest'
import {
  isProjectableKimiApiKey,
  kimiConfigHasManagedProvider,
  projectKimiManagedApiKey
} from './KimiManagedApiKeyProjection'

const LOGIN_CONFIG = [
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
  '[models."kimi-code/k3"]',
  'provider = "managed:kimi-code"',
  'model = "k3"',
  '',
  '[services.moonshot_search.oauth]',
  'key = "oauth/kimi-code-env-0e4f99c69cc27850"'
].join('\n')

const KEY = 'sk-kimi-0123456789abcdefABCDEF'

describe('projectKimiManagedApiKey', () => {
  it('authenticates the managed provider by key and drops only its oauth table', () => {
    const projected = projectKimiManagedApiKey(LOGIN_CONFIG, KEY)
    expect(projected).not.toBeNull()
    const body = projected as string
    expect(body).toContain(`[providers."managed:kimi-code"]\napi_key = "${KEY}"\ntype = "kimi"`)
    expect(body.match(/^api_key\s*=/gm)).toHaveLength(1)
    expect(body).not.toContain('[providers."managed:kimi-code".oauth]')
    expect(body).not.toContain('oauth_host = "https://auth.kimi.ai"')
    // Endpoint, model aliases and services survive untouched.
    expect(body).toContain('base_url = "https://api.kimi.ai/coding/v1"')
    expect(body).toContain('[models."kimi-code/k3"]\nprovider = "managed:kimi-code"')
    expect(body).toContain(
      '[services.moonshot_search.oauth]\nkey = "oauth/kimi-code-env-0e4f99c69cc27850"'
    )
  })

  it('refuses when there is no managed provider to attach the key to', () => {
    expect(kimiConfigHasManagedProvider('default_model = "x"\n')).toBe(false)
    expect(projectKimiManagedApiKey('default_model = "x"\n', KEY)).toBeNull()
    expect(kimiConfigHasManagedProvider('[providers."managed:kimi-code"]\ntype = "openai"\n')).toBe(
      false
    )
  })

  it('refuses keys that could break out of a TOML string', () => {
    for (const key of ['short', 'sk-"quoted"-0000', 'sk-back\\slash-00', 'sk with space 000']) {
      expect(isProjectableKimiApiKey(key)).toBe(false)
      expect(projectKimiManagedApiKey(LOGIN_CONFIG, key)).toBeNull()
    }
    expect(isProjectableKimiApiKey(null)).toBe(false)
    expect(isProjectableKimiApiKey(`  ${KEY}\n`)).toBe(true)
  })
})
