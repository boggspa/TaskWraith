import { describe, expect, it } from 'vitest'
import {
  MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS,
  MAX_THREAD_MESSAGE_CHARS,
  THREAD_MESSAGE_SCHEMA_VERSION,
  acknowledgeThreadMessages,
  createThreadMessageEvent,
  emptyThreadMessageInbox,
  enqueueThreadMessage,
  normalizeThreadMessageInbox,
  pendingThreadMessages,
  summarizeThreadMessageInbox
} from './threadMessage'

const CTRL = (code: number): string => String.fromCharCode(code)

const BASE = {
  id: 'msg-1',
  fromChatId: 'chat-a',
  fromChatTitle: 'Provider ToS audit',
  toChatId: 'chat-b',
  origin: 'agent' as const,
  body: 'The byte budget assertion is red on master.',
  createdAt: 1_700_000_000_000
}

const event = (overrides: Partial<typeof BASE> = {}) =>
  createThreadMessageEvent({ ...BASE, ...overrides })

describe('createThreadMessageEvent', () => {
  it('builds a queued, untrusted message by default', () => {
    expect(event()).toMatchObject({
      id: 'msg-1',
      schemaVersion: THREAD_MESSAGE_SCHEMA_VERSION,
      fromChatId: 'chat-a',
      toChatId: 'chat-b',
      origin: 'agent',
      requestedDelivery: 'queue',
      trust: 'untrusted-thread-message'
    })
  })

  // The sender must not be able to relabel its own message as trusted content —
  // that is the whole point of the marker.
  it('ignores any caller-supplied trust or schema fields', () => {
    const built = createThreadMessageEvent({
      ...BASE,
      // @ts-expect-error deliberately passing fields the input type forbids
      trust: 'operator',
      schemaVersion: 99
    })
    expect(built?.trust).toBe('untrusted-thread-message')
    expect(built?.schemaVersion).toBe(THREAD_MESSAGE_SCHEMA_VERSION)
  })

  // A malformed or hostile record must land on the SAFE side of both switches:
  // 'agent' is the gated origin, 'queue' is the delivery that cannot run a turn.
  it.each([undefined, null, 'operator', 'system', 42])(
    'defaults an unrecognised origin (%j) to the gated agent path',
    (origin) => {
      // @ts-expect-error exercising untrusted input
      expect(event({ origin })?.origin).toBe('agent')
    }
  )

  it.each([undefined, null, 'run', 'interrupt', true])(
    'defaults an unrecognised delivery (%j) to queue, never wake',
    (requestedDelivery) => {
      // @ts-expect-error exercising untrusted input
      expect(event({ requestedDelivery })?.requestedDelivery).toBe('queue')
    }
  )

  it('preserves an explicit wake REQUEST without acting on it', () => {
    expect(event({ requestedDelivery: 'wake' })?.requestedDelivery).toBe('wake')
  })

  // Self-messaging would let a seat inject into its own context through a path
  // the user cannot recognise as self-authored.
  it('refuses a message a chat sends to itself', () => {
    expect(event({ toChatId: BASE.fromChatId })).toBeNull()
  })

  it.each([
    ['no id', { id: '   ' }],
    ['no origin chat', { fromChatId: '' }],
    ['no destination', { toChatId: '' }],
    ['an empty body', { body: '   ' }],
    ['a body of only control characters', { body: `${CTRL(0)}${CTRL(1)}${CTRL(127)}` }]
  ])('refuses %s', (_label, overrides) => {
    expect(event(overrides)).toBeNull()
  })

  it('strips control characters from the body but keeps its newlines', () => {
    const built = event({ body: `line one${CTRL(0)}${CTRL(31)}${CTRL(127)}\nline two` })
    expect(built?.body).toBe('line one\nline two')
  })

  // Newlines and tabs are whitespace and collapse to one space; other control
  // characters are deleted rather than becoming a space, so they cannot invent a
  // word break inside a word ("a<NUL>b" is "ab", not "a b").
  it('flattens and truncates the display title without rejecting it', () => {
    const built = event({ fromChatTitle: `a${CTRL(0)}b\nc\t  d${'x'.repeat(300)}` })
    expect(built?.fromChatTitle.length).toBeLessThanOrEqual(120)
    expect(built?.fromChatTitle).not.toMatch(new RegExp(`[\\n\\t${CTRL(0)}]`))
    expect(built?.fromChatTitle.startsWith('ab c d')).toBe(true)
  })

  it('clamps an over-long body and marks it truncated', () => {
    const built = event({ body: 'y'.repeat(MAX_THREAD_MESSAGE_CHARS + 500) })
    expect(built?.body.length).toBeLessThanOrEqual(MAX_THREAD_MESSAGE_CHARS)
    expect(built?.truncated).toBe(true)
    expect(built?.body).toContain('[truncated by TaskWraith]')
  })

  it('does not mark an in-budget body as truncated', () => {
    expect(event().truncated).toBeUndefined()
  })
})

