import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../main/store/types'
import {
  ensembleSideMessageBody,
  ensembleSideMessageRoute,
  type EnsembleSideMessageRoster
} from './ensembleSideMessage'

/** The exact shape `EnsembleOrchestrator.sendSideMessageForRun` persists. */
function sideMessage(metadata: NonNullable<ChatMessage['metadata']>, content: string): ChatMessage {
  return {
    id: 'ensemble-side-message-r1-1-1',
    role: 'system',
    content,
    timestamp: '2026-09-09T01:03:00.000Z',
    metadata: { kind: 'ensembleSideMessage', ...metadata }
  }
}

const roster: EnsembleSideMessageRoster = {
  participants: [
    { id: 'p-boss', order: 1 },
    { id: 'p-capt', order: 2 },
    { id: 'p-work3', order: 3, stageRole: 'worker', model: 'kimi-k2' },
    { id: 'p-review2', order: 4, stageRole: 'reviewer' }
  ],
  bossmanParticipantId: 'p-boss',
  captainParticipantIds: ['p-capt']
}

describe('ensembleSideMessageRoute', () => {
  it('reads the route off metadata rather than the prose it duplicates', () => {
    const route = ensembleSideMessageRoute(
      sideMessage(
        {
          fromParticipantId: 'p-boss',
          fromProvider: 'codex',
          fromRole: 'Boss',
          toParticipantIds: ['p-capt'],
          toProviders: ['claude'],
          toRoles: ['Capt']
        },
        '↪ Boss to Capt: standby authority.'
      ),
      roster
    )
    expect(route?.fromPrefix).toBe(false)
    expect(route?.from.label).toBe('#1 Boss')
    expect(route?.from.provider).toBe('codex')
    expect(route?.to.map((party) => party.label)).toEqual(['#2 Capt'])
    expect(route?.to[0]?.provider).toBe('claude')
    expect(route?.toUser).toBe(false)
  })

  it('resolves authority and stage glyphs by participant id, not by role name', () => {
    // "Boss" as a ROLE STRING must not earn a crown: authority is chat-level,
    // and a seat a user happened to name "Boss" is not the Boss.
    const route = ensembleSideMessageRoute(
      sideMessage(
        {
          fromParticipantId: 'p-boss',
          fromProvider: 'codex',
          fromRole: 'Boss',
          toParticipantIds: ['p-capt', 'p-work3', 'p-review2'],
          toProviders: ['claude', 'kimi', 'cursor'],
          toRoles: ['Boss', 'Work3', 'Review2']
        },
        '↪ Boss to Boss, Work3, Review2: wave 7.'
      ),
      roster
    )
    expect(route?.from.authority).toBe('boss')
    expect(route?.to[0]?.authority).toBe('captain')
    expect(route?.to[1]?.authority).toBeUndefined()
    expect(route?.to[1]?.stageRole).toBe('worker')
    expect(route?.to[2]?.stageRole).toBe('reviewer')
  })

  it('carries the brand model so an Ollama seat keeps its upstream hue', () => {
    const route = ensembleSideMessageRoute(
      sideMessage(
        {
          fromParticipantId: 'p-boss',
          fromProvider: 'ollama',
          fromRole: 'Boss',
          ensembleModel: 'qwen3:32b',
          toParticipantIds: ['p-work3'],
          toProviders: ['ollama'],
          toRoles: ['Work3']
        },
        '↪ Boss to Work3: ok.'
      ),
      roster
    )
    // The sender's comes off the row it was written with; a recipient has no
    // snapshot, so the live roster is the only source there.
    expect(route?.from.brandModel).toBe('qwen3:32b')
    expect(route?.to[0]?.brandModel).toBe('kimi-k2')
  })

  it('keeps the user out of the recipient parties and flags the audience instead', () => {
    const route = ensembleSideMessageRoute(
      sideMessage(
        {
          fromParticipantId: 'p-work3',
          fromProvider: 'kimi',
          fromRole: 'Work3',
          toUser: true,
          toParticipantIds: [],
          toProviders: [],
          toRoles: []
        },
        '↪ Work3 to User: lane complete.'
      ),
      roster
    )
    expect(route?.toUser).toBe(true)
    expect(route?.to).toEqual([])
  })

  it('names a seat with no role by its provider, leaving the label for the renderer', () => {
    const route = ensembleSideMessageRoute(
      sideMessage(
        {
          fromParticipantId: 'p-boss',
          fromProvider: 'codex',
          fromRole: '',
          toParticipantIds: ['p-capt'],
          toProviders: ['claude'],
          toRoles: ['']
        },
        '↪ Codex to Claude: ok.'
      ),
      roster
    )
    // An empty label is the signal that only renderer-owned provider naming
    // can finish it — NOT "#2", which would name a seat with no name.
    expect(route?.from.label).toBe('')
    expect(route?.from.provider).toBe('codex')
    expect(route?.to[0]?.label).toBe('')
    expect(route?.to[0]?.provider).toBe('claude')
  })

  it('counts recipients off the longest list a row carries', () => {
    // A row written before roles were stamped carries providers and ids only.
    const route = ensembleSideMessageRoute(
      sideMessage(
        {
          fromParticipantId: 'p-boss',
          fromProvider: 'codex',
          fromRole: 'Boss',
          toParticipantIds: ['p-capt', 'p-work3'],
          toProviders: ['claude', 'kimi']
        },
        '↪ Boss to Capt, Work3: ok.'
      ),
      roster
    )
    expect(route?.to).toHaveLength(2)
    expect(route?.to.map((party) => party.seatNumber)).toEqual([2, 3])
  })

  it("falls back to the row's own seat identity when the send fields are absent", () => {
    // Every ensemble row carries `ensembleParticipantId`/`ensembleRole`/
    // `ensembleProvider`; the `from*` trio arrived with the routing metadata.
    // A note written before it still names a real seat.
    const route = ensembleSideMessageRoute(
      sideMessage(
        {
          ensembleParticipantId: 'p-capt',
          ensembleProvider: 'claude',
          ensembleRole: 'Capt',
          toUser: true,
          toParticipantIds: []
        },
        '↪ Capt to User: check this first.'
      ),
      roster
    )
    expect(route?.fromPrefix).toBe(false)
    expect(route?.from.label).toBe('#2 Capt')
    expect(route?.from.authority).toBe('captain')
    expect(route?.toUser).toBe(true)
  })

  it('falls back to the prose prefix for a row persisted before the metadata', () => {
    const route = ensembleSideMessageRoute(
      sideMessage({}, '↪ Boss to User, Capt, Work3: catch-up.'),
      roster
    )
    expect(route?.fromPrefix).toBe(true)
    expect(route?.from.label).toBe('Boss')
    expect(route?.toUser).toBe(true)
    expect(route?.to.map((party) => party.label)).toEqual(['Capt', 'Work3'])
    // Prose records a label and nothing else — inventing an ordinal from a
    // name match would be a claim the row never made.
    expect(route?.to[0]?.seatNumber).toBeUndefined()
  })

  it('returns null for a row that is not an inter-seat note, and for an unparseable one', () => {
    const notASideMessage: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '↪ Boss to Capt: this is an ordinary assistant turn.',
      timestamp: '2026-09-09T01:03:00.000Z'
    }
    expect(ensembleSideMessageRoute(notASideMessage, roster)).toBeNull()
    expect(ensembleSideMessageRoute(sideMessage({}, 'no prefix at all'), roster)).toBeNull()
    expect(ensembleSideMessageRoute(null, roster)).toBeNull()
  })

  it('does not promote a tool row on metadata alone', () => {
    const toolRow: ChatMessage = {
      id: 'm2',
      role: 'tool',
      content: '↪ Boss to Capt: hi.',
      timestamp: '2026-09-09T01:03:00.000Z',
      metadata: { kind: 'ensembleSideMessage', fromRole: 'Boss', toRoles: ['Capt'] }
    }
    expect(ensembleSideMessageRoute(toolRow, roster)).toBeNull()
  })
})

