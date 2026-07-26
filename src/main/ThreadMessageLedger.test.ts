import { describe, expect, it } from 'vitest'
import {
  THREAD_MESSAGE_LEDGER_SCHEMA_VERSION,
  acknowledgeThreadMessagesInLedger,
  createThreadMessageId,
  emptyThreadMessageLedger,
  enqueueThreadMessageInLedger,
  normalizeThreadMessageLedger,
  pendingThreadMessageInboxes,
  purgeThreadMessageChats,
  residualThreadMessageChats,
  threadMessageInboxFor
} from './ThreadMessageLedger'
import {
  MAX_PENDING_THREAD_MESSAGES,
  createThreadMessageEvent,
  type ThreadMessageEvent
} from '../shared/threadMessage'

function message(overrides: Partial<Parameters<typeof createThreadMessageEvent>[0]> = {}) {
  const event = createThreadMessageEvent({
    id: 'msg-1',
    fromChatId: 'chat-a',
    fromChatTitle: 'Sender',
    toChatId: 'chat-b',
    origin: 'agent',
    body: 'The byte budget assertion is red on master.',
    createdAt: 1_700_000_000_000,
    ...overrides
  })
  if (!event) throw new Error('test fixture built an unroutable message')
  return event
}

function ledgerWith(...events: ThreadMessageEvent[]) {
  return events.reduce(
    (ledger, event) => enqueueThreadMessageInLedger(ledger, event).ledger,
    emptyThreadMessageLedger()
  )
}

describe('enqueueThreadMessageInLedger', () => {
  it('creates the receiving inbox on first use and reports acceptance', () => {
    const result = enqueueThreadMessageInLedger(emptyThreadMessageLedger(), message())
    expect(result.outcome).toBe('accepted')
    expect(result.inbox.pending.map((event) => event.id)).toEqual(['msg-1'])
    expect(Object.keys(result.ledger.inboxes)).toEqual(['chat-b'])
  })

  it('keeps separate inboxes per recipient', () => {
    const ledger = ledgerWith(message(), message({ id: 'msg-2', toChatId: 'chat-c' }))
    expect(threadMessageInboxFor(ledger, 'chat-b').pending).toHaveLength(1)
    expect(threadMessageInboxFor(ledger, 'chat-c').pending).toHaveLength(1)
  })

  // A refusal must be reportable: the sender needs to know its message did not
  // land, and a silent no-op is indistinguishable from a successful send.
  it('reports a duplicate rather than double-queueing it', () => {
    const ledger = ledgerWith(message())
    const repeat = enqueueThreadMessageInLedger(ledger, message())
    expect(repeat.outcome).toBe('duplicate')
    expect(repeat.ledger).toBe(ledger)
  })

  it('reports a full inbox and leaves the ledger untouched', () => {
    let ledger = emptyThreadMessageLedger()
    for (let index = 0; index < MAX_PENDING_THREAD_MESSAGES; index += 1) {
      ledger = enqueueThreadMessageInLedger(ledger, message({ id: `m-${index}` })).ledger
    }
    const overflow = enqueueThreadMessageInLedger(ledger, message({ id: 'late' }))
    expect(overflow.outcome).toBe('inbox-full')
    expect(overflow.ledger).toBe(ledger)
    expect(threadMessageInboxFor(ledger, 'chat-b').pending).toHaveLength(
      MAX_PENDING_THREAD_MESSAGES
    )
  })
})

describe('acknowledgeThreadMessagesInLedger', () => {
  it('moves delivered ids to the ledger and leaves the rest pending', () => {
    const ledger = ledgerWith(message(), message({ id: 'msg-2' }))
    const result = acknowledgeThreadMessagesInLedger(ledger, 'chat-b', ['msg-1'])
    expect(result.acknowledgedIds).toEqual(['msg-1'])
    expect(result.inbox.pending.map((event) => event.id)).toEqual(['msg-2'])
    expect(result.inbox.deliveredIds).toEqual(['msg-1'])
  })

  it.each([
    ['an unknown id', ['nope']],
    ['no ids', []],
    ['a blank id', ['  ']]
  ])('is a no-op for %s', (_label, ids) => {
    const ledger = ledgerWith(message())
    expect(acknowledgeThreadMessagesInLedger(ledger, 'chat-b', ids).ledger).toBe(ledger)
  })

  it('does not acknowledge across inboxes', () => {
    const ledger = ledgerWith(message())
    const result = acknowledgeThreadMessagesInLedger(ledger, 'chat-c', ['msg-1'])
    expect(result.acknowledgedIds).toEqual([])
    expect(threadMessageInboxFor(ledger, 'chat-b').pending).toHaveLength(1)
  })
})

