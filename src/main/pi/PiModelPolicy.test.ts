import { describe, expect, it } from 'vitest'
import {
  PI_ALLOWED_UPSTREAMS,
  PI_UPSTREAM_KEY_ENV,
  buildPiCredentialEnv,
  isPiUpstreamAllowed,
  piModelPolicyVerdict
} from './PiModelPolicy'
import { PI_STATIC_MODELS, splitPiWireModelId } from './PiModels'

describe('piModelPolicyVerdict', () => {
  it('refuses every hosted/first-party upstream by name', () => {
    for (const upstream of [
      'anthropic',
      'openai',
      'google',
      'xai',
      'openrouter',
      'github-copilot',
      'kimi-coding',
      'radius',
      'amazon-bedrock',
      'azure-openai'
    ]) {
      const verdict = piModelPolicyVerdict(upstream, 'whatever-model')
      expect(verdict.allowed, upstream).toBe(false)
      expect(verdict.reason).toContain('allowlist')
    }
  })

  it('refuses resold hosted models inside allowed upstreams (kimi on qwen)', () => {
    for (const modelId of ['kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'KIMI-K3']) {
      const verdict = piModelPolicyVerdict('qwen-token-plan', modelId)
      expect(verdict.allowed, modelId).toBe(false)
      expect(verdict.reason).toContain('first-party')
    }
  })

  it('allows the scoped upstreams with real model ids', () => {
    expect(piModelPolicyVerdict('deepseek', 'deepseek-v4-pro').allowed).toBe(true)
    expect(piModelPolicyVerdict('zai', 'glm-5.2').allowed).toBe(true)
    expect(piModelPolicyVerdict('groq', 'openai/gpt-oss-120b').allowed).toBe(true)
  })

  it('refuses empty model ids', () => {
    expect(piModelPolicyVerdict('deepseek', '  ').allowed).toBe(false)
  })
})

describe('catalog/policy lockstep', () => {
  it('every static model passes the policy wall', () => {
    for (const model of PI_STATIC_MODELS) {
      const verdict = piModelPolicyVerdict(model.upstream, model.modelId)
      expect(verdict.allowed, model.wireId).toBe(true)
    }
  })

  it('every static wire id round-trips through splitPiWireModelId', () => {
    for (const model of PI_STATIC_MODELS) {
      const split = splitPiWireModelId(model.wireId)
      expect(split, model.wireId).toEqual({ upstream: model.upstream, modelId: model.modelId })
    }
  })

  it('splits groq double-slash ids on the first slash only', () => {
    expect(splitPiWireModelId('groq/openai/gpt-oss-120b')).toEqual({
      upstream: 'groq',
      modelId: 'openai/gpt-oss-120b'
    })
    expect(splitPiWireModelId('no-slash')).toBeNull()
    expect(splitPiWireModelId('trailing/')).toBeNull()
  })

  it('every allowed upstream has a key env var and label', () => {
    for (const upstream of PI_ALLOWED_UPSTREAMS) {
      expect(isPiUpstreamAllowed(upstream)).toBe(true)
      expect(PI_UPSTREAM_KEY_ENV[upstream]).toMatch(/^[A-Z0-9_]+$/)
    }
  })
})

describe('buildPiCredentialEnv (the env firewall)', () => {
  it('strips hosted-provider credentials inherited from the parent env', () => {
    const env = buildPiCredentialEnv(
      {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-leak',
        OPENAI_API_KEY: 'sk-openai-leak',
        XAI_API_KEY: 'leak',
        OPENROUTER_API_KEY: 'leak',
        KIMI_API_KEY: 'leak',
        HF_TOKEN: 'leak'
      },
      { deepseek: 'ds-key' }
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.XAI_API_KEY).toBeUndefined()
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
    expect(env.KIMI_API_KEY).toBeUndefined()
    expect(env.HF_TOKEN).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBe('ds-key')
  })

  it('resets allowlisted upstream vars so parent values cannot widen the set', () => {
    const env = buildPiCredentialEnv(
      { ZAI_API_KEY: 'parent-shell-value', DEEPSEEK_API_KEY: 'parent-shell-value' },
      { zai: 'configured-value' }
    )
    expect(env.ZAI_API_KEY).toBe('configured-value')
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('ignores blank configured keys', () => {
    const env = buildPiCredentialEnv({}, { deepseek: '   ' })
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
  })
})
