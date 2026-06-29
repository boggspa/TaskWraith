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
    expect(ollamaEnforcesRetrievalFirst('lfm2.5:8b')).toBe(true)
    expect(ollamaReadFileExemptFromRetrievalFirst('README.md')).toBe(true)
    expect(ollamaReadFileExemptFromRetrievalFirst('src/main/Foo.ts')).toBe(false)
    expect(ollamaRetrievalFirstBlockedMessage('src/main/Foo.ts')).toContain('workspace_search')
    expect(ollamaRetrievalFirstBlockedMessage('src/main/Foo.ts')).toContain('list_directory')
  })
})
