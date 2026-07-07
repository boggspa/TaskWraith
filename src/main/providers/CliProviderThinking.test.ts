import { describe, expect, it } from 'vitest'
import {
  advanceCliProviderThinkingSegments,
  cliProviderThinkingSegmentToolId,
  isThinkingTraceToolName,
  mergeCliProviderThinkingChunk,
  shouldBreakThinkingChronology,
  shouldIgnoreCliProviderThinkingChunk,
  type CliProviderThinkingSegmentsState
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
    expect(mergeCliProviderThinkingChunk('old trace', 'new trace', { cumulative: true })).toBe(
      'new trace'
    )
    expect(mergeCliProviderThinkingChunk('same', 'same', { cumulative: true })).toBeNull()
    expect(mergeCliProviderThinkingChunk(undefined, '   ', { cumulative: true })).toBeNull()
    expect(shouldIgnoreCliProviderThinkingChunk('   ', { cumulative: true })).toBe(true)
  })
})

describe('chronological thinking segmentation', () => {
  it('accumulates append deltas into one segment while nothing intervenes', () => {
    const state: CliProviderThinkingSegmentsState = {}
    expect(advanceCliProviderThinkingSegments(state, 'First')).toEqual({
      text: 'First',
      startedNewActivity: true,
      segmentSeq: 1
    })
    expect(advanceCliProviderThinkingSegments(state, ' thought')).toEqual({
      text: 'First thought',
      startedNewActivity: false,
      segmentSeq: 1
    })
    expect(state.thinkingText).toBe('First thought')
  })

  it('opens a new segment for the first chunk after a chronology break', () => {
    const state: CliProviderThinkingSegmentsState = {}
    advanceCliProviderThinkingSegments(state, 'First thought')
    state.thinkingChronoBreak = true // e.g. a tool call landed
    expect(advanceCliProviderThinkingSegments(state, 'Second thought')).toEqual({
      text: 'Second thought',
      startedNewActivity: true,
      segmentSeq: 2
    })
    // Earlier text stays committed to segment 1; the new segment holds only
    // the late reasoning.
    expect(state.thinkingTextCommitted).toBe('First thought')
    expect(state.thinkingText).toBe('Second thought')
    // Follow-up deltas keep growing segment 2.
    expect(advanceCliProviderThinkingSegments(state, ' continues')).toEqual({
      text: 'Second thought continues',
      startedNewActivity: false,
      segmentSeq: 2
    })
  })

  it('does not split on whitespace-only bridge deltas after a break', () => {
    const state: CliProviderThinkingSegmentsState = {}
    advanceCliProviderThinkingSegments(state, 'First')
    state.thinkingChronoBreak = true
    expect(advanceCliProviderThinkingSegments(state, '\n\n')).toBeNull()
    expect(state.thinkingSegmentSeq).toBe(1)
    expect(state.thinkingChronoBreak).toBe(true) // still pending for real text
    expect(advanceCliProviderThinkingSegments(state, 'Later')).toMatchObject({
      startedNewActivity: true,
      segmentSeq: 2
    })
  })

  it('drops cumulative restatements of the current segment without splitting', () => {
    // Claude partial-messages: deltas stream, then the trailing assistant
    // envelope restates the message's thinking verbatim — with a tool call
    // already marked as a break in between.
    const state: CliProviderThinkingSegmentsState = {}
    advanceCliProviderThinkingSegments(state, 'Analyse the bug')
    state.thinkingChronoBreak = true
    expect(
      advanceCliProviderThinkingSegments(state, 'Analyse the bug', { cumulative: true })
    ).toBeNull()
    expect(state.thinkingSegmentSeq).toBe(1)
    expect(state.thinkingChronoBreak).toBe(true)
  })

  it('drops cumulative restatements of the whole turn across segments', () => {
    // Claude interleaved thinking: one message carries two thinking blocks
    // split by visible output; its trailing envelope restates BOTH.
    const state: CliProviderThinkingSegmentsState = {}
    advanceCliProviderThinkingSegments(state, 'Part one. ')
    state.thinkingChronoBreak = true
    advanceCliProviderThinkingSegments(state, 'Part two.')
    expect(
      advanceCliProviderThinkingSegments(state, 'Part one. Part two.', { cumulative: true })
    ).toBeNull()
    expect(state.thinkingSegmentSeq).toBe(2)
  })

  it('opens a new segment for a divergent cumulative statement after a break', () => {
    // Claude without partial messages: only envelopes arrive. Message 2's
    // thinking restates a brand-new statement after tools/text intervened.
    const state: CliProviderThinkingSegmentsState = {}
    advanceCliProviderThinkingSegments(state, 'Plan the edit', { cumulative: true })
    state.thinkingChronoBreak = true
    expect(
      advanceCliProviderThinkingSegments(state, 'Review the result', { cumulative: true })
    ).toEqual({ text: 'Review the result', startedNewActivity: true, segmentSeq: 2 })
    expect(state.thinkingTextCommitted).toBe('Plan the edit')
  })

  it('keeps replace-in-place semantics for divergent cumulative text without a break', () => {
    const state: CliProviderThinkingSegmentsState = {}
    advanceCliProviderThinkingSegments(state, 'old trace', { cumulative: true })
    expect(advanceCliProviderThinkingSegments(state, 'new trace', { cumulative: true })).toEqual({
      text: 'new trace',
      startedNewActivity: false,
      segmentSeq: 1
    })
    expect(state.thinkingText).toBe('new trace')
  })

  it('appends only the unseen suffix of a grown cumulative envelope', () => {
    const state: CliProviderThinkingSegmentsState = {}
    advanceCliProviderThinkingSegments(state, 'Thinking', { cumulative: true })
    expect(
      advanceCliProviderThinkingSegments(state, 'Thinking harder', { cumulative: true })
    ).toEqual({ text: 'Thinking harder', startedNewActivity: false, segmentSeq: 1 })
    // Growth spanning a break carries just the suffix into the new segment.
    state.thinkingChronoBreak = true
    expect(
      advanceCliProviderThinkingSegments(state, 'Thinking harder still', { cumulative: true })
    ).toEqual({ text: ' still', startedNewActivity: true, segmentSeq: 2 })
  })

  it('derives per-segment tool ids with a legacy-stable first segment', () => {
    expect(cliProviderThinkingSegmentToolId('claude', 'run-1', 1)).toBe('claude-thinking-run-1')
    expect(cliProviderThinkingSegmentToolId('claude', 'run-1', 2)).toBe(
      'claude-thinking-run-1-seg2'
    )
    expect(cliProviderThinkingSegmentToolId('grok', undefined, 3)).toBe('grok-thinking-run-seg3')
  })
})

