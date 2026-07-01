import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  RUNNING_RUN_QUEUE_STATUSES,
  deriveChatIsRunning,
  deriveChatRunCompleteNotice
} from './chatRunDisplay'

const baseChat = (patch: Partial<ChatRecord> = {}): ChatRecord =>
  ({
    appChatId: 'chat-1',
    provider: 'codex',
    messages: [],
    runs: [],
    ...patch
  }) as ChatRecord

type RunLike = {
  endedAt?: string
  exitCode?: number
  startedAt?: string
  suppressRunSummary?: boolean
}
const withRuns = (...list: RunLike[]): Partial<ChatRecord> =>
  ({ runs: list }) as unknown as Partial<ChatRecord>

const ensemblePatch = (status: 'running' | 'completed' | 'cancelled'): Partial<ChatRecord> =>
  ({
    chatKind: 'ensemble',
    ensemble: {
      enabled: true,
      maxParticipants: 6,
      participants: [],
      activeRound: {
        roundId: 'round-1',
        status,
        prompt: 'go',
        startedAt: '2026-06-09T00:00:00.000Z',
        activeParticipantId: status === 'running' ? 'p1' : undefined,
        participants:
          status === 'running'
            ? [
                {
                  participantId: 'p1',
                  provider: 'codex',
                  role: 'Worker',
                  order: 0,
                  status: 'running'
                }
              ]
            : []
      },
      updatedAt: '2026-06-09T00:00:00.000Z'
    }
  }) as Partial<ChatRecord>

describe('RUNNING_RUN_QUEUE_STATUSES', () => {
  it('mirrors the canonical active set in src/main/RunQueue.ts (narrow, no queued/paused)', () => {
    expect([...RUNNING_RUN_QUEUE_STATUSES].sort()).toEqual([
      'active',
      'cancelling',
      'starting',
      'steer_promoting'
    ])
    // The distinction from chatThinkingState's thinking set is the whole point.
    expect(RUNNING_RUN_QUEUE_STATUSES.has('queued')).toBe(false)
    expect(RUNNING_RUN_QUEUE_STATUSES.has('paused')).toBe(false)
  })
})

