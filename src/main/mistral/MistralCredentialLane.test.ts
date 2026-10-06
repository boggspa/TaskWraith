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
      expect(result.childEnv.VIBE_MODELS).toBeUndefined()
      expect(result.childEnv.VIBE_ACTIVE_MODEL).toBeUndefined()
      expect(result.introductionChildEnv).toBe(result.childEnv)
    }
  )

  it('passes the subscription thinking level through unchanged', () => {
    const result = resolveMistralCredentialLaunch({
      model: 'mistral-medium-3.5',
      resolvedEnv: credentialEnv,
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: false,
      thinkingLevel: 'max'
    })
    expect(result.thinkingLevel).toBe('max')
    expect(
      resolveMistralCredentialLaunch({
        model: 'glm-5-2',
        resolvedEnv: credentialEnv,
        storedApiKeyPresent: false,
        ambientApiKeyAllowed: false
      }).thinkingLevel
    ).toBeNull()
  })

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
    expect(result.childEnv.VIBE_ACTIVE_MODEL).toBe(model)
    expect(result.introductionChildEnv.VIBE_ACTIVE_MODEL).toBe(model)
    expect(result.introductionChildEnv.MISTRAL_API_KEY).toBe('studio-key')
    expect(result.introductionChildEnv.MISTRAL_TOKEN).toBeUndefined()
  })

  it('pins Large 4 for the working turn and pins the opening at thinking off', () => {
    const result = resolveMistralCredentialLaunch({
      model: 'mistral-large-4',
      resolvedEnv: credentialEnv,
      storedApiKeyPresent: true,
      ambientApiKeyAllowed: false,
      thinkingLevel: 'max'
    })
    const working = JSON.parse(String(result.childEnv.VIBE_MODELS))
    const opening = JSON.parse(String(result.introductionChildEnv.VIBE_MODELS))
    expect(working).toEqual([
      expect.objectContaining({ alias: 'mistral-large-4', thinking: 'max' })
    ])
    expect(opening).toEqual([
      expect.objectContaining({ alias: 'mistral-large-4', thinking: 'off' })
    ])
    expect(result.thinkingLevel).toBe('max')
  })

  it('pins an ambient-key launch too', () => {
    const result = resolveMistralCredentialLaunch({
      model: 'zai-glm-5-3',
      resolvedEnv: credentialEnv,
      storedApiKeyPresent: false,
      ambientApiKeyAllowed: true,
      thinkingLevel: 'high'
    })
    expect(result.childEnv.MISTRAL_API_KEY).toBe('studio-key')
    expect(result.childEnv.VIBE_ACTIVE_MODEL).toBe('zai-glm-5-3')
    // GLM-5.3 via Mistral has no thinking ladder on this seat.
    expect(result.thinkingLevel).toBe('off')
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
    expect(result.childEnv.VIBE_MODELS).toBeUndefined()
    expect(result.childEnv.VIBE_ACTIVE_MODEL).toBeUndefined()
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