describe('ensembleSideMessageBody', () => {
  it('lifts the routing prefix and the reason line out of the note', () => {
    const result = ensembleSideMessageBody(
      sideMessage(
        { fromRole: 'Boss', toRoles: ['Capt'], reason: 'Bring the seat up to date.' },
        '↪ Boss to Capt: standby authority.\nReason: Bring the seat up to date.'
      )
    )
    expect(result.body).toBe('standby authority.')
    expect(result.reason).toBe('Bring the seat up to date.')
  })

  it('leaves the prefix alone when its sender half disagrees with the row', () => {
    // A role containing the separators makes the lazy match land in the wrong
    // place. Redundant text costs the reader a line; a truncated body costs
    // them the note.
    const result = ensembleSideMessageBody(
      sideMessage(
        { fromRole: 'Ops: escalation to platform', toRoles: ['Capt'] },
        '↪ Ops: escalation to platform to Capt: page the on-call.'
      )
    )
    expect(result.body).toBe('↪ Ops: escalation to platform to Capt: page the on-call.')
  })

  it('strips on prose alone when there is no fromRole to pin it against', () => {
    const result = ensembleSideMessageBody(sideMessage({}, '↪ Boss to Capt: standby.'))
    expect(result.body).toBe('standby.')
    expect(result.reason).toBe('')
  })

  it('keeps a body that merely ends on a line beginning "Reason:"', () => {
    // Matched against `metadata.reason`, not against the word — the author's
    // own closing line is theirs.
    const result = ensembleSideMessageBody(
      sideMessage(
        { fromRole: 'Boss', toRoles: ['Capt'] },
        '↪ Boss to Capt: rejected.\nReason: this is the note, not the tool field.'
      )
    )
    expect(result.body).toBe('rejected.\nReason: this is the note, not the tool field.')
    expect(result.reason).toBe('')
  })

  it('returns the content untouched when there is no prefix to lift', () => {
    const result = ensembleSideMessageBody(sideMessage({ fromRole: 'Boss' }, 'plain body'))
    expect(result.body).toBe('plain body')
  })
})
