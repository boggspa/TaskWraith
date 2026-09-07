import { describe, expect, it } from 'vitest'
import {
  OLLAMA_CLOUD_MODELS_WITHOUT_TOOL_LOOP_RETRY_CEILING,
  isOllamaCloudModelExemptFromToolLoopRetryCeiling,
  ollamaToolLoopRetryCeilingEnabled
} from './ollamaLoopProtectionPolicy'

const EXEMPT_CLOUD_PICKER_IDS = [
  'glm-5.3-flash:cloud',
  'glm-5.3:cloud',
  'deepseek-v4-flash:cloud',
  'gemma4:31b:cloud',
  'mistral-large-3:675b:cloud',
  'gpt-oss:120b:cloud',
  'nemotron-3-ultra:cloud',
  'kimi-k2.6:cloud',
  'kimi-k2.7-code:cloud',
  'minimax-m2.7:cloud',
  'glm-5.1:cloud',
  'gemma4:cloud',
  'deepseek-v4-pro:cloud',
  'kimi-k3:cloud',
  'minimax-m3:cloud'
] as const

describe('ollama tool-loop retry-ceiling policy', () => {
  it('exempts every named Ollama Cloud seat, including tagged and legacy suffixes', () => {
    expect(OLLAMA_CLOUD_MODELS_WITHOUT_TOOL_LOOP_RETRY_CEILING).toHaveLength(
      EXEMPT_CLOUD_PICKER_IDS.length
    )
    for (const modelId of EXEMPT_CLOUD_PICKER_IDS) {
      expect(ollamaToolLoopRetryCeilingEnabled(modelId)).toBe(false)
      expect(isOllamaCloudModelExemptFromToolLoopRetryCeiling(modelId)).toBe(true)
    }
    expect(ollamaToolLoopRetryCeilingEnabled('kimi-k2.7-code:latest-cloud')).toBe(false)
    expect(ollamaToolLoopRetryCeilingEnabled('gpt-oss:120b-cloud')).toBe(false)
    expect(ollamaToolLoopRetryCeilingEnabled('deepseek-v4-flash:0731:cloud')).toBe(false)
    expect(ollamaToolLoopRetryCeilingEnabled('deepseek-v4-flash:preview:cloud')).toBe(false)
    expect(ollamaToolLoopRetryCeilingEnabled('deepseek-v4-pro:0813:cloud')).toBe(false)
    expect(ollamaToolLoopRetryCeilingEnabled('deepseek-v4-pro:preview:cloud')).toBe(false)
    expect(ollamaToolLoopRetryCeilingEnabled('KIMI-K2.7-CODE:CLOUD')).toBe(false)
  })

  it('keeps the ceiling on local models and on Cloud rows that still need it', () => {
    expect(ollamaToolLoopRetryCeilingEnabled('kimi-k2.7-code')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('glm-5.3')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('gpt_oss_20b')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('glm-5.2:cloud')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('gpt-oss:20b:cloud')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('kimi-k2.5:cloud')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('qwen3.5:397b:cloud')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('nemotron-3-super:cloud')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('nemotron-3-nano:30b:cloud')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled('')).toBe(true)
    expect(ollamaToolLoopRetryCeilingEnabled(undefined)).toBe(true)
  })
})
