import { describe, expect, it } from 'vitest'
import {
  REWIND_PRESERVED_CHAT_KEYS,
  classifyRewindTarget,
  rewindRequiresCancellation,
  shouldRefireOpeningScoutFanout,
  type RewindTranscriptRow
} from './chatRewindPolicy'
import { applyChatTranscriptOps, type ChatTranscriptOp } from './chatUpdateTransport'
import type { ChatMessage } from '../main/store/types'

const row = (id: string, role: string, roundId?: string | null): RewindTranscriptRow => ({
  id,
  role,
  ...(roundId !== undefined ? { roundId } : {})
})

/** Two rounds, each opened by a user prompt and steered once mid-round. */
const twoRoundTranscript: RewindTranscriptRow[] = [
  row('u1', 'user', 'r1'),
  row('a1', 'assistant', 'r1'),
  row('u2', 'user', 'r1'),
  row('a2', 'assistant', 'r1'),
  row('u3', 'user', 'r2'),
  row('a3', 'assistant', 'r2'),
  row('u4', 'user', 'r2')
]

describe('classifyRewindTarget', () => {
  it('classifies the literal top of the transcript as chat-opening', () => {
    expect(
      classifyRewindTarget({
        messages: twoRoundTranscript,
        messageId: 'u1',
        isEnsemble: true
      })
    ).toEqual({ ok: true, kind: 'chat-opening', index: 0 })
  })

  it('does not treat a first user row that is not index 0 as chat-opening', () => {
    // A leading system row must not make the first user prompt look like the
    // top of the transcript, or a rewind would re-fire the scout wave.
    const withSystemPreamble: RewindTranscriptRow[] = [
      row('s0', 'system', 'r1'),
      ...twoRoundTranscript
    ]
    expect(
      classifyRewindTarget({
        messages: withSystemPreamble,
        messageId: 'u1',
        isEnsemble: true
      })
    ).toEqual({ ok: true, kind: 'round-opening', index: 1 })
  })

  it('classifies a later user prompt in the same round as a mid-round steer', () => {
    expect(
      classifyRewindTarget({
        messages: twoRoundTranscript,
        messageId: 'u2',
        isEnsemble: true
      })
    ).toEqual({ ok: true, kind: 'mid-round-steer', index: 2 })
  })

  it('classifies the opening prompt of a LATER round as round-opening', () => {
    // Distinct from chat-opening on purpose: this one must NOT re-fire scouts.
    expect(
      classifyRewindTarget({
        messages: twoRoundTranscript,
        messageId: 'u3',
        isEnsemble: true
      })
    ).toEqual({ ok: true, kind: 'round-opening', index: 4 })
  })

  it('does not let an earlier round make a later round-opening look like a steer', () => {
    const result = classifyRewindTarget({
      messages: twoRoundTranscript,
      messageId: 'u4',
      isEnsemble: true
    })
    expect(result).toEqual({ ok: true, kind: 'mid-round-steer', index: 6 })
  })

  it('classifies every user turn in a solo chat as solo-turn', () => {
    const solo = [row('u1', 'user'), row('a1', 'assistant'), row('u2', 'user')]
    const userRows = solo.filter((message) => message.role === 'user')
    // Guard against a vacuous pass: the filter must actually have found rows.
    expect(userRows.length).toBe(2)
    for (const message of userRows) {
      expect(
        classifyRewindTarget({ messages: solo, messageId: message.id, isEnsemble: false })
      ).toMatchObject({ ok: true, kind: 'solo-turn' })
    }
  })

  it('treats the first un-rounded user prompt as chat-opening', () => {
    const legacy = [row('u1', 'user'), row('a1', 'assistant'), row('u2', 'user')]
    expect(classifyRewindTarget({ messages: legacy, messageId: 'u1', isEnsemble: true })).toEqual({
      ok: true,
      kind: 'chat-opening',
      index: 0
    })
    expect(classifyRewindTarget({ messages: legacy, messageId: 'u2', isEnsemble: true })).toEqual({
      ok: true,
      kind: 'mid-round-steer',
      index: 2
    })
  })

  it('rejects an unknown message id', () => {
    expect(
      classifyRewindTarget({
        messages: twoRoundTranscript,
        messageId: 'nope',
        isEnsemble: true
      })
    ).toEqual({ ok: false, reason: 'not-found' })
  })

  it('rejects a non-user row so an assistant answer can never be rewritten', () => {
    expect(
      classifyRewindTarget({
        messages: twoRoundTranscript,
        messageId: 'a1',
        isEnsemble: true
      })
    ).toEqual({ ok: false, reason: 'not-user-message' })
  })
})

