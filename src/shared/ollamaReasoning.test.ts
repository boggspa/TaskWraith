import { describe, expect, it } from 'vitest'
import {
  isOllamaGptOssModel,
  normalizeOllamaReasoningEffort,
  resolveOllamaReasoningSupport
} from './ollamaReasoning'

describe('resolveOllamaReasoningSupport', () => {
  it('uses the curated fallback before daemon metadata arrives', () => {
    expect(resolveOllamaReasoningSupport({ modelId: 'ornith:35b' })).toEqual({
      kind: 'toggle',
      efforts: ['off', 'on'],
      defaultEffort: 'on',
      canDisable: true
    })
    expect(resolveOllamaReasoningSupport({ modelId: 'gemma4:31b-mlx' }).kind).toBe('toggle')
    expect(resolveOllamaReasoningSupport({ modelId: 'qwen3.8-flash-next:125b-mlx' }).kind).toBe(
      'toggle'
    )
    // Only `high` maps through Mistral Medium 3.5's `.ThinkLevel` branch;
    // every other level falls back to "none".
    for (const modelId of ['mistral-medium-3.5:latest', 'mistral-medium-3.5:128b']) {
      expect(resolveOllamaReasoningSupport({ modelId }).efforts, modelId).toEqual(['off', 'high'])
    }
    expect(resolveOllamaReasoningSupport({ modelId: 'gemma3:4b' }).kind).toBe('unsupported')
    expect(resolveOllamaReasoningSupport({ modelId: 'future-local:latest' }).kind).toBe('unknown')
  })

  // These six were curated as thinking-capable and are not. A live daemon
  // reported no thinking capability for every one that is installed, and the
  // registry manifests agree: Granite 4.2's three sizes share one template, and
  // Ornith 1.5 ships without the parser its 1.0 sibling declares.
  it('does not promise thinking the packaged model cannot do', () => {
    for (const modelId of [
      'qwen3:4b-instruct',
      'minicpm-v4.5:8b',
      'ornith-1.5:9b',
      'ornith-1.5:35b',
      'granite4.2:3b',
      'granite4.2:8b',
      'granite4.2:30b',
      'granite4.2:latest'
    ]) {
      expect(resolveOllamaReasoningSupport({ modelId }).kind, modelId).toBe('unsupported')
    }
    // The thinking sibling of the instruct variant keeps its control.
    expect(resolveOllamaReasoningSupport({ modelId: 'ornith:9b' }).kind).toBe('toggle')
  })

  // The curated matcher treats `<id>-<suffix>` as family, so listing the base
  // tag as a toggle would swallow the one variant that cannot think.
  it('lets a non-thinking variant outrank its thinking family', () => {
    expect(resolveOllamaReasoningSupport({ modelId: 'qwen3:4b' }).kind).toBe('toggle')
    expect(resolveOllamaReasoningSupport({ modelId: 'qwen3:4b-thinking' }).kind).toBe('toggle')
    expect(resolveOllamaReasoningSupport({ modelId: 'qwen3:4b-instruct' }).kind).toBe('unsupported')
  })

  it('recognizes quantized and alias forms without widening unrelated models', () => {
    expect(resolveOllamaReasoningSupport({ modelId: 'ornith:35b-q4_K_M' }).kind).toBe('toggle')
    // GPT-OSS always reasons, so its ladder carries no Off stop.
    expect(resolveOllamaReasoningSupport({ modelId: 'gpt-oss:latest' })).toEqual({
      kind: 'levels',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      canDisable: false
    })
    expect(isOllamaGptOssModel('gpt-oss:20b:cloud')).toBe(true)
    expect(isOllamaGptOssModel('not-gpt-oss:20b')).toBe(false)
  })

  it('treats explicit daemon capabilities as authoritative', () => {
    expect(
      resolveOllamaReasoningSupport({
        modelId: 'custom-thinking:latest',
        capabilities: ['completion', 'tools', 'thinking']
      }).kind
    ).toBe('toggle')
    expect(
      resolveOllamaReasoningSupport({
        modelId: 'ornith:35b',
        capabilities: ['completion', 'tools']
      }).kind
    ).toBe('unsupported')
    expect(resolveOllamaReasoningSupport({ modelId: 'ornith:35b', capabilities: [] }).kind).toBe(
      'unsupported'
    )
  })
})

describe('per-model ladders (regression pins)', () => {
  // Verified against a live daemon: `gpt-oss:120b-cloud` reports the thinking
  // capability and resolved `toggle`, so the one model whose levels Ollama
  // documents was offered Off/On. `isOllamaGptOssModel` matched three literal
  // aliases and the 120B sibling was not among them.
  it('gives every GPT-OSS size the level ladder', () => {
    for (const modelId of [
      'gpt-oss:20b',
      'gpt-oss:120b',
      'gpt-oss:120b-cloud',
      'gpt-oss:120b:cloud',
      'gpt-oss:latest'
    ]) {
      expect(isOllamaGptOssModel(modelId), modelId).toBe(true)
      expect(
        resolveOllamaReasoningSupport({
          modelId,
          capabilities: ['completion', 'tools', 'thinking']
        }).kind,
        modelId
      ).toBe('levels')
    }
  })

  // Cloud recommendations carry no `capabilities`, so a Cloud model the user
  // has not pulled resolves from the curated table alone — and an `unknown`
  // renders as "Reasoning is not configurable for this model", an affirmative
  // denial rather than an absence of evidence.
  it('classifies Cloud models that are recommended but not pulled', () => {
    for (const modelId of ['glm-5.3:cloud', 'glm-5.3-flash:cloud', 'deepseek-v4-pro:cloud']) {
      expect(resolveOllamaReasoningSupport({ modelId }).kind, modelId).not.toBe('unknown')
    }
  })
})