describe('deriveChatIsRunning', () => {
  it('is false for a missing chat or a chat with no id', () => {
    expect(deriveChatIsRunning({ chat: null, runningChatIds: new Set() })).toBe(false)
    expect(
      deriveChatIsRunning({ chat: baseChat({ appChatId: undefined }), runningChatIds: new Set() })
    ).toBe(false)
  })

  it('is true when the chat id is in runningChatIds', () => {
    expect(deriveChatIsRunning({ chat: baseChat(), runningChatIds: new Set(['chat-1']) })).toBe(true)
  })

  it('is true for active and steer-promoting run-queue jobs, false for queued/paused/other-chat jobs', () => {
    const run = (status: string, chatId = 'chat-1') => ({ chatId, status })
    expect(
      deriveChatIsRunning({
        chat: baseChat(),
        runningChatIds: new Set(),
        runQueueJobs: [run('active')]
      })
    ).toBe(true)
    expect(
      deriveChatIsRunning({
        chat: baseChat(),
        runningChatIds: new Set(),
        runQueueJobs: [run('steer_promoting')]
      })
    ).toBe(true)
    expect(
      deriveChatIsRunning({
        chat: baseChat(),
        runningChatIds: new Set(),
        runQueueJobs: [run('queued')]
      })
    ).toBe(false)
    expect(
      deriveChatIsRunning({
        chat: baseChat(),
        runningChatIds: new Set(),
        runQueueJobs: [run('paused')]
      })
    ).toBe(false)
    expect(
      deriveChatIsRunning({
        chat: baseChat(),
        runningChatIds: new Set(),
        runQueueJobs: [run('active', 'other-chat')]
      })
    ).toBe(false)
  })

  it('tracks the ensemble round only while it is running', () => {
    expect(
      deriveChatIsRunning({ chat: baseChat(ensemblePatch('running')), runningChatIds: new Set() })
    ).toBe(true)
    expect(
      deriveChatIsRunning({ chat: baseChat(ensemblePatch('completed')), runningChatIds: new Set() })
    ).toBe(false)
    expect(
      deriveChatIsRunning({ chat: baseChat(ensemblePatch('cancelled')), runningChatIds: new Set() })
    ).toBe(false)
  })

  it('does not treat a stale running ensemble snapshot as active', () => {
    expect(
      deriveChatIsRunning({
        chat: baseChat({
          ...ensemblePatch('running'),
          ensemble: {
            ...ensemblePatch('running').ensemble!,
            activeRound: {
              ...ensemblePatch('running').ensemble!.activeRound!,
              activeParticipantId: undefined,
              participants: [
                {
                  participantId: 'p1',
                  provider: 'codex',
                  role: 'Worker',
                  order: 0,
                  status: 'answered',
                  endedAt: '2026-06-09T00:01:00.000Z'
                }
              ]
            }
          }
        }),
        runningChatIds: new Set()
      })
    ).toBe(false)
  })

  it('lets a known-terminal ensemble round override an orphan runningChatIds entry', () => {
    expect(
      deriveChatIsRunning({
        chat: baseChat(ensemblePatch('completed')),
        runningChatIds: new Set(['chat-1'])
      })
    ).toBe(false)
  })

  it('lets a stale running ensemble snapshot override an orphan runningChatIds entry', () => {
    expect(
      deriveChatIsRunning({
        chat: baseChat({
          ...ensemblePatch('running'),
          ensemble: {
            ...ensemblePatch('running').ensemble!,
            activeRound: {
              ...ensemblePatch('running').ensemble!.activeRound!,
              activeParticipantId: undefined,
              participants: [
                {
                  participantId: 'p1',
                  provider: 'codex',
                  role: 'Worker',
                  order: 0,
                  status: 'answered',
                  endedAt: '2026-06-09T00:01:00.000Z'
                }
              ]
            }
          }
        }),
        runningChatIds: new Set(['chat-1'])
      })
    ).toBe(false)
  })
})

describe('deriveChatRunCompleteNotice', () => {
  it('is null while running', () => {
    expect(
      deriveChatRunCompleteNotice(baseChat(withRuns({ endedAt: 'x', exitCode: 0 })), true)
    ).toBeNull()
  })

  it('is null with no runs or an in-flight last run', () => {
    expect(deriveChatRunCompleteNotice(baseChat(), false)).toBeNull()
    expect(deriveChatRunCompleteNotice(baseChat(withRuns({})), false)).toBeNull()
  })

  it('surfaces the last finished run with exit code and start time', () => {
    expect(
      deriveChatRunCompleteNotice(
        baseChat(
          withRuns(
            { endedAt: 'old', exitCode: 0 },
            { endedAt: '2026-06-09T00:05:00.000Z', exitCode: 1, startedAt: '2026-06-09T00:00:00.000Z' }
          )
        ),
        false
      )
    ).toEqual({
      timestamp: '2026-06-09T00:05:00.000Z',
      exitCode: 1,
      startedAt: '2026-06-09T00:00:00.000Z',
      suppressRunSummary: false
    })
  })

  it('defaults a missing exit code to 0 and a missing start time to undefined', () => {
    expect(deriveChatRunCompleteNotice(baseChat(withRuns({ endedAt: 'e' })), false)).toEqual({
      timestamp: 'e',
      exitCode: 0,
      startedAt: undefined,
      suppressRunSummary: false
    })
  })

  it('preserves persisted steer-summary suppression from the last run', () => {
    expect(
      deriveChatRunCompleteNotice(
        baseChat(
          withRuns({
            endedAt: '2026-06-09T00:05:00.000Z',
            exitCode: 130,
            suppressRunSummary: true
          })
        ),
        false
      )
    ).toEqual({
      timestamp: '2026-06-09T00:05:00.000Z',
      exitCode: 130,
      startedAt: undefined,
      suppressRunSummary: true
    })
  })
})
