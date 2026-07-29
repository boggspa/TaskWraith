import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { resolveAssistantDeltaTarget } from './assistantDeltaTarget'

const NOW = '2026-06-13T00:00:00.000Z'

function assistant(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: NOW }
}

function tool(id: string): ChatMessage {
  return {
    id,
    role: 'tool',
    content: '',
    timestamp: NOW,
    toolActivities: [
      { id: `${id}-a`, toolName: 'read_file', displayName: 'Read file', status: 'success' } as any
    ]
  }
}

describe('resolveAssistantDeltaTarget', () => {
  it('appends a fresh bubble when there are no messages yet', () => {
    expect(resolveAssistantDeltaTarget([], { incoming: 'hi' })).toEqual({ action: 'append' })
  })

  it('merges into the trailing assistant bubble (continuation, no tool since)', () => {
    const messages = [assistant('a1', 'Hello')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: ' world' })).toEqual({
      action: 'merge',
      index: 0
    })
  })

  it('SEALS at a tool boundary — a genuine increment after a tool burst starts a NEW bubble', () => {
    // [assistant, tool] then more text: the new text belongs BELOW the tool,
    // not merged back into the pre-burst bubble. This is the core interleave.
    const messages = [assistant('a1', 'First segment.'), tool('t1')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: 'Second segment.' })).toEqual({
      action: 'append'
    })
  })

  it('does not reach back across MULTIPLE consecutive tools for an increment', () => {
    const messages = [assistant('a1', 'First.'), tool('t1'), tool('t2')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: 'Second.' })).toEqual({
      action: 'append'
    })
  })

  it('places a tagged cumulative restatement TAIL below the tool, not merged into the pre-tool bubble', () => {
    // Claude clean cumulative envelope after a tool: the post-tool text is new
    // and belongs in a fresh bubble below the tool. Merging the whole turn into
    // the pre-tool bubble would clump it above the tool (the regression).
    const messages = [assistant('a1', 'Partial answer'), tool('t1')]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Partial answer now complete',
        cumulative: true
      })
    ).toEqual({ action: 'appendText', text: ' now complete' })
  })

  it('places an UNTAGGED superset snapshot TAIL below the tool (Cursor mid-turn tool use)', () => {
    // Cursor emits full snapshots untagged; after a tool, the post-tool tail
    // opens a new bubble below the tool — interleaved, not clumped.
    const messages = [assistant('a1', 'Hello'), tool('t1')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: 'Hello world' })).toEqual({
      action: 'appendText',
      text: ' world'
    })
  })

  it('updates the trailing post-tool bubble with only the tail (Cursor continuing after the tool)', () => {
    // A later Cursor snapshot once the post-tool bubble exists: replace that
    // bubble with the tail beyond the pre-tool text — never the whole turn
    // (which would duplicate the pre-tool prose).
    const messages = [assistant('a1', 'Hello'), tool('t1'), assistant('a2', ' world')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: 'Hello world more' })).toEqual({
      action: 'replaceText',
      index: 2,
      text: ' world more'
    })
  })

  it('SKIPS a divergent cumulative envelope spanning a tool (Claude — deltas already rendered)', () => {
    // The envelope normalizes whitespace so it does NOT cleanly extend the
    // pre-tool bubble; the streamed deltas already produced the interleaving,
    // so skip rather than duplicate (mirrors the bridge post-stream skip).
    const messages = [
      assistant('a1', 'First segment. '),
      tool('t1'),
      assistant('a2', 'Second segment.')
    ]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'First segment.Second segment.', // no space after the period — diverges
        cumulative: true
      })
    ).toEqual({ action: 'skip' })
  })

  it('appends a divergent Cursor segment snapshot after a tool burst', () => {
    const messages = [assistant('a1', 'Creating three smoke-test files.'), tool('t1')]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Created three sample smoke-test files. All nine tests passed.',
        cumulative: true,
        trustedIncremental: true,
        preserveDivergentSnapshot: true
      })
    ).toEqual({
      action: 'appendText',
      text: 'Created three sample smoke-test files. All nine tests passed.'
    })
  })

  it('replaces the trailing post-tool bubble with a newer Cursor segment snapshot', () => {
    const messages = [
      assistant('a1', 'Creating files.'),
      tool('t1'),
      assistant('a2', 'Created three files.')
    ]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Created three files. All checks passed.',
        cumulative: true,
        trustedIncremental: true,
        preserveDivergentSnapshot: true
      })
    ).toEqual({
      action: 'replaceText',
      index: 2,
      text: 'Created three files. All checks passed.'
    })
  })

  it('ignores a stale shorter Cursor segment snapshot', () => {
    const messages = [
      assistant('a1', 'Creating files.'),
      tool('t1'),
      assistant('a2', 'Created three files. All checks passed.')
    ]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Created three files.',
        cumulative: true,
        trustedIncremental: true,
        preserveDivergentSnapshot: true
      })
    ).toEqual({ action: 'skip' })
  })

  it('still extracts the post-tool tail from a clean whole-turn Cursor snapshot', () => {
    const messages = [assistant('a1', 'Creating files.'), tool('t1')]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Creating files. Created three files.',
        cumulative: true,
        trustedIncremental: true,
        preserveDivergentSnapshot: true
      })
    ).toEqual({ action: 'appendText', text: ' Created three files.' })
  })

  it('SKIPS a cumulative restatement that only re-covers the pre-tool text', () => {
    const messages = [assistant('a1', 'Hello'), tool('t1')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: 'Hello', cumulative: true })).toEqual({
      action: 'skip'
    })
  })

  it('continues a genuine post-tool increment in the trailing bubble (not a restatement)', () => {
    const messages = [assistant('a1', 'Intro.'), tool('t1'), assistant('a2', 'Result is')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: ' forty-two.' })).toEqual({
      action: 'merge',
      index: 2
    })
  })

  it('treats a non-superset increment after a tool as a new segment, not a restatement', () => {
    const messages = [assistant('a1', 'Reading the file.'), tool('t1')]
    // Brand-new prose that does not extend the prior bubble → seal, append.
    expect(resolveAssistantDeltaTarget(messages, { incoming: 'The file says X.' })).toEqual({
      action: 'append'
    })
  })

  it('stops at a user/error boundary when scanning for a cumulative target', () => {
    const messages: ChatMessage[] = [
      assistant('a1', 'Old turn'),
      { id: 'u1', role: 'user', content: 'next question', timestamp: NOW },
      tool('t1')
    ]
    // The only assistant is behind a user message — do not reach across it.
    expect(
      resolveAssistantDeltaTarget(messages, { incoming: 'anything', cumulative: true })
    ).toEqual({ action: 'append' })
  })

  describe('trusted-incremental lane (run-item sidecar deltas)', () => {
    it('does not misread a post-burst increment that supersets the pre-burst text', () => {
      // Pre-burst bubble "Done. ", tool burst, then a genuine post-burst chunk
      // that HAPPENS to start with the same prose. The untagged-superset
      // heuristic would classify it as a restatement and strip/skip the
      // overlap; on the trusted lane an untagged delta is a verbatim
      // increment, so it opens the post-burst segment whole.
      const messages = [assistant('a1', 'Done. '), tool('t1')]
      expect(
        resolveAssistantDeltaTarget(messages, {
          incoming: 'Done. All checks passed.',
          trustedIncremental: true
        })
      ).toEqual({ action: 'append' })
    })

    it('does not swallow a post-burst repeat equal to the pre-burst text', () => {
      // Same shape as the swallow: incoming === preBurst → tail '' → the
      // untagged heuristic returned skip. Trusted increments must append.
      const messages = [assistant('a1', 'ok'), tool('t1')]
      expect(
        resolveAssistantDeltaTarget(messages, { incoming: 'ok', trustedIncremental: true })
      ).toEqual({ action: 'append' })
    })

    it('still distributes an explicitly tagged cumulative restatement', () => {
      // The tag wins over the lane hint: whole-turn restatement spanning the
      // tool boundary distributes only its post-tool tail.
      const messages = [assistant('a1', 'Intro.'), tool('t1')]
      expect(
        resolveAssistantDeltaTarget(messages, {
          incoming: 'Intro. Tail after tool.',
          cumulative: true,
          trustedIncremental: true
        })
      ).toEqual({ action: 'appendText', text: ' Tail after tool.' })
    })
  })
})