describe('per-model ladders match the vendors', () => {
  // Each row is sourced: Ollama's own docs for GPT-OSS/GLM, Z.ai's parameter
  // reference for the GLM family, DeepSeek's thinking-mode guide, MiniMax's
  // API reference. A level absent from a row is one the vendor does not
  // accept — forwarding it lands on that vendor's default, which is `max` for
  // GLM and DeepSeek, i.e. the opposite of what a user asking for less wants.
  const CASES: readonly (readonly [string, readonly string[], boolean])[] = [
    ['gpt-oss:120b', ['low', 'medium', 'high'], false],
    ['glm-5.3:cloud', ['low', 'high', 'max'], false],
    ['glm-5.3-flash:cloud', ['low', 'high', 'max'], false],
    ['glm-5.2:cloud', ['off', 'high', 'max'], true],
    ['glm-5.1:cloud', ['off', 'on'], true],
    ['deepseek-v4-pro:cloud', ['off', 'low', 'high', 'max'], true],
    ['deepseek-v4-flash:cloud', ['off', 'low', 'high', 'max'], true],
    ['kimi-k3:cloud', ['on'], false],
    ['kimi-k2.7-code:cloud', ['on'], false],
    ['kimi-k2.6:cloud', ['off', 'on'], true],
    ['minimax-m2.7:cloud', ['on'], false],
    ['minimax-m3:cloud', ['off', 'on'], true],
    ['gemma4:31b-cloud', ['off', 'on'], true],
    ['mistral-large-3:675b-cloud', [], false]
  ]

  it.each(CASES)('offers %s exactly %j', (modelId, efforts, canDisable) => {
    const support = resolveOllamaReasoningSupport({ modelId })
    expect(support.efforts).toEqual(efforts)
    expect(support.canDisable).toBe(canDisable)
  })

  it('keeps a live daemon capability from widening a curated ladder', () => {
    // `/api/show` proves THAT a model thinks; it has no field for the shape of
    // the control, so a thinking capability must not promote GLM 5.3 back to
    // the generic boolean surface.
    const support = resolveOllamaReasoningSupport({
      modelId: 'glm-5.3:cloud',
      capabilities: ['completion', 'tools', 'thinking']
    })
    expect(support.efforts).toEqual(['low', 'high', 'max'])
  })

  it('still denies a model the daemon reports as non-thinking', () => {
    expect(
      resolveOllamaReasoningSupport({
        modelId: 'glm-5.3:cloud',
        capabilities: ['completion', 'tools']
      }).kind
    ).toBe('unsupported')
  })
})

describe('normalizeOllamaReasoningEffort', () => {
  it('normalizes ordinary thinking models to their boolean surface', () => {
    const support = resolveOllamaReasoningSupport({ modelId: 'ornith:35b' })
    expect(normalizeOllamaReasoningEffort('off', support)).toBe('off')
    expect(normalizeOllamaReasoningEffort('high', support)).toBe('on')
    expect(normalizeOllamaReasoningEffort(undefined, support)).toBe('on')
  })

  it('keeps GPT-OSS on its documented level-only surface', () => {
    const support = resolveOllamaReasoningSupport({ modelId: 'gpt-oss:20b' })
    expect(normalizeOllamaReasoningEffort('low', support)).toBe('low')
    // GPT-OSS cannot stop reasoning, so Off honours the INTENT — the least it
    // will do — rather than answering "as little as possible" with its top.
    expect(normalizeOllamaReasoningEffort('off', support)).toBe('low')
    expect(normalizeOllamaReasoningEffort('minimal', support)).toBe('low')
    expect(normalizeOllamaReasoningEffort('ultratask', support)).toBe('high')
  })

  it('rounds an unoffered level UP to the next stop the vendor honours', () => {
    // DeepSeek documents `medium` and `xhigh` as aliases for `high`. Rounding
    // DOWN would run the Local Scout profile (reasoningLevel 'medium') at
    // DeepSeek's LOWEST effort.
    const deepseek = resolveOllamaReasoningSupport({ modelId: 'deepseek-v4-pro:cloud' })
    expect(normalizeOllamaReasoningEffort('medium', deepseek)).toBe('high')
    // GLM 5.2 offers only High and Max, so anything below lands on High.
    const glm52 = resolveOllamaReasoningSupport({ modelId: 'glm-5.2:cloud' })
    expect(normalizeOllamaReasoningEffort('low', glm52)).toBe('high')
    expect(normalizeOllamaReasoningEffort('off', glm52)).toBe('off')
  })
})
