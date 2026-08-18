import { describe, expect, it } from 'vitest'
import {
  RETRIEVAL_FIRST_FAMILIES,
  ollamaEnforcesRetrievalFirst,
  ollamaReadFileExemptFromRetrievalFirst,
  ollamaRetrievalFirstBlockedMessage
} from './OllamaRetrievalFirst'

describe('OllamaRetrievalFirst', () => {
  it('is retired: no model family is walled in any more', () => {
    expect(RETRIEVAL_FIRST_FAMILIES.size).toBe(0)
    // The families that used to be gated, small and large alike. A user who
    // picks an under-powered model for a large task sees that for themselves;
    // the harness no longer refuses tool calls on their behalf.
    for (const modelId of [
      'gpt_oss_20b',
      'devstral-small-2:24b',
      'ministral-3:14b',
      'ministral-3:3b',
      'llama3.1:8b',
      'llama3.2:3b',
      'deepseek-r1:8b',
      'deepseek-r1:1.5b',
      'rnj-1',
      'glm-4.7-flash:q4_K_M',
      'north-mini-code-1.0:q4_K_M',
      'nemotron-3.5-lightning:30b-mlx',
      'nemotron-3-nano:4b',
      'muse-glimmer:30b-mlx',
      'granite4:3b',
      'qwen3.5:2b',
      'lfm2.5-thinking:1.2b',
      'gemma3:4b'
    ]) {
      expect(ollamaEnforcesRetrievalFirst(modelId)).toBe(false)
    }
  })

  it('treats an absent or empty model id as ungated', () => {
    expect(ollamaEnforcesRetrievalFirst(undefined)).toBe(false)
    expect(ollamaEnforcesRetrievalFirst(null)).toBe(false)
    expect(ollamaEnforcesRetrievalFirst('')).toBe(false)
  })

  it('keeps the exemption list and blocked-message helpers usable if a family is ever re-armed', () => {
    expect(ollamaReadFileExemptFromRetrievalFirst('README.md')).toBe(true)
    expect(ollamaReadFileExemptFromRetrievalFirst('src/main/Foo.ts')).toBe(false)
    expect(ollamaRetrievalFirstBlockedMessage('src/main/Foo.ts')).toContain('workspace_search')
    expect(ollamaRetrievalFirstBlockedMessage('src/main/Foo.ts')).toContain('list_directory')
  })
})