describe('shouldBreakThinkingChronology', () => {
  it('breaks on transcript-visible content and tool lines', () => {
    expect(shouldBreakThinkingChronology({ type: 'content', text: 'hi' })).toBe(true)
    expect(shouldBreakThinkingChronology({ type: 'token', content: 'hi' })).toBe(true)
    expect(shouldBreakThinkingChronology({ type: 'tool_use', tool_name: 'bash' })).toBe(true)
    expect(shouldBreakThinkingChronology({ type: 'tool_result', tool_name: 'bash' })).toBe(true)
    expect(shouldBreakThinkingChronology({ type: 'update_topic', title: 'x' })).toBe(true)
    expect(
      shouldBreakThinkingChronology({ type: 'message', role: 'assistant', content: 'x' })
    ).toBe(true)
  })

  it('never breaks on the reasoning pseudo-tool lines themselves', () => {
    expect(shouldBreakThinkingChronology({ type: 'tool_use', tool_name: 'claude_thinking' })).toBe(
      false
    )
    expect(shouldBreakThinkingChronology({ type: 'tool_result', tool_name: 'grok_thinking' })).toBe(
      false
    )
    expect(
      shouldBreakThinkingChronology({ type: 'tool_result', tool_name: 'codex_reasoning' })
    ).toBe(false)
    expect(isThinkingTraceToolName('ollama_thinking')).toBe(true)
    expect(isThinkingTraceToolName('Read')).toBe(false)
  })

  it('ignores non-transcript lifecycle payloads', () => {
    expect(shouldBreakThinkingChronology({ type: 'init', model: 'm' })).toBe(false)
    expect(shouldBreakThinkingChronology({ type: 'result', status: 'success' })).toBe(false)
    expect(shouldBreakThinkingChronology({ type: 'message', role: 'user' })).toBe(false)
    expect(shouldBreakThinkingChronology(null)).toBe(false)
    expect(shouldBreakThinkingChronology('content')).toBe(false)
  })
})
