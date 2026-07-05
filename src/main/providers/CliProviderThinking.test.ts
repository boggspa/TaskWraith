import { describe, expect, it } from 'vitest'
import {
  mergeCliProviderThinkingChunk,
  shouldIgnoreCliProviderThinkingChunk
} from './CliProviderThinking'

describe('CliProviderThinking chunk merge', () => {
  it('preserves leading-space append deltas for Grok/Cursor token streams', () => {
    expect(mergeCliProviderThinkingChunk('Hello', ' world')).toBe('Hello world')
    expect(shouldIgnoreCliProviderThinkingChunk(' world')).toBe(false)
  })

  it('keeps whitespace-only append deltas for word-join boundaries', () => {
    expect(mergeCliProviderThinkingChunk('Hello', ' ')).toBe('Hello ')
    expect(shouldIgnoreCliProviderThinkingChunk(' ')).toBe(false)
  })

  it('ignores empty append chunks', () => {
    expect(mergeCliProviderThinkingChunk('Hello', '')).toBeNull()
    expect(shouldIgnoreCliProviderThinkingChunk('')).toBe(true)
  })

  it('replaces cumulative envelopes and skips whitespace-only snapshots', () => {
    expect(
      mergeCliProviderThinkingChunk('old trace', 'new trace', { cumulative: true })
    ).toBe('new trace')
    expect(mergeCliProviderThinkingChunk('same', 'same', { cumulative: true })).toBeNull()
    expect(mergeCliProviderThinkingChunk(undefined, '   ', { cumulative: true })).toBeNull()
    expect(shouldIgnoreCliProviderThinkingChunk('   ', { cumulative: true })).toBe(true)
  })
})