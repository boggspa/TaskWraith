import { describe, expect, it } from 'vitest'
import {
  ollamaEnforcesRetrievalFirst,
  ollamaReadFileExemptFromRetrievalFirst,
  ollamaRetrievalFirstBlockedMessage
} from './OllamaRetrievalFirst'

describe('OllamaRetrievalFirst', () => {
  it('blocks unfamiliar reads until workspace_search runs', () => {
    expect(ollamaEnforcesRetrievalFirst('gpt-oss:20b')).toBe(true)
    expect(ollamaEnforcesRetrievalFirst('ornith:35b')).toBe(true)
    expect(ollamaEnforcesRetrievalFirst('laguna-xs-2.1:q8_0')).toBe(true)
    expect(ollamaEnforcesRetrievalFirst('lfm2.5:8b')).toBe(true)
    expect(ollamaEnforcesRetrievalFirst('qwen3.5:4b')).toBe(true)
    expect(ollamaEnforcesRetrievalFirst('devstral-small-2:24b')).toBe(true)
    expect(ollamaEnforcesRetrievalFirst('ministral-3:14b')).toBe(true)
    for (const modelId of [
      'llama3.1:8b',
      'deepseek-r1:8b',
      'rnj-1',
      'glm-4.7-flash:q4_K_M',
      'north-mini-code-1.0:q4_K_M',
      'muse-glimmer:30b-mlx',
      'llama3.2:3b'
    ]) {
      expect(ollamaEnforcesRetrievalFirst(modelId)).toBe(true)
    }
    for (const modelId of [
      'ministral-3:3b',
      'granite4:3b',
      'qwen3.5:2b',
      'deepseek-r1:1.5b',
      'nemotron-3-nano:4b',
      'lfm2.5-thinking:1.2b',
      'gemma3:4b'
    ]) {
      expect(ollamaEnforcesRetrievalFirst(modelId)).toBe(true)
    }
    expect(ollamaReadFileExemptFromRetrievalFirst('README.md')).toBe(true)
    expect(ollamaReadFileExemptFromRetrievalFirst('src/main/Foo.ts')).toBe(false)
    expect(ollamaRetrievalFirstBlockedMessage('src/main/Foo.ts')).toContain('workspace_search')
    expect(ollamaRetrievalFirstBlockedMessage('src/main/Foo.ts')).toContain('list_directory')
  })
})
