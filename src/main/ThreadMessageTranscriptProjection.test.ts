import { describe, expect, it } from 'vitest'
import { createThreadMessageEvent } from '../shared/threadMessage'
import type { ChatMessage, ChatRecord } from './store/types'
import {
  appendThreadMessageTranscriptProjection,
  buildThreadMessageTranscriptProjection,
  isThreadMessageTranscriptProjection,
  mergeMissingThreadMessageTranscriptProjections
} from './ThreadMessageTranscriptProjection'

function event(id = 'peer-1') {
  const value = createThreadMessageEvent({
    id,
    fromChatId: 'chat-sender',
    fromChatTitle: 'Fix byte budget',
    toChatId: 'chat-recipient',
    origin: 'agent',
    body: '[Review this](https://example.test) <b>literally</b>',
    requestedDelivery: 'wake',
    createdAt: 1_700_000_000_000
  })
  if (!value) throw new Error('invalid thread-message fixture')
  return value
}

function chat(messages: ChatMessage[] = []): ChatRecord {
  return {
    appChatId: 'chat-recipient',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Recipient',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages,
    runs: []
  } as ChatRecord
}

describe('ThreadMessageTranscriptProjection', () => {
  it('builds a stable untrusted projection-only tool row without rewriting content', () => {
    const source = event()
    const projection = buildThreadMessageTranscriptProjection(source)

    expect(projection.id).toBe('thread-message-peer-1')
    expect(projection.role).toBe('tool')
    expect(projection.content).toBe(source.body)
    expect(projection.metadata).toMatchObject({
      kind: 'threadMessage',
      providerContextVisibility: 'projection-only',
      threadMessageId: 'peer-1',
      threadMessageFromChatId: 'chat-sender',
      threadMessageFromChatTitle: 'Fix byte budget',
      threadMessageOrigin: 'agent',
      threadMessageRequestedDelivery: 'wake',
      threadMessageTrust: 'untrusted-thread-message'
    })
    expect(isThreadMessageTranscriptProjection(projection)).toBe(true)
  })

  it('appends once for a retried event id', () => {
    const first = appendThreadMessageTranscriptProjection(chat(), event())
    const second = appendThreadMessageTranscriptProjection(first.chat, event())

    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.chat.messages).toHaveLength(1)
  })

  it('restores missing projections from a durable newer revision in timestamp order', () => {
    const before: ChatMessage = {
      id: 'before',
      role: 'assistant',
      content: 'Before',
      timestamp: '2023-11-14T22:00:00.000Z'
    }
    const after: ChatMessage = {
      id: 'after',
      role: 'assistant',
      content: 'After',
      timestamp: '2023-11-14T23:00:00.000Z'
    }
    const projection = buildThreadMessageTranscriptProjection(event())

    expect(mergeMissingThreadMessageTranscriptProjections([before, after], [projection])).toEqual([
      before,
      projection,
      after
    ])
    expect(
      mergeMissingThreadMessageTranscriptProjections([before, projection, after], [projection])
    ).toEqual([before, projection, after])
  })

  it('does not treat an arbitrary tool row as a protected projection', () => {
    const ordinary: ChatMessage = {
      id: 'tool-1',
      role: 'tool',
      content: 'ordinary',
      timestamp: '2026-01-01T00:00:00.000Z',
      metadata: { kind: 'threadMessage' }
    }
    expect(isThreadMessageTranscriptProjection(ordinary)).toBe(false)
    expect(mergeMissingThreadMessageTranscriptProjections([], [ordinary])).toEqual([])
  })

  it('does not let an unrelated row id suppress a missing peer projection', () => {
    const projection = buildThreadMessageTranscriptProjection(event())
    const unrelated: ChatMessage = {
      id: projection.id,
      role: 'assistant',
      content: 'Imported row with a colliding id',
      timestamp: projection.timestamp
    }

    expect(mergeMissingThreadMessageTranscriptProjections([unrelated], [projection])).toEqual([
      unrelated,
      projection
    ])
  })
})

describe('sender seat projection', () => {
  const SEAT = {
    provider: 'claude',
    model: 'claude-opus-5',
    role: 'Reviewer',
    permissionPresetId: 'full_access'
  }

  it('carries the captured seat onto the transcript row', () => {
    const event = createThreadMessageEvent({
      id: 'm-seat',
      fromChatId: 'chat-a',
      fromChatTitle: 'Byte pin fix',
      toChatId: 'chat-b',
      origin: 'agent',
      body: 'Pull master before you continue.',
      createdAt: 1_700_000_000_000,
      seat: SEAT
    })!
    const row = buildThreadMessageTranscriptProjection(event)
    expect(row.metadata?.threadMessageSeat).toEqual(SEAT)
  })

  it('omits the seat entirely when the sender had none', () => {
    const event = createThreadMessageEvent({
      id: 'm-bare',
      fromChatId: 'chat-a',
      fromChatTitle: 'Byte pin fix',
      toChatId: 'chat-b',
      origin: 'agent',
      body: 'No seat was resolvable at send time.',
      createdAt: 1_700_000_000_000
    })!
    const row = buildThreadMessageTranscriptProjection(event)
    // Absent, not null/{} — the card branches on presence to pick the
    // seatless heading, and an empty object would render an empty strip.
    expect(row.metadata).not.toHaveProperty('threadMessageSeat')
  })
})