describe('spanTrailingSystemCards (complete-event dedupe across a tail system card)', () => {
  const asst = (id: string, content: string): ChatMessage => ({
    id,
    role: 'assistant',
    content,
    timestamp: '2026-07-10T00:00:00.000Z'
  })
  const tool = (id: string): ChatMessage => ({
    id,
    role: 'tool',
    content: '',
    timestamp: '2026-07-10T00:00:00.000Z',
    toolActivities: [
      {
        id: `${id}-act`,
        toolName: 'read_file',
        displayName: 'Read',
        category: 'read',
        status: 'success'
      } as never
    ]
  })
  const sys = (id: string, content = 'Message queued for after this run.'): ChatMessage => ({
    id,
    role: 'system',
    content,
    timestamp: '2026-07-10T00:00:00.000Z',
    metadata: { kind: 'ciNotice' } as never
  })

  it('skips a full-turn restatement whose text already streamed above the card', () => {
    const messages = [asst('a-1', 'the whole answer'), sys('s-1')]
    const target = resolveAssistantDeltaTarget(messages, {
      incoming: 'the whole answer',
      cumulative: true,
      spanTrailingSystemCards: true
    })
    expect(target).toEqual({ action: 'skip' })
  })

  it('WITHOUT the option the same shape duplicates (regression pin of the defect)', () => {
    const messages = [asst('a-1', 'the whole answer'), sys('s-1')]
    const target = resolveAssistantDeltaTarget(messages, {
      incoming: 'the whole answer',
      cumulative: true
    })
    expect(target).toEqual({ action: 'append' })
  })

  it('appends only the genuinely-new tail AFTER the card', () => {
    const messages = [asst('a-1', 'partial answer'), sys('s-1')]
    const target = resolveAssistantDeltaTarget(messages, {
      incoming: 'partial answer plus a final sentence.',
      cumulative: true,
      spanTrailingSystemCards: true
    })
    expect(target).toEqual({ action: 'appendText', text: ' plus a final sentence.' })
  })

  it('handles a tool boundary + trailing card: restatement covered by pre/post-tool bubbles skips', () => {
    const messages = [
      asst('a-1', 'before tools. '),
      tool('t-1'),
      asst('a-2', 'after tools.'),
      sys('s-1')
    ]
    const target = resolveAssistantDeltaTarget(messages, {
      incoming: 'before tools. after tools.',
      cumulative: true,
      spanTrailingSystemCards: true
    })
    expect(target).toEqual({ action: 'skip' })
  })

  it('skips a divergent (normalized) restatement instead of duplicating it', () => {
    const messages = [asst('a-1', 'the  whole   answer'), sys('s-1')]
    const target = resolveAssistantDeltaTarget(messages, {
      incoming: 'the whole answer',
      cumulative: true,
      spanTrailingSystemCards: true
    })
    expect(target).toEqual({ action: 'skip' })
  })

  it('is inert when the tail is not a system card', () => {
    const messages = [asst('a-1', 'streaming text')]
    const withOption = resolveAssistantDeltaTarget(messages, {
      incoming: 'streaming text',
      cumulative: true,
      spanTrailingSystemCards: true
    })
    const without = resolveAssistantDeltaTarget(messages, {
      incoming: 'streaming text',
      cumulative: true
    })
    expect(withOption).toEqual(without)
  })
})