describe('enqueueThreadMessage', () => {
  it('appends in order', () => {
    let inbox = emptyThreadMessageInbox('chat-b')
    inbox = enqueueThreadMessage(inbox, event()!)
    inbox = enqueueThreadMessage(inbox, event({ id: 'msg-2' })!)
    expect(inbox.pending.map((entry) => entry.id)).toEqual(['msg-1', 'msg-2'])
  })

  it('is idempotent on id, so a retried send cannot double-deliver', () => {
    let inbox = emptyThreadMessageInbox('chat-b')
    inbox = enqueueThreadMessage(inbox, event()!)
    inbox = enqueueThreadMessage(inbox, event()!)
    expect(inbox.pending).toHaveLength(1)
  })

  // The ledger is the exactly-once guard: a resend of something already consumed
  // must not reappear in the target's context.
  it('refuses a message already recorded as delivered', () => {
    let inbox = enqueueThreadMessage(emptyThreadMessageInbox('chat-b'), event()!)
    inbox = acknowledgeThreadMessages(inbox, ['msg-1'])
    inbox = enqueueThreadMessage(inbox, event()!)
    expect(inbox.pending).toHaveLength(0)
    expect(inbox.deliveredIds).toEqual(['msg-1'])
  })

  it('refuses a message addressed to a different chat', () => {
    const inbox = enqueueThreadMessage(
      emptyThreadMessageInbox('chat-b'),
      event({ toChatId: 'chat-c' })!
    )
    expect(inbox.pending).toHaveLength(0)
  })
})

describe('acknowledgeThreadMessages', () => {
  it('moves acknowledged ids to the ledger and leaves the rest pending', () => {
    let inbox = emptyThreadMessageInbox('chat-b')
    inbox = enqueueThreadMessage(inbox, event()!)
    inbox = enqueueThreadMessage(inbox, event({ id: 'msg-2' })!)
    inbox = acknowledgeThreadMessages(inbox, ['msg-1'])
    expect(pendingThreadMessages(inbox).map((entry) => entry.id)).toEqual(['msg-2'])
    expect(inbox.deliveredIds).toEqual(['msg-1'])
  })

  it.each([[[]], [['unknown-id']]])('is a no-op for %j', (ids) => {
    const inbox = enqueueThreadMessage(emptyThreadMessageInbox('chat-b'), event()!)
    expect(acknowledgeThreadMessages(inbox, ids)).toBe(inbox)
  })

  it('bounds the ledger so a long-lived chat cannot grow it forever', () => {
    let inbox = emptyThreadMessageInbox('chat-b')
    const total = MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS + 20
    for (let index = 0; index < total; index += 1) {
      inbox = enqueueThreadMessage(inbox, event({ id: `m-${index}` })!)
      inbox = acknowledgeThreadMessages(inbox, [`m-${index}`])
    }
    expect(inbox.deliveredIds).toHaveLength(MAX_RETAINED_THREAD_MESSAGE_LEDGER_IDS)
    expect(inbox.deliveredIds.at(-1)).toBe(`m-${total - 1}`)
  })
})

describe('normalizeThreadMessageInbox', () => {
  it('round-trips a well-formed record', () => {
    const inbox = enqueueThreadMessage(emptyThreadMessageInbox('chat-b'), event()!)
    expect(normalizeThreadMessageInbox(JSON.parse(JSON.stringify(inbox)), 'chat-b')).toEqual(inbox)
  })

  it.each([
    ['a non-object', 'nope'],
    ['an array', []],
    ['null', null],
    ['an unknown schema version', { schemaVersion: 2, pending: [], deliveredIds: [] }]
  ])('returns an empty inbox for %s', (_label, value) => {
    expect(normalizeThreadMessageInbox(value, 'chat-b')).toEqual(emptyThreadMessageInbox('chat-b'))
  })

  // A persisted record must not be able to smuggle in a trusted label, a foreign
  // destination, or a duplicate id.
  it('re-derives trust and destination rather than believing the record', () => {
    const decoded = normalizeThreadMessageInbox(
      {
        toChatId: 'chat-evil',
        schemaVersion: THREAD_MESSAGE_SCHEMA_VERSION,
        deliveredIds: ['   ', 'kept'],
        pending: [
          { ...BASE, trust: 'operator', toChatId: 'chat-evil' },
          { ...BASE, trust: 'operator', toChatId: 'chat-evil' },
          { id: '', fromChatId: 'x', body: 'no id' }
        ]
      },
      'chat-b'
    )
    expect(decoded.toChatId).toBe('chat-b')
    expect(decoded.pending).toHaveLength(1)
    expect(decoded.pending[0].trust).toBe('untrusted-thread-message')
    expect(decoded.pending[0].toChatId).toBe('chat-b')
    expect(decoded.deliveredIds).toEqual(['kept'])
  })
})

describe('summarizeThreadMessageInbox', () => {
  it('reports counts, wake requests and distinct senders', () => {
    let inbox = emptyThreadMessageInbox('chat-b')
    inbox = enqueueThreadMessage(inbox, event()!)
    inbox = enqueueThreadMessage(
      inbox,
      event({ id: 'msg-2', requestedDelivery: 'wake', fromChatTitle: 'Other thread' })!
    )
    inbox = enqueueThreadMessage(inbox, event({ id: 'msg-3' })!)
    expect(summarizeThreadMessageInbox(inbox)).toEqual({
      toChatId: 'chat-b',
      pendingCount: 3,
      hasWakeRequest: true,
      oldestPendingAt: BASE.createdAt,
      senders: ['Provider ToS audit', 'Other thread']
    })
  })

  it('falls back to the chat id when a sender has no title', () => {
    const inbox = enqueueThreadMessage(
      emptyThreadMessageInbox('chat-b'),
      event({ fromChatTitle: '' })!
    )
    expect(summarizeThreadMessageInbox(inbox).senders).toEqual(['chat-a'])
  })

  it('is empty for a fresh inbox', () => {
    expect(summarizeThreadMessageInbox(emptyThreadMessageInbox('chat-b'))).toEqual({
      toChatId: 'chat-b',
      pendingCount: 0,
      hasWakeRequest: false,
      oldestPendingAt: null,
      senders: []
    })
  })
})
