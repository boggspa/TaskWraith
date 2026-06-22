import { describe, it, expect, beforeEach } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { applyAssistantDelta, type AssistantDeltaDeps } from './applyAssistantDelta'

// Deterministic deps so freshly-opened bubbles get stable ids/timestamps.
let idCounter = 0
const deps: AssistantDeltaDeps = {
  createMessageId: () => `gen-${++idCounter}`,
  now: () => '2020-01-01T00:00:00.000Z'
}
beforeEach(() => {
  idCounter = 0
})

function msg(
  role: ChatMessage['role'],
  content: string,
  metadata?: ChatMessage['metadata']
): ChatMessage {
  return {
    id: `seed-${role}-${content}`,
    role,
    content,
    timestamp: '2019-01-01T00:00:00.000Z',
    ...(metadata ? { metadata } : {})
  }
}
const trailing = (messages: ChatMessage[]) => messages[messages.length - 1]
const trailingAssistant = (messages: ChatMessage[]) =>
  [...messages].reverse().find((m) => m.role === 'assistant')

describe('applyAssistantDelta — basic accumulation', () => {
  it('opens a fresh assistant bubble for the first delta', () => {
    const out = applyAssistantDelta([msg('user', 'q')], { incoming: 'Hello' }, deps)
    expect(out).toHaveLength(2)
    expect(trailing(out).role).toBe('assistant')
    expect(trailing(out).content).toBe('Hello')
    expect(trailing(out).id).toBe('gen-1')
  })

  it('appends a genuine increment onto the trailing assistant bubble (byte-exact)', () => {
    let m = [msg('user', 'q')]
    m = applyAssistantDelta(m, { incoming: 'Hel' }, deps)
    m = applyAssistantDelta(m, { incoming: 'lo ' }, deps)
    m = applyAssistantDelta(m, { incoming: 'world' }, deps)
    expect(m.filter((x) => x.role === 'assistant')).toHaveLength(1)
    expect(trailing(m).content).toBe('Hello world')
  })

  it('accumulates a long increment stream byte-for-byte', () => {
    const parts = Array.from({ length: 200 }, (_, i) => `tok${i} `)
    let m: ChatMessage[] = [msg('user', 'q')]
    for (const p of parts) m = applyAssistantDelta(m, { incoming: p }, deps)
    expect(trailing(m).content).toBe(parts.join(''))
    // exactly one assistant bubble was produced for the whole turn
    expect(m.filter((x) => x.role === 'assistant')).toHaveLength(1)
  })

  it('does not mutate the input array', () => {
    const input = [msg('user', 'q'), msg('assistant', 'a')]
    const frozen = JSON.stringify(input)
    applyAssistantDelta(input, { incoming: 'b' }, deps)
    expect(JSON.stringify(input)).toBe(frozen)
  })
})

describe('applyAssistantDelta — restatement handling (Claude / Cursor)', () => {
  it('replaces (no duplication) when a cumulative-tagged frame restates the turn', () => {
    let m = [msg('user', 'q'), msg('assistant', 'Hello world')]
    m = applyAssistantDelta(m, { incoming: 'Hello world, friend', cumulative: true }, deps)
    expect(trailingAssistant(m)?.content).toBe('Hello world, friend')
    expect(m.filter((x) => x.role === 'assistant')).toHaveLength(1)
  })

  it('replaces when an untagged frame is a growing superset (Cursor snapshot)', () => {
    let m = [msg('user', 'q'), msg('assistant', 'Hello')]
    m = applyAssistantDelta(m, { incoming: 'Hello world' }, deps)
    expect(trailingAssistant(m)?.content).toBe('Hello world')
  })

  it('skips a stale shorter-prefix snapshot (out-of-order frame)', () => {
    const m0 = [msg('user', 'q'), msg('assistant', 'Hello world')]
    const m1 = applyAssistantDelta(m0, { incoming: 'Hello' }, deps)
    expect(m1).toBe(m0) // unchanged reference on skip
  })
})

describe('applyAssistantDelta — Codex item separator', () => {
  it('inserts a horizontal rule when a new itemId continues the same bubble', () => {
    let m = [msg('user', 'q')]
    m = applyAssistantDelta(m, { incoming: 'Body text', itemId: 'item-1' }, deps)
    m = applyAssistantDelta(m, { incoming: 'Summary text', itemId: 'item-2' }, deps)
    expect(trailing(m).content).toBe('Body text\n\n---\n\nSummary text')
    expect(trailing(m).metadata?.codexItemId).toBe('item-2')
  })

  it('does not insert a separator within the same item', () => {
    let m = [msg('user', 'q')]
    m = applyAssistantDelta(m, { incoming: 'Body ', itemId: 'item-1' }, deps)
    m = applyAssistantDelta(m, { incoming: 'continues', itemId: 'item-1' }, deps)
    expect(trailing(m).content).toBe('Body continues')
  })
})

describe('applyAssistantDelta — tool-boundary interleaving', () => {
  it('opens a NEW bubble after a tool burst rather than merging back', () => {
    const m0 = [msg('user', 'q'), msg('assistant', 'before'), msg('tool', '[tool]')]
    const m1 = applyAssistantDelta(m0, { incoming: 'after' }, deps)
    expect(m1).toHaveLength(4)
    expect(trailing(m1).role).toBe('assistant')
    expect(trailing(m1).content).toBe('after')
    // the pre-tool bubble is untouched
    expect(m1[1].content).toBe('before')
  })

  it('distributes only the post-tool tail of a restatement (appendText)', () => {
    const m0 = [msg('user', 'q'), msg('assistant', 'Hello '), msg('tool', '[tool]')]
    const m1 = applyAssistantDelta(m0, { incoming: 'Hello world', cumulative: true }, deps)
    expect(m1).toHaveLength(4)
    expect(m1[1].content).toBe('Hello ') // pre-tool prose never rewritten
    expect(trailing(m1).content).toBe('world') // only the tail placed
  })

  it('replaces the post-tool bubble with the tail (replaceText), idempotently', () => {
    const base = [
      msg('user', 'q'),
      msg('assistant', 'Hello '),
      msg('tool', '[tool]'),
      msg('assistant', 'wor')
    ]
    const m1 = applyAssistantDelta(base, { incoming: 'Hello world', cumulative: true }, deps)
    expect(trailing(m1).content).toBe('world')
    // a second identical restatement is a no-op (idempotent skip)
    const m2 = applyAssistantDelta(m1, { incoming: 'Hello world', cumulative: true }, deps)
    expect(m2).toBe(m1)
  })
})