describe('spanMidRunSteeringMessages (complete-event dedupe across an interjection)', () => {
  const steer = (id: string, content = 'Please also check the boundary.'): ChatMessage => ({
    id,
    role: 'user',
    content,
    timestamp: NOW,
    metadata: { kind: 'midRunSteering' }
  })

  it('skips a full envelope already rendered on both sides of the interjection', () => {
    const messages = [
      assistant('a-pre', 'Before the steer. '),
      steer('u-steer'),
      assistant('a-post', 'After the steer.')
    ]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Before the steer. After the steer.',
        cumulative: true,
        spanMidRunSteeringMessages: true
      })
    ).toEqual({ action: 'skip' })
  })

  it('replaces only the incomplete post-interjection bubble with the completed tail', () => {
    const messages = [assistant('a-pre', 'Before. '), steer('u-steer'), assistant('a-post', 'Part')]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Before. Partial tail.',
        cumulative: true,
        spanMidRunSteeringMessages: true
      })
    ).toEqual({ action: 'replaceText', index: 2, text: 'Partial tail.' })
  })

  it('does not duplicate an answer when the interjection lands after its last delta', () => {
    const messages = [assistant('a-pre', 'Complete answer.'), steer('u-steer')]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Complete answer.',
        cumulative: true,
        spanMidRunSteeringMessages: true
      })
    ).toEqual({ action: 'skip' })
  })

  it('preserves a post-interjection tool boundary and appends only the new tail', () => {
    const messages = [
      assistant('a-pre', 'Before. '),
      steer('u-steer'),
      assistant('a-post', 'Checking. '),
      tool('t-post')
    ]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Before. Checking. Finished.',
        cumulative: true,
        spanMidRunSteeringMessages: true
      })
    ).toEqual({ action: 'appendText', text: 'Finished.' })
  })

  it('uses the latest interjection boundary when more than one arrives', () => {
    const messages = [
      assistant('a-1', 'One. '),
      steer('u-1', 'First steer'),
      assistant('a-2', 'Two. '),
      steer('u-2', 'Second steer'),
      assistant('a-3', 'Three.')
    ]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'One. Two. Three.',
        cumulative: true,
        spanMidRunSteeringMessages: true
      })
    ).toEqual({ action: 'skip' })
  })

  it('keeps an ordinary user message as a hard provider-turn boundary', () => {
    const messages: ChatMessage[] = [
      assistant('a-old', 'Old answer.'),
      { id: 'u-ordinary', role: 'user', content: 'New turn', timestamp: NOW },
      assistant('a-new', 'New answer')
    ]
    expect(
      resolveAssistantDeltaTarget(messages, {
        incoming: 'Old answer.New answer',
        cumulative: true,
        spanMidRunSteeringMessages: true
      })
    ).toEqual({ action: 'merge', index: 2 })
  })

  it('leaves streamed-delta routing chronological when the option is absent', () => {
    const messages = [assistant('a-pre', 'Before.'), steer('u-steer')]
    expect(resolveAssistantDeltaTarget(messages, { incoming: 'After.' })).toEqual({
      action: 'append'
    })
  })
})
