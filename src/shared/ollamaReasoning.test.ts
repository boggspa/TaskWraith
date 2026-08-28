import { describe, expect, it } from 'vitest'
import {
  isOllamaGptOssModel,
  normalizeOllamaReasoningEffort,
  resolveOllamaReasoningSupport
} from './ollamaReasoning'

describe('resolveOllamaReasoningSupport', () => {
  it('uses the curated fallback before daemon metadata arrives', () => {
    expect(resolveOllamaReasoningSupport({ modelId: 'ornith-1.5:35b' })).toEqual({
      kind: 'toggle',
      efforts: ['off', 'on'],
      defaultEffort: 'on'
    })
    expect(resolveOllamaReasoningSupport({ modelId: 'gemma4:31b-mlx' }).kind).toBe('toggle')
    for (const modelId of [
      'mistral-medium-3.5:latest',
      'mistral-medium-3.5:128b',
      'qwen3.8-flash-next:125b-mlx',
      'granite4.2:3b',
      'granite4.2:latest',
      'granite4.2:30b'
    ]) {
      expect(resolveOllamaReasoningSupport({ modelId }).kind, modelId).toBe('toggle')
    }
    expect(resolveOllamaReasoningSupport({ modelId: 'gemma3:4b' }).kind).toBe('unsupported')
    expect(resolveOllamaReasoningSupport({ modelId: 'future-local:latest' }).kind).toBe('unknown')
  })

  it('recognizes quantized and alias forms without widening unrelated models', () => {
    expect(resolveOllamaReasoningSupport({ modelId: 'ornith-1.5:35b-q4_K_M' }).kind).toBe('toggle')
    expect(resolveOllamaReasoningSupport({ modelId: 'gpt-oss:latest' })).toEqual({
      kind: 'levels',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high'
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
    expect(normalizeOllamaReasoningEffort('off', support)).toBe('high')
  })
})
