import { describe, expect, it } from 'vitest'
import { resolveMistralCredentialLaunch } from './MistralCredentialLane'

const credentialEnv = {
  PATH: '/usr/bin',
  MISTRAL_API_KEY: 'studio-key',
  MISTRAL_TOKEN: 'mistral-token'
}

describe('resolveMistralCredentialLaunch', () => {
  it.each([
    'devstral-small',
    'devstral-small-latest',
    'mistral-medium-3.5',
    'mistral-vibe-cli-latest',
    'glm-5-2'
  ])(
    'routes the Vibe model %s through the subscription and scrubs every API credential',
    (model) => {
      const result = resolveMistralCredentialLaunch({
        model,
        resolvedEnv: credentialEnv,
        storedApiKeyPresent: true,
        ambientApiKeyAllowed: true
      })

      expect(result).toMatchObject({
        lane: 'vibe-subscription',
        credentialEnvPresent: true,
        missingApiKey: false
      })
      // @portability-ok: asserts the fixture PATH passes through the credential lane unchanged — the code under test pins no literal
      expect(result.childEnv.PATH).toBe('/usr/bin')
      expect(result.childEnv.MISTRAL_API_KEY).toBeUndefined()
      expect(result.childEnv.MISTRAL_TOKEN).toBeUndefined()
    }
  )

  it.each([
    'mistral-large-2512',
    'zai-glm-5-2',
    'codestral-2508',
    'mistral-small-2603',
    'ministral-8b-2512'
  ])('routes the key-marked model %s through BYOK', (model) => {
    const result = resolveMistralCredentialLaunch({
      model,
      resolvedEnv: credentialEnv,
      storedApiKeyPresent: true,
      ambientApiKeyAllowed: false
    })

    expect(result).toMatchObject({
      lane: 'byok-api-key',
      credentialEnvPresent: true,
      missingApiKey: false
    })
    expect(result.childEnv.MISTRAL_API_KEY).toBe('studio-key')
    expect(result.childEnv.MISTRAL_TOKEN).toBeUndefined()
  })

  it('fails closed when an API-only model has no authorized key', () => {
    const result = resolveMistralCredentialLaunch({
      model: 'mistral-large-2512',
      resolvedEnv: credentialEnv,
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: false
    })

    expect(result).toMatchObject({
      lane: 'byok-api-key',
      credentialEnvPresent: true,
      missingApiKey: true
    })
    expect(result.childEnv.MISTRAL_API_KEY).toBeUndefined()
    expect(result.childEnv.MISTRAL_TOKEN).toBeUndefined()
  })

  it('accepts an ambient key only behind the explicit environment opt-in', () => {
    const result = resolveMistralCredentialLaunch({
      model: 'mistral-large-2512',
      resolvedEnv: credentialEnv,
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true
    })

    expect(result.missingApiKey).toBe(false)
    expect(result.childEnv.MISTRAL_API_KEY).toBe('studio-key')
  })

  it('still rejects an explicitly enabled ambient lane when no credential exists', () => {
    const result = resolveMistralCredentialLaunch({
      model: 'mistral-large-2512',
      resolvedEnv: { PATH: '/usr/bin' },
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true
    })

    expect(result).toMatchObject({
      lane: 'byok-api-key',
      credentialEnvPresent: false,
      missingApiKey: true
    })
  })
})
