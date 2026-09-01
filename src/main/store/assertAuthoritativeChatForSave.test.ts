import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from './types'
import { assertAuthoritativeChatForSave } from './assertAuthoritativeChatForSave'

function message(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: `content-${id}`,
    timestamp: '2026-09-01T00:00:00.000Z'
  } as ChatMessage
}

function messages(ids: string[]): ChatMessage[] {
  return ids.map(message)
}

function chat(id: string, ids: string[]): ChatRecord {
  return {
    appChatId: id,
    provider: 'codex',
    title: id,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: messages(ids),
    runs: []
  } as ChatRecord
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f']

describe('assertAuthoritativeChatForSave', () => {
  it('admits a create (no durable record)', () => {
    expect(() => assertAuthoritativeChatForSave(chat('c1', ['a']), null)).not.toThrow()
    expect(() => assertAuthoritativeChatForSave(chat('c1', ['a']), undefined)).not.toThrow()
  })

  it('admits a full id match (in-place update)', () => {
    expect(() => assertAuthoritativeChatForSave(chat('c1', IDS), chat('c1', IDS))).not.toThrow()
  })

  it('admits prefix + append', () => {
    expect(() =>
      assertAuthoritativeChatForSave(chat('c1', [...IDS, 'g', 'h']), chat('c1', IDS))
    ).not.toThrow()
  })

  it('admits a stale-revision full array (a prefix of the durable record)', () => {
    expect(() =>
      assertAuthoritativeChatForSave(chat('c1', ['a', 'b', 'c']), chat('c1', IDS))
    ).not.toThrow()
  })

  it('admits a mid-record delete-by-ID (non-contiguous remainder)', () => {
    expect(() =>
      assertAuthoritativeChatForSave(chat('c1', ['a', 'b', 'e', 'f']), chat('c1', IDS))
    ).not.toThrow()
  })

  it('admits a full clear (truncate-chat)', () => {
    expect(() => assertAuthoritativeChatForSave(chat('c1', []), chat('c1', IDS))).not.toThrow()
  })

  it('admits a full replacement whose first id is unknown to the durable record', () => {
    expect(() =>
      assertAuthoritativeChatForSave(chat('c1', ['x', 'y']), chat('c1', IDS))
    ).not.toThrow()
  })

  it('admits a contiguous prefix delete when it carries authored ID ops', () => {
    expect(() =>
      assertAuthoritativeChatForSave(chat('c1', ['c', 'd', 'e', 'f']), chat('c1', IDS), {
        authoredTranscript: { version: 1, ops: [] }
      })
    ).not.toThrow()
  })

  it('rejects a tail page (durable prefix would be dropped)', () => {
    expect(() =>
      assertAuthoritativeChatForSave(chat('c1', ['d', 'e', 'f']), chat('c1', IDS))
    ).toThrow(/windowed transcript page/)
  })

  it('rejects a middle page', () => {
    expect(() => assertAuthoritativeChatForSave(chat('c1', ['c', 'd']), chat('c1', IDS))).toThrow(
      /windowed transcript page/
    )
  })

  it('rejects a page with newer appends (still drops the durable prefix)', () => {
    expect(() =>
      assertAuthoritativeChatForSave(chat('c1', ['e', 'f', 'g']), chat('c1', IDS))
    ).toThrow(/windowed transcript page/)
  })

  it('admits when the overlap diverges (not a clean window)', () => {
    const incoming = chat('c1', ['c', 'd', 'e', 'f'])
    incoming.messages[1] = message('d2')
    expect(() => assertAuthoritativeChatForSave(incoming, chat('c1', IDS))).not.toThrow()
  })
})
