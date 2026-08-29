import { describe, expect, it } from 'vitest'
import { PI_FULL_LADDER, defaultPiReasoningEffort, resolvePiReasoningSupport } from './piReasoning'
import { PI_STATIC_MODELS } from '../host-shared/pi/PiModels'

describe('resolvePiReasoningSupport', () => {
  // Each row is sourced to the upstream's own API docs. The point of the table
  // is that one Pi seat fronts upstreams whose controls are genuinely
  // different shapes — a four-tier ladder, a two-tier ladder, a boolean, and a
  // token budget with no ladder at all.
  const CASES: readonly (readonly [string, readonly string[]])[] = [
    // DeepSeek: medium and xhigh are documented aliases for high.
    ['deepseek/deepseek-v4-pro', ['off', 'low', 'high', 'max']],
    ['deepseek/deepseek-v4-flash', ['off', 'low', 'high', 'max']],
    // Z.ai collapses seven efforts onto two outcomes plus off.
    ['zai/glm-5.2', ['off', 'high', 'max']],
    // `reasoning_effort` is "GLM-5.2 and above".
    ['zai/glm-5.1', ['off', 'high']],
    // Qwen exposes `enable_thinking` plus a token budget, never a level.
    ['qwen-token-plan/qwen3.8-max', ['off', 'high']],
    ['minimax/MiniMax-M3', ['off', 'high']],
    ['xiaomi-token-plan-sgp/mimo-v2.5-pro', ['off', 'high']],
    // Mistral documents `high` and `none` only.
    ['mistral/mistral-medium-3.5', ['off', 'high']],
    ['mistral/zai-glm-5-2', ['off', 'high']],
    // OpenRouter's GLM copy advertises a different pair from Z.ai's own.
    ['openrouter/z-ai/glm-5.2', ['off', 'high', 'xhigh']],
    ['openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', ['off', 'medium', 'high']],
    ['openrouter/poolside/laguna-s-2.1', ['off', 'high']]
  ]

  it.each(CASES)('gives %s exactly %j', (wireId, efforts) => {
    expect(resolvePiReasoningSupport(wireId).efforts).toEqual(efforts)
  })

  it('offers no control for a model with no reasoning at all', () => {
    for (const wireId of [
      'mistral/mistral-large-2512',
      'mistral/devstral-2512',
      'mistral/codestral-2508',
      'mistral/ministral-3b-2512'
    ]) {
      expect(resolvePiReasoningSupport(wireId).kind, wireId).toBe('unsupported')
      expect(resolvePiReasoningSupport(wireId).efforts, wireId).toEqual([])
    }
  })

  it('locks the ladder for upstreams that reason on every turn', () => {
    // Both accept a disable flag and ignore it, so an Off stop would be a
    // control that silently does nothing.
    for (const wireId of ['zai/glm-4.7', 'minimax/MiniMax-M2.7', 'cerebras/zai-glm-4.7']) {
      const support = resolvePiReasoningSupport(wireId)
      expect(support.canDisable, wireId).toBe(false)
      expect(support.efforts, wireId).toEqual(['high'])
    }
    // Neither GPT-OSS host's enum carries a `none`.
    for (const wireId of ['groq/openai/gpt-oss-120b', 'cerebras/gpt-oss-120b']) {
      const support = resolvePiReasoningSupport(wireId)
      expect(support.canDisable, wireId).toBe(false)
      expect(support.efforts, wireId).toEqual(['low', 'medium', 'high'])
    }
  })

  it('keeps the full ladder for an unlisted or unset model', () => {
    // A newly registered upstream must not be silently stripped of a control
    // it may well support, and the seat-level question ("what can Pi do?")
    // stays the union until a model is chosen.
    expect(resolvePiReasoningSupport('openrouter/stealth/ox-alpha').efforts).toEqual(PI_FULL_LADDER)
    expect(resolvePiReasoningSupport('brand-new/model-1').efforts).toEqual(PI_FULL_LADDER)
    expect(resolvePiReasoningSupport(undefined).efforts).toEqual(PI_FULL_LADDER)
    expect(resolvePiReasoningSupport('').efforts).toEqual(PI_FULL_LADDER)
  })

  // The catalogue's `thinking` flag and this table are two statements about the
  // same fact, and only one of them is read by sub-thread delegation — a
  // disagreement there silently DROPS a delegated effort rather than failing.
  it('agrees with every catalogue row about whether the model reasons', () => {
    const disagreements = PI_STATIC_MODELS.filter(
      (model) => model.thinking !== resolvePiReasoningSupport(model.wireId).efforts.length > 0
    ).map((model) => model.wireId)
    expect(disagreements).toEqual([])
  })

  it('routes the same model differently per upstream', () => {
    // GLM-5.2 direct, via Mistral, and via OpenRouter are three different
    // controls for one model — which is why the table is keyed by wire id.
    expect(resolvePiReasoningSupport('zai/glm-5.2').efforts).toEqual(['off', 'high', 'max'])
    expect(resolvePiReasoningSupport('mistral/zai-glm-5-2').efforts).toEqual(['off', 'high'])
    expect(resolvePiReasoningSupport('openrouter/z-ai/glm-5.2').efforts).toEqual([
      'off',
      'high',
      'xhigh'
    ])
  })

  // A saved seat still names the pre-rename id. Resolving it as "unlisted"
  // would hand it the 7-stop fallback — including an Off that route does not
  // have — while dispatch quietly sent the request somewhere else entirely.
  it('resolves a historical wire id to the ladder it actually dispatches to', () => {
    for (const [legacy, canonical] of [
      ['openrouter/zai/glm-5.2', 'openrouter/z-ai/glm-5.2'],
      ['qwen-token-plan/qwen3.8-max-preview', 'qwen-token-plan/qwen3.8-max']
    ]) {
      expect(resolvePiReasoningSupport(legacy), legacy).toEqual(
        resolvePiReasoningSupport(canonical)
      )
    }
  })
})

describe('defaultPiReasoningEffort', () => {
  // Callers hardcoded 'medium'. Most Pi models no longer offer it, so the
  // membership guard downstream rejected it and a fresh seat fell to the
  // ladder's first stop — `off`. Every Pi run would have launched
  // `--thinking off` without anyone asking for it.
  it('starts a seat on a stop its own model offers', () => {
    expect(defaultPiReasoningEffort('zai/glm-5.2')).toBe('max')
    expect(defaultPiReasoningEffort('deepseek/deepseek-v4-pro')).toBe('high')
    expect(defaultPiReasoningEffort('openrouter/zai/glm-5.2')).toBe('high')
    // No reasoning axis at all, so there is nothing to start on.
    expect(defaultPiReasoningEffort('mistral/mistral-large-2512')).toBe('')
    // Unset (seat-level) and unresearched both keep the historical default.
    expect(defaultPiReasoningEffort('')).toBe('medium')
    expect(defaultPiReasoningEffort('brand/new-model')).toBe('medium')
  })

  it('never starts a seat on a stop the model does not offer', () => {
    for (const model of PI_STATIC_MODELS) {
      const support = resolvePiReasoningSupport(model.wireId)
      const start = defaultPiReasoningEffort(model.wireId)
      if (support.efforts.length === 0) expect(start, model.wireId).toBe('')
      else expect(support.efforts, model.wireId).toContain(start)
    }
  })
})
