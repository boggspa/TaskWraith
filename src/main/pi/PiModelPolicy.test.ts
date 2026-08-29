import { describe, expect, it } from 'vitest'
import { resolveContextWindow } from '../../shared/contextWindows'
import {
  PI_ALLOWED_UPSTREAMS,
  PI_OPENROUTER_ALLOWED_MODEL_IDS,
  PI_UPSTREAM_KEY_ENV,
  buildPiCredentialEnv,
  isPiUpstreamAllowed,
  piModelPolicyVerdict
} from './PiModelPolicy'
import { PI_STATIC_MODELS, piModelsForConfiguredUpstreams, splitPiWireModelId } from './PiModels'

describe('piModelPolicyVerdict', () => {
  it('refuses every hosted/first-party upstream except the scoped OpenRouter lane', () => {
    for (const upstream of [
      'anthropic',
      'openai',
      'google',
      'xai',
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

  it('allows only specific active custom models from OpenRouter', () => {
    expect(piModelPolicyVerdict('openrouter', 'stealth/ox-alpha')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('2026-08-28')
    })
    for (const modelId of [
      'openrouter/auto',
      'anthropic/claude-opus-5',
      'openai/gpt-5.6-terra',
      'stealth/ox-alpha:free',
      'stealth/another-model'
    ]) {
      const verdict = piModelPolicyVerdict('openrouter', modelId)
      expect(verdict.allowed, modelId).toBe(false)
      expect(verdict.reason).toMatch(/GLM|Laguna|Nemotron/)
    }
    expect(PI_OPENROUTER_ALLOWED_MODEL_IDS).toEqual([
      'z-ai/glm-5.2',
      'poolside/laguna-s-2.1',
      'nvidia/nemotron-3-ultra-550b-a55b:free'
    ])
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
    expect(piModelPolicyVerdict('openrouter', 'z-ai/glm-5.2').allowed).toBe(true)
    // The unhyphenated namespace does not exist on OpenRouter.
    expect(piModelPolicyVerdict('openrouter', 'zai/glm-5.2').allowed).toBe(false)
  })

  it('refuses Cerebras GLM-4.7 from its sunset without affecting Z.ai or GPT-OSS', () => {
    const before = new Date(2026, 7, 16, 23, 59)
    const retired = new Date(2026, 7, 17, 0, 0)

    expect(piModelPolicyVerdict('cerebras', 'zai-glm-4.7', before).allowed).toBe(true)
    expect(piModelPolicyVerdict('cerebras', 'zai-glm-4.7', retired)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('2026-08-17')
    })
    expect(piModelPolicyVerdict('zai', 'glm-4.7', retired).allowed).toBe(true)
    expect(piModelPolicyVerdict('cerebras', 'gpt-oss-120b', retired).allowed).toBe(true)
  })

  it('refuses empty model ids', () => {
    expect(piModelPolicyVerdict('deepseek', '  ').allowed).toBe(false)
  })
})

describe('catalog/policy lockstep', () => {
  it('keeps retired Ox Alpha metadata while the policy refuses only a new run', () => {
    expect(PI_STATIC_MODELS.find((model) => model.wireId === 'openrouter/stealth/ox-alpha')).toMatchObject({
      label: 'Ox Alpha',
      contextWindow: 1_048_576
    })
    expect(
      piModelPolicyVerdict('openrouter', 'stealth/ox-alpha', new Date(2026, 7, 28))
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('2026-08-28')
    })
  })

  it('every active static model passes the policy wall', () => {
    for (const model of PI_STATIC_MODELS) {
      if (
        model.wireId === 'cerebras/zai-glm-4.7' ||
        model.wireId === 'openrouter/stealth/ox-alpha'
      ) {
        continue
      }
      const verdict = piModelPolicyVerdict(model.upstream, model.modelId, new Date(2026, 7, 28))
      expect(verdict.allowed, model.wireId).toBe(true)
    }
  })

  it('removes retired rows only from the configured-upstream offer projection', () => {
    const configured = new Set(['cerebras'])
    expect(
      piModelsForConfiguredUpstreams(configured, new Date(2026, 7, 16)).map((model) => model.wireId)
    ).toEqual(['cerebras/zai-glm-4.7', 'cerebras/gpt-oss-120b'])
    expect(
      piModelsForConfiguredUpstreams(configured, new Date(2026, 7, 17)).map((model) => model.wireId)
    ).toEqual(['cerebras/gpt-oss-120b'])

    const openRouterConfigured = new Set(['openrouter'])
    expect(
      piModelsForConfiguredUpstreams(openRouterConfigured, new Date(2026, 7, 28)).map(
        (model) => model.wireId
      )
    ).toEqual([
      'openrouter/z-ai/glm-5.2',
      'openrouter/poolside/laguna-s-2.1',
      'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'
    ])
  })

  it('every static wire id round-trips through splitPiWireModelId', () => {
    for (const model of PI_STATIC_MODELS) {
      const split = splitPiWireModelId(model.wireId)
      expect(split, model.wireId).toEqual({ upstream: model.upstream, modelId: model.modelId })
    }
  })

  it('registers the exact context window for every static Pi model', () => {
    for (const model of PI_STATIC_MODELS) {
      expect(resolveContextWindow('pi', model.wireId), model.wireId).toBe(model.contextWindow)
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

  it('injects the configured OpenRouter key while stripping a parent-shell value', () => {
    const env = buildPiCredentialEnv(
      { OPENROUTER_API_KEY: 'parent-shell-value' },
      { openrouter: 'configured-openrouter-key' }
    )
    expect(env.OPENROUTER_API_KEY).toBe('configured-openrouter-key')
  })
})
