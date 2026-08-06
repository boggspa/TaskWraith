import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  isLiveFanoutMessageCandidate,
  isLiveRevealMessageCandidate,
  isLiveToolMessageCandidate,
  resolveLiveFanoutMessageIds,
  resolveLiveMeasurementMessageIds,
  resolveLiveRevealMessageId,
  resolveLiveToolMessageId,
  resolveLiveToolMessageIds
} from './liveRevealMessage'

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('liveRevealMessage', () => {
  it('reveals only the final assistant-like message in a running chat', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', runId: 'run-1' }),
      msg({ id: 'tool', role: 'tool', runId: 'run-1' }),
      msg({ id: 'a2', role: 'assistant', runId: 'run-1' })
    ]

    expect(
      resolveLiveRevealMessageId(messages, {
        revealEnabled: true,
        revealChatIsRunning: true,
        revealRunId: 'run-1'
      })
    ).toBe('a2')
  })

  it('does not reveal an older assistant message just because it shares the active run id', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', runId: 'run-1' }),
      msg({ id: 'status', role: 'system', runId: 'run-1' })
    ]

    expect(
      resolveLiveRevealMessageId(messages, {
        revealEnabled: true,
        revealChatIsRunning: true,
        revealRunId: 'run-1'
      })
    ).toBeNull()
  })

  it('does not reveal generic system messages', () => {
    expect(isLiveRevealMessageCandidate(msg({ id: 's', role: 'system' }), 'run-1')).toBe(false)
  })

  it('allows guest participant replies as assistant-like transcript output', () => {
    const guest = msg({
      id: 'guest',
      role: 'tool',
      runId: 'run-1',
      metadata: { kind: 'guestParticipantReply' }
    })

    expect(isLiveRevealMessageCandidate(guest, 'run-1')).toBe(true)
  })

  it('blocks candidates from a different active run', () => {
    expect(
      isLiveRevealMessageCandidate(msg({ id: 'a', role: 'assistant', runId: 'old' }), 'new')
    ).toBe(false)
  })

  it('marks the final tool activity row as the live measurement row while a chat runs', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', runId: 'run-1' }),
      msg({
        id: 'tool',
        role: 'tool',
        runId: 'run-1',
        toolActivities: [
          {
            id: 'kimi-thinking-1',
            toolName: 'kimi_thinking',
            displayName: 'Kimi thinking',
            category: 'task',
            status: 'success',
            resultSummary: 'streamed reasoning chunk'
          }
        ]
      })
    ]

    expect(
      resolveLiveToolMessageId(messages, {
        revealChatIsRunning: true,
        revealRunId: 'run-1'
      })
    ).toBe('tool')
  })

  it('does not mark non-final or mismatched tool rows as live measurement rows', () => {
    const nonFinalMessages = [
      msg({
        id: 'tool',
        role: 'tool',
        runId: 'run-1',
        toolActivities: [{ id: 't1', status: 'running' } as any]
      }),
      msg({ id: 'a2', role: 'assistant', runId: 'run-1' })
    ]

    expect(resolveLiveToolMessageId(nonFinalMessages, { revealChatIsRunning: true })).toBeNull()
    expect(
      isLiveToolMessageCandidate(
        msg({
          id: 'tool',
          role: 'tool',
          runId: 'old',
          toolActivities: [{ id: 't1', status: 'running' } as any]
        }),
        'new'
      )
    ).toBe(false)
  })

  it('includes non-tail running tool stacks in the multi-live tool set', () => {
    const messages = [
      msg({
        id: 'tool-running',
        role: 'tool',
        runId: 'run-1',
        toolActivities: [{ id: 't1', status: 'running' } as any]
      }),
      msg({ id: 'status', role: 'system', runId: 'run-1', content: 'note' })
    ]

    expect(
      resolveLiveToolMessageId(messages, { revealChatIsRunning: true, revealRunId: 'run-1' })
    ).toBeNull()
    expect(
      resolveLiveToolMessageIds(messages, { revealChatIsRunning: true, revealRunId: 'run-1' })
    ).toEqual(['tool-running'])
  })

  it('marks working fan-out lanes as live even when a later message sits below them', () => {
    const messages = [
      msg({
        id: 'fan-a',
        role: 'assistant',
        runId: 'run-1',
        content: 'lane a',
        metadata: {
          kind: 'ensembleParticipant',
          ensembleLaneId: 'lane-a',
          ensembleParticipantId: 'p-a'
        }
      }),
      msg({
        id: 'fan-b',
        role: 'assistant',
        runId: 'run-1',
        content: 'lane b',
        metadata: {
          kind: 'ensembleParticipant',
          ensembleLaneId: 'lane-b',
          ensembleParticipantId: 'p-b'
        }
      }),
      msg({ id: 'boss', role: 'assistant', runId: 'run-1', content: 'synthesizing' })
    ]

    expect(isLiveFanoutMessageCandidate(messages[0], 'run-1')).toBe(true)
    expect(isLiveFanoutMessageCandidate(messages[2], 'run-1')).toBe(false)
    expect(
      resolveLiveFanoutMessageIds(messages, {
        revealChatIsRunning: true,
        revealRunId: 'run-1',
        workingFanoutParticipantIds: new Set(['p-a', 'p-b'])
      })
    ).toEqual(['fan-a', 'fan-b'])

    expect(
      resolveLiveMeasurementMessageIds(messages, {
        revealEnabled: true,
        revealChatIsRunning: true,
        revealRunId: 'run-1',
        workingFanoutParticipantIds: new Set(['p-a'])
      })
    ).toEqual(['boss', 'fan-a'])
  })

  it('returns no measurement live ids when the chat is not running', () => {
    expect(
      resolveLiveMeasurementMessageIds([msg({ id: 'a', role: 'assistant', runId: 'run-1' })], {
        revealEnabled: true,
        revealChatIsRunning: false,
        revealRunId: 'run-1',
        workingFanoutParticipantIds: new Set(['p-a'])
      })
    ).toEqual([])
  })
})
