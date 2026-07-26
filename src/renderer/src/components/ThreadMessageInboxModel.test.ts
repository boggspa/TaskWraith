import { describe, expect, it } from 'vitest'
import {
  MAX_THREAD_MESSAGE_BADGE_COUNT,
  threadMessageCardModel,
  threadMessageIndicatorModel,
  type ThreadMessageCardInput
} from './ThreadMessageInboxModel'
import type { ThreadMessageInboxSummary } from '../../../shared/threadMessage'

function card(over: Partial<ThreadMessageCardInput> = {}) {
  return threadMessageCardModel({
    id: 'thread-msg-1',
    fromChatId: 'chat-a',
    fromChatTitle: 'Byte pin fix',
    origin: 'agent',
    body: 'The byte budget assertion is red on master.',
    requestedDelivery: 'queue',
    createdAt: 1_700_000_000_000,
    ...over
  })
}

function summary(over: Partial<ThreadMessageInboxSummary> = {}): ThreadMessageInboxSummary {
  return {
    toChatId: 'chat-b',
    pendingCount: 1,
    hasWakeRequest: false,
    oldestPendingAt: 1_700_000_000_000,
    senders: ['Byte pin fix'],
    ...over
  }
}

describe('threadMessageCardModel — attribution', () => {
  // THE presentation decision: a relayed message is never app-authored. Styling a
  // peer's request like a system instruction is the UI half of the same
  // prompt-injection problem the prompt block solves for the model.
  it.each([
    ['agent', 'peer-thread-agent'],
    ['user', 'peer-thread-user']
  ] as const)('attributes an %s-composed message to the peer thread', (origin, expected) => {
    expect(card({ origin }).attribution).toBe(expected)
  })

  it('never attributes a message to the system or operator', () => {
    for (const origin of ['agent', 'user'] as const) {
      const model = card({ origin })
      expect(model.attribution.startsWith('peer-thread')).toBe(true)
      expect(model.headerText).not.toMatch(/system|operator/i)
    }
  })

  // Both phrasings must name the sending thread, so a user-composed relay still
  // reads as coming from elsewhere rather than as a direct instruction here.
  it.each([
    ['agent', /Sent by the agent in “Byte pin fix”/],
    ['user', /You sent this from “Byte pin fix”/]
  ] as const)('names the sending thread for an %s message', (origin, pattern) => {
    expect(card({ origin }).headerText).toMatch(pattern)
  })
})

describe('threadMessageCardModel — the reader needs to know', () => {
  it('flags a wake request so it is visibly different from a queued note', () => {
    expect(card({ requestedDelivery: 'wake' }).requestsWake).toBe(true)
    expect(card().requestsWake).toBe(false)
  })

  // A clamped body must be marked, or the reader answers a partial message as
  // though it were whole.
  it('flags a truncated body', () => {
    expect(card({ truncated: true }).truncated).toBe(true)
    expect(card().truncated).toBe(false)
  })

  it('passes the body through unchanged, leaving rendering to the view', () => {
    const body = '```json\n{"ok":true}\n```'
    expect(card({ body }).body).toBe(body)
  })

  it.each([
    ['a blank title', { fromChatTitle: '   ' }, 'chat-a'],
    ['no title and no id', { fromChatTitle: '', fromChatId: '  ' }, 'another thread']
  ])('falls back through the sender label for %s', (_label, over, expected) => {
    expect(card(over).senderLabel).toBe(expected)
  })
})

describe('threadMessageIndicatorModel', () => {
  it('renders nothing for an empty inbox', () => {
    const model = threadMessageIndicatorModel(summary({ pendingCount: 0, senders: [] }))
    expect(model.count).toBe(0)
    expect(model.urgent).toBe(false)
    expect(model.title).toBe('No thread messages')
  })

  it('names the senders in the hover description', () => {
    const model = threadMessageIndicatorModel(
      summary({ pendingCount: 2, senders: ['Byte pin fix', 'ToS audit'] })
    )
    expect(model.title).toBe('2 thread messages from Byte pin fix, ToS audit')
    expect(model.badge).toBe('2')
  })

  it('reads correctly for a single message', () => {
    expect(threadMessageIndicatorModel(summary()).title).toBe('1 thread message from Byte pin fix')
  })

  // A wake request is the one case worth pulling the eye, since something will
  // start running.
  it('marks a wake request urgent and says so', () => {
    const model = threadMessageIndicatorModel(summary({ hasWakeRequest: true }))
    expect(model.urgent).toBe(true)
    expect(model.title).toMatch(/asks this thread to start a turn/)
  })

  it('is not urgent on a wake flag with nothing pending', () => {
    expect(
      threadMessageIndicatorModel(summary({ pendingCount: 0, hasWakeRequest: true })).urgent
    ).toBe(false)
  })

  // A runaway inbox must not stretch the sidebar row.
  it('caps the badge instead of counting up forever', () => {
    const model = threadMessageIndicatorModel(
      summary({ pendingCount: MAX_THREAD_MESSAGE_BADGE_COUNT + 5 })
    )
    expect(model.badge).toBe(`${MAX_THREAD_MESSAGE_BADGE_COUNT}+`)
    expect(model.count).toBe(MAX_THREAD_MESSAGE_BADGE_COUNT + 5)
  })

  it('survives a nonsense count without rendering a negative badge', () => {
    expect(threadMessageIndicatorModel(summary({ pendingCount: -3 })).badge).toBe('0')
  })

  it('falls back when the senders list is empty or blank', () => {
    expect(threadMessageIndicatorModel(summary({ senders: ['  '] })).title).toContain(
      'another thread'
    )
  })
})