const ALL_REWIND_KINDS = ['chat-opening', 'round-opening', 'mid-round-steer', 'solo-turn'] as const

describe('shouldRefireOpeningScoutFanout', () => {
  it('re-fires the scout wave for a corrected chat-opening prompt', () => {
    expect(shouldRefireOpeningScoutFanout('chat-opening', true)).toBe(true)
  })

  it('does NOT re-fire the scout wave for a later round-opening prompt', () => {
    // Contract v1.1 narrowing: the exception is the top of the transcript only.
    // Re-scouting a later round discards correct work done under a premise
    // that still holds.
    expect(shouldRefireOpeningScoutFanout('round-opening', true)).toBe(false)
  })

  it('never re-fires the scout wave for a mid-round steer', () => {
    expect(shouldRefireOpeningScoutFanout('mid-round-steer', true)).toBe(false)
  })

  it('never re-fires the scout wave for a solo turn', () => {
    expect(shouldRefireOpeningScoutFanout('solo-turn', true)).toBe(false)
  })

  it('re-fires for exactly one kind, so the policy cannot silently widen', () => {
    const refiring = ALL_REWIND_KINDS.filter((kind) => shouldRefireOpeningScoutFanout(kind, true))
    expect(refiring).toEqual(['chat-opening'])
  })

  it('never turns fan-out on for a chat that has it disabled', () => {
    // Anti-vacuity: assert the collection is populated before asserting over it.
    expect(ALL_REWIND_KINDS.length).toBe(4)
    for (const kind of ALL_REWIND_KINDS) {
      expect(shouldRefireOpeningScoutFanout(kind, false)).toBe(false)
    }
  })
})

describe('rewind lifecycle invariants', () => {
  it('always requires cancellation, so no in-flight run can append into the cut tail', () => {
    expect(ALL_REWIND_KINDS.length).toBe(4)
    for (const kind of ALL_REWIND_KINDS) {
      expect(rewindRequiresCancellation(kind)).toBe(true)
    }
  })

  it('names the chat state a rewind must preserve, including the blackboard host', () => {
    // `ensemble` carries `ensemble.blackboard`; the /clear truncation path drops
    // all of these, which is why a rewind must never reuse it.
    expect(REWIND_PRESERVED_CHAT_KEYS.length).toBeGreaterThan(0)
    expect([...REWIND_PRESERVED_CHAT_KEYS]).toEqual([
      'ensemble',
      'activeGoal',
      'chatTodos',
      'roundSummaries',
      'escalationSignals'
    ])
  })
})

const message = (id: string, role: ChatMessage['role'], content: string): ChatMessage =>
  ({ id, role, content }) as ChatMessage

/** user prompt, its answer, a steer, and two trailing assistant rows. */
const transcript = (): ChatMessage[] => [
  message('u1', 'user', 'original prompt'),
  message('a1', 'assistant', 'first answer'),
  message('u2', 'user', 'steer'),
  message('a2', 'assistant', 'second answer'),
  message('a3', 'assistant', 'third answer')
]