describe('pendingThreadMessageInboxes', () => {
  it('lists only inboxes with undelivered messages, ordered by chat id', () => {
    let ledger = ledgerWith(
      message({ id: 'msg-1', toChatId: 'chat-c' }),
      message({ id: 'msg-2', toChatId: 'chat-b' })
    )
    ledger = acknowledgeThreadMessagesInLedger(ledger, 'chat-c', ['msg-1']).ledger
    expect(pendingThreadMessageInboxes(ledger).map((inbox) => inbox.toChatId)).toEqual(['chat-b'])
  })
})

describe('normalizeThreadMessageLedger', () => {
  it('round-trips a stored ledger', () => {
    const ledger = ledgerWith(message())
    expect(normalizeThreadMessageLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger)
  })

  it.each([
    ['a non-object', 'nope'],
    ['an array', []],
    ['null', null],
    ['an unknown schema version', { schemaVersion: 2, inboxes: {} }]
  ])('returns an empty ledger for %s', (_label, value) => {
    expect(normalizeThreadMessageLedger(value)).toEqual(emptyThreadMessageLedger())
  })

  it('drops inboxes that carry no state, so the file cannot grow one entry per chat', () => {
    const decoded = normalizeThreadMessageLedger({
      schemaVersion: THREAD_MESSAGE_LEDGER_SCHEMA_VERSION,
      inboxes: {
        'chat-b': { schemaVersion: 1, toChatId: 'chat-b', pending: [], deliveredIds: [] },
        '   ': { schemaVersion: 1, toChatId: 'x', pending: [], deliveredIds: ['kept'] },
        'chat-c': { schemaVersion: 1, toChatId: 'chat-c', pending: [], deliveredIds: ['kept'] }
      }
    })
    // chat-c is retained on its delivered ids alone: those are the exactly-once
    // guard and dropping them would let an old message be re-delivered.
    expect(Object.keys(decoded.inboxes)).toEqual(['chat-c'])
  })

  // Keys come from disk. A state-carrying inbox under a hostile key is the case
  // that separates a null-prototype map from a plain object: assigning
  // `inboxes.__proto__` on a plain object REPLACES its prototype instead of
  // storing an entry, so the inbox both vanishes and corrupts the map.
  it('stores a __proto__ key as an ordinary entry rather than a prototype', () => {
    const decoded = normalizeThreadMessageLedger({
      schemaVersion: THREAD_MESSAGE_LEDGER_SCHEMA_VERSION,
      inboxes: JSON.parse(
        '{"__proto__": {"schemaVersion": 1, "toChatId": "x", "pending": [], "deliveredIds": ["kept"]}}'
      )
    })
    expect(Object.getPrototypeOf(decoded.inboxes)).toBeNull()
    expect(Object.keys(decoded.inboxes)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).deliveredIds).toBeUndefined()
  })

  it('re-keys each inbox to its own map key, ignoring a mismatched stored id', () => {
    const decoded = normalizeThreadMessageLedger({
      schemaVersion: THREAD_MESSAGE_LEDGER_SCHEMA_VERSION,
      inboxes: {
        'chat-b': {
          schemaVersion: 1,
          toChatId: 'chat-elsewhere',
          pending: [{ ...message(), toChatId: 'chat-elsewhere' }],
          deliveredIds: []
        }
      }
    })
    expect(decoded.inboxes['chat-b'].toChatId).toBe('chat-b')
    expect(decoded.inboxes['chat-b'].pending[0].toChatId).toBe('chat-b')
  })
})

