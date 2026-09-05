import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import type { SeatChangePayload } from '../../../shared/seatChange'
import { adjacentSeatChangeStacks, transcriptSpeakerContinuations } from './transcriptEventLayout'

const message = (id: string, role: ChatMessage['role'], runId?: string): ChatMessage => ({
  id,
  role,
  runId,
  content: id,
  timestamp: '2026-09-05T14:00:00Z'
})
const rows = (messages: ChatMessage[]) => messages.map((msg) => ({ msg, rowKey: msg.id }))
const activity = {
  id: 't',
  toolName: 'read_file',
  displayName: 'Read file',
  category: 'read' as const,
  status: 'success' as const
}
const tool = (id: string, runId: string): ChatMessage => ({
  ...message(id, 'tool', runId),
  toolActivities: [activity]
})
const seat = (id: string, change: Partial<SeatChangePayload> = {}): ChatMessage => ({
  ...message(id, 'system'),
  metadata: {
    seatChange: {
      participantId: id,
      label: id,
      before: { provider: 'codex', model: 'old' },
      after: { provider: 'codex', model: 'new' },
      appliedAt: '2026-09-05T14:00:00Z',
      ...change
    }
  }
})

describe('transcript speaker headings', () => {
  it('labels the first event and suppresses subsequent prose and thinking/tool headers', () => {
    const messages = [
      tool('thinking', 'run-a'),
      {
        ...message('prose', 'assistant', 'run-a'),
        metadata: {
          ensembleProvider: 'codex',
          ensembleParticipantId: 'a',
          ensembleRole: 'Builder',
          ensembleModel: 'model'
        }
      },
      tool('tools', 'run-a'),
      message('answer', 'assistant', 'run-a')
    ]
    expect([...transcriptSpeakerContinuations(rows(messages), [], new Set())]).toEqual([
      'prose',
      'tools',
      'answer'
    ])
  })

  it('starts a new heading for a different seat, a returning speaker, or another run', () => {
    const messages = [
      message('a', 'assistant', 'a'),
      message('b', 'assistant', 'b'),
      message('a again', 'assistant', 'a'),
      message('new turn', 'assistant', 'a2')
    ]
    expect(transcriptSpeakerContinuations(rows(messages), [], new Set()).size).toBe(0)
  })

  it('distinguishes legacy same-provider participants and resets after user input', () => {
    const a = {
      ...message('a', 'assistant'),
      metadata: { ensembleProvider: 'codex', ensembleParticipantId: 'a' }
    }
    const b = { ...a, id: 'b', metadata: { ...a.metadata, ensembleParticipantId: 'b' } }
    const messages = [a, { ...a, id: 'a2' }, b, message('user', 'user'), { ...b, id: 'b2' }]
    expect([...transcriptSpeakerContinuations(rows(messages), [], new Set())]).toEqual(['a2'])
  })

  it('retains ownership through app notices and skips rows hidden by an existing fold', () => {
    const messages = [
      message('first', 'assistant', 'a'),
      seat('change'),
      message('hidden', 'assistant', 'b'),
      message('last', 'assistant', 'a')
    ]
    expect([...transcriptSpeakerContinuations(rows(messages), [], new Set(['hidden']))]).toEqual([
      'last'
    ])
    expect(
      transcriptSpeakerContinuations(rows(messages.slice(2)), [], new Set(['hidden'])).size
    ).toBe(0)
  })

  it('uses the visible super-group representative as the owner of a system-led fold', () => {
    const messages = [
      message('notice', 'system'),
      tool('hidden tool', 'a'),
      message('answer', 'assistant', 'a')
    ]
    expect([
      ...transcriptSpeakerContinuations(
        rows(messages),
        [],
        new Set(['hidden tool']),
        new Map([['notice', messages[1]]])
      )
    ]).toEqual(['answer'])
  })
})

describe('adjacent seat change stacks', () => {
  it('stacks seat edits, brief updates and enable/disable rows in their original order', () => {
    const messages = [
      seat('model'),
      seat('brief', { briefUpdated: true }),
      seat('enable', { enabledChangedTo: true }),
      seat('disable', { enabledChangedTo: false })
    ]
    expect([...adjacentSeatChangeStacks(messages)]).toEqual([
      ['model', 'start'],
      ['brief', 'middle'],
      ['enable', 'middle'],
      ['disable', 'end']
    ])
  })

  it('leaves single changes alone and splits at every intervening event', () => {
    const messages = [
      seat('single'),
      message('notice', 'system'),
      seat('a'),
      seat('b'),
      message('answer', 'assistant'),
      seat('last')
    ]
    expect([...adjacentSeatChangeStacks(messages)]).toEqual([
      ['a', 'start'],
      ['b', 'end']
    ])
  })

  it('updates the old tail position when a new update joins without changing message identity', () => {
    const a = seat('a'),
      b = seat('b'),
      c = seat('c')
    expect(adjacentSeatChangeStacks([a, b]).get('b')).toBe('end')
    expect(adjacentSeatChangeStacks([a, b, c]).get('b')).toBe('middle')
    expect(b.id).toBe('b')
  })
})