describe('truncateFrom transcript op', () => {
  it('drops every row after the anchor and keeps the anchor', () => {
    const after = applyChatTranscriptOps(transcript(), [{ op: 'truncateFrom', id: 'u2' }])
    expect(after).not.toBeNull()
    expect(after!.map((row) => row.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('leaves the transcript unchanged when the anchor is already last', () => {
    const before = transcript()
    const after = applyChatTranscriptOps(before, [{ op: 'truncateFrom', id: 'a3' }])
    expect(after).not.toBeNull()
    expect(after!.map((row) => row.id)).toEqual(before.map((row) => row.id))
  })

  it('truncates to a single row when the anchor is the first message', () => {
    const before = transcript()
    // Anti-vacuity: there must be a tail to remove.
    expect(before.length).toBeGreaterThan(1)
    const after = applyChatTranscriptOps(before, [{ op: 'truncateFrom', id: 'u1' }])
    expect(after!.map((row) => row.id)).toEqual(['u1'])
  })

  it('rejects an anchor that is not in the transcript', () => {
    expect(applyChatTranscriptOps(transcript(), [{ op: 'truncateFrom', id: 'nope' }])).toBeNull()
  })

  it('does not mutate the caller transcript', () => {
    const before = transcript()
    applyChatTranscriptOps(before, [{ op: 'truncateFrom', id: 'u1' }])
    expect(before.map((row) => row.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'a3'])
  })

  it('keeps its id index correct for an op applied after the truncation', () => {
    // A stale index would silently drop or misplace this append.
    const after = applyChatTranscriptOps(transcript(), [
      { op: 'truncateFrom', id: 'u2' },
      { op: 'append', messages: [message('u3', 'user', 'edited resend')] }
    ])
    expect(after!.map((row) => row.id)).toEqual(['u1', 'a1', 'u2', 'u3'])
  })

  it('lets a truncated id be re-appended, proving the dropped ids left the index', () => {
    const after = applyChatTranscriptOps(transcript(), [
      { op: 'truncateFrom', id: 'u1' },
      { op: 'append', messages: [message('a1', 'assistant', 'fresh answer')] }
    ])
    expect(after).not.toBeNull()
    expect(after!.map((row) => row.id)).toEqual(['u1', 'a1'])
    expect(after![1].content).toBe('fresh answer')
  })
})

describe('rewind op pair', () => {
  const rewind = (anchorId: string, editedContent: string): ChatTranscriptOp[] => [
    { op: 'update', id: anchorId, message: message(anchorId, 'user', editedContent) },
    { op: 'truncateFrom', id: anchorId }
  ]

  it('rewrites the anchor text and cuts the tail in one mutation', () => {
    const after = applyChatTranscriptOps(transcript(), rewind('u1', 'corrected prompt'))
    expect(after).not.toBeNull()
    expect(after!.map((row) => row.id)).toEqual(['u1'])
    expect(after![0].content).toBe('corrected prompt')
  })

  it('preserves the blackboard, goal and todos — a rewind is transcript-only', () => {
    const chat = {
      appChatId: 'chat-1',
      messages: transcript(),
      activeGoal: { id: 'goal-1', status: 'active' },
      chatTodos: [{ id: '1', content: 'step', status: 'pending' }],
      ensemble: {
        blackboard: [
          { id: 'bb-1', key: 'finding', value: 'load-bearing' },
          { id: 'bb-2', key: 'risk', value: 'keep me' }
        ]
      }
    }

    // Anti-vacuity: the state we claim survives must be non-empty to begin
    // with, and there must be a real tail to cut.
    expect(chat.ensemble.blackboard.length).toBe(2)
    expect(chat.chatTodos.length).toBeGreaterThan(0)
    expect(chat.messages.length).toBeGreaterThan(1)

    const messages = applyChatTranscriptOps(chat.messages, rewind('u1', 'corrected prompt'))
    expect(messages).not.toBeNull()
    const next = { ...chat, messages: messages! }

    expect(next.messages.map((row) => row.id)).toEqual(['u1'])
    expect(next.ensemble.blackboard).toEqual([
      { id: 'bb-1', key: 'finding', value: 'load-bearing' },
      { id: 'bb-2', key: 'risk', value: 'keep me' }
    ])
    expect(next.activeGoal).toEqual({ id: 'goal-1', status: 'active' })
    expect(next.chatTodos).toEqual([{ id: '1', content: 'step', status: 'pending' }])
  })
})