describe('purgeThreadMessageChats', () => {
  it('removes the inboxes of deleted chats', () => {
    const ledger = ledgerWith(message(), message({ id: 'msg-2', toChatId: 'chat-c' }))
    const purged = purgeThreadMessageChats(ledger, ['chat-b'])
    expect(purged.changed).toBe(true)
    expect(Object.keys(purged.ledger.inboxes)).toEqual(['chat-c'])
  })

  // A queued message names its sender. Deleting the sender must remove it, both
  // because it is that chat's content and because it would otherwise still be
  // delivered into a live thread after the sender was erased.
  it('removes pending messages sent BY a deleted chat from surviving inboxes', () => {
    const ledger = ledgerWith(message(), message({ id: 'msg-2', fromChatId: 'chat-keep' }))
    const purged = purgeThreadMessageChats(ledger, ['chat-a'])
    expect(purged.changed).toBe(true)
    expect(purged.ledger.inboxes['chat-b'].pending.map((event) => event.id)).toEqual(['msg-2'])
  })

  it('drops an inbox left with nothing after its senders are purged', () => {
    const purged = purgeThreadMessageChats(ledgerWith(message()), ['chat-a'])
    expect(Object.keys(purged.ledger.inboxes)).toEqual([])
  })

  it('retains an emptied inbox that still holds delivered ids', () => {
    let ledger = ledgerWith(message(), message({ id: 'msg-2' }))
    ledger = acknowledgeThreadMessagesInLedger(ledger, 'chat-b', ['msg-1']).ledger
    const purged = purgeThreadMessageChats(ledger, ['chat-a'])
    expect(purged.ledger.inboxes['chat-b'].pending).toEqual([])
    expect(purged.ledger.inboxes['chat-b'].deliveredIds).toEqual(['msg-1'])
  })

  // The deletion transaction re-runs every step, so a second pass must be a no-op
  // rather than a rewrite.
  it('reports no change when there is nothing to purge', () => {
    const ledger = ledgerWith(message())
    expect(purgeThreadMessageChats(ledger, ['chat-unrelated']).changed).toBe(false)
    expect(purgeThreadMessageChats(ledger, []).ledger).toBe(ledger)
    const once = purgeThreadMessageChats(ledger, ['chat-b'])
    expect(purgeThreadMessageChats(once.ledger, ['chat-b']).changed).toBe(false)
  })
})

describe('residualThreadMessageChats', () => {
  it('names both a surviving inbox and a surviving sender', () => {
    const ledger = ledgerWith(message())
    expect(residualThreadMessageChats(ledger, ['chat-a', 'chat-b'])).toEqual(['chat-a', 'chat-b'])
  })

  it('is empty once the purge has run', () => {
    const purged = purgeThreadMessageChats(ledgerWith(message()), ['chat-a', 'chat-b'])
    expect(residualThreadMessageChats(purged.ledger, ['chat-a', 'chat-b'])).toEqual([])
  })
})

describe('createThreadMessageId', () => {
  it('is stable for the same triple, so a retried send is idempotent', () => {
    expect(createThreadMessageId('chat-a', 'chat-b', 'run-1:call-1')).toBe(
      createThreadMessageId('chat-a', 'chat-b', 'run-1:call-1')
    )
  })

  it.each([
    ['sender', ['chat-z', 'chat-b', 'nonce']],
    ['recipient', ['chat-a', 'chat-z', 'nonce']],
    ['nonce', ['chat-a', 'chat-b', 'other']]
  ] as const)('changes with the %s', (_label, parts) => {
    expect(createThreadMessageId(parts[0], parts[1], parts[2])).not.toBe(
      createThreadMessageId('chat-a', 'chat-b', 'nonce')
    )
  })

  // An id survives in the delivered ledger after its chats are deleted, so it must
  // not carry their identity forward.
  it('does not embed either chat id', () => {
    const id = createThreadMessageId('chat-alpha', 'chat-beta', 'nonce')
    expect(id).not.toContain('chat-alpha')
    expect(id).not.toContain('chat-beta')
    expect(id.startsWith('thread-msg-')).toBe(true)
  })

  it('cannot be collided by moving the separator into a part', () => {
    expect(createThreadMessageId('a', 'b', 'c|d')).not.toBe(createThreadMessageId('a', 'b|c', 'd'))
  })
})
