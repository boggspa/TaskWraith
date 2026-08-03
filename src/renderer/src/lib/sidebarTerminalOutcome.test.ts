import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, ChatRun } from '../../../main/store/types'
import {
  SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY,
  acknowledgeSidebarTerminalOutcome,
  isSidebarTerminalOutcomeUnread,
  loadSidebarTerminalOutcomeAcknowledgements,
  persistSidebarTerminalOutcomeAcknowledgements,
  projectSidebarTerminalOutcome
} from './sidebarTerminalOutcome'

const ISO_START = '2026-08-03T20:00:00.000Z'
const ISO_END = '2026-08-03T20:05:00.000Z'

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'run-1',
    startedAt: ISO_START,
    endedAt: ISO_END,
    status: 'success',
    exitCode: 0,
    ...overrides
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'codex',
    title: 'Thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  } as ChatRecord
}

function goal(
  status: 'active' | 'paused' | 'blocked' | 'completed',
  updatedAt = ISO_END
): NonNullable<ChatRecord['activeGoal']> {
  return {
    id: 'goal-1',
    objective: 'Ship it',
    objectiveSource: 'user',
    status,
    mode: 'codex_native',
    provider: 'codex',
    createdAt: ISO_START,
    updatedAt,
    ...(status === 'blocked' ? { blockedAt: updatedAt } : {}),
    ...(status === 'completed' ? { completedAt: updatedAt } : {})
  }
}

describe('projectSidebarTerminalOutcome', () => {
  it('leaves ordinary non-terminal and successful active-goal titles unchanged', () => {
    expect(projectSidebarTerminalOutcome(chat())).toBeNull()
    expect(
      projectSidebarTerminalOutcome(chat({ activeGoal: goal('active'), runs: [run()] }))
    ).toBeNull()
    expect(
      projectSidebarTerminalOutcome(
        chat({
          activeGoal: goal('completed'),
          runs: [run({ endedAt: undefined, status: 'running' })]
        })
      )
    ).toBeNull()
  })

  it('maps goal-less Task Complete and model failure terminals to green and red', () => {
    expect(projectSidebarTerminalOutcome(chat({ runs: [run()] }))).toMatchObject({
      source: 'run',
      tone: 'success'
    })
    expect(
      projectSidebarTerminalOutcome(chat({ runs: [run({ status: 'failed', exitCode: 2 })] }))
    ).toMatchObject({ source: 'run', tone: 'failure' })
  })

  it('treats success-with-warnings as success but keeps cancellation and steer handoff neutral', () => {
    expect(
      projectSidebarTerminalOutcome(chat({ runs: [run({ status: 'success_with_warnings' })] }))
    ).toMatchObject({ tone: 'success' })
    expect(
      projectSidebarTerminalOutcome(
        chat({ runs: [run({ status: 'cancelled', cancelled: true, exitCode: 130 })] })
      )
    ).toBeNull()
    expect(
      projectSidebarTerminalOutcome(chat({ runs: [run({ suppressRunSummary: true })] }))
    ).toBeNull()
  })

  it('lets completed goal presentation beat a failed matching run without rewriting history', () => {
    const failedRun = run({ activeGoalId: 'goal-1', status: 'failed', exitCode: 1 })
    const record = chat({ activeGoal: goal('completed'), runs: [failedRun] })

    expect(projectSidebarTerminalOutcome(record)).toMatchObject({
      source: 'goal',
      tone: 'success'
    })
    expect(record.runs[0]).toMatchObject({ status: 'failed', exitCode: 1 })
  })

  it('maps a blocked goal red and still surfaces concrete failure on an active goal', () => {
    expect(
      projectSidebarTerminalOutcome(
        chat({ activeGoal: goal('blocked'), runs: [run({ activeGoalId: 'goal-1' })] })
      )
    ).toMatchObject({ source: 'goal', tone: 'failure' })
    expect(
      projectSidebarTerminalOutcome(
        chat({
          activeGoal: goal('active'),
          runs: [run({ activeGoalId: 'goal-1', status: 'failed', exitCode: 1 })]
        })
      )
    ).toMatchObject({ source: 'run', tone: 'failure' })
  })

  it('does not let an old completed goal mask a later goal-less failure', () => {
    const oldGoal = goal('completed', '2026-08-03T19:00:00.000Z')
    expect(
      projectSidebarTerminalOutcome(
        chat({ activeGoal: oldGoal, runs: [run({ status: 'failed', exitCode: 1 })] })
      )
    ).toMatchObject({ source: 'run', tone: 'failure' })
  })

  it('uses the terminal ensemble round and its stalled/exhausted signals as the outcome unit', () => {
    const ensembleChat = chat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 4,
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'completed',
          prompt: 'Go',
          startedAt: ISO_START,
          endedAt: ISO_END,
          participants: []
        },
        escalationSignals: [
          {
            id: 'signal-1',
            chatId: 'chat-1',
            roundId: 'round-1',
            kind: 'looping',
            evidence: 'Turn budget spent.',
            recommendedAction: 'extend-rounds',
            createdAt: ISO_END
          }
        ],
        updatedAt: ISO_END
      },
      runs: [run({ status: 'success' })]
    })

    expect(projectSidebarTerminalOutcome(ensembleChat)).toMatchObject({
      source: 'round',
      tone: 'failure'
    })
    expect(
      projectSidebarTerminalOutcome(
        chat({
          ...ensembleChat,
          ensemble: {
            ...ensembleChat.ensemble!,
            escalationSignals: []
          }
        })
      )
    ).toMatchObject({ source: 'round', tone: 'success' })
  })
})

describe('sidebar terminal outcome acknowledgements', () => {
  it('is idempotent for one fingerprint and lets a later terminal become unread again', () => {
    const firstOutcome = projectSidebarTerminalOutcome(chat({ runs: [run()] }))!
    const first = acknowledgeSidebarTerminalOutcome({}, 'chat-1', firstOutcome)
    const repeated = acknowledgeSidebarTerminalOutcome(first, 'chat-1', firstOutcome)
    const laterOutcome = projectSidebarTerminalOutcome(
      chat({ runs: [run({ runId: 'run-2', endedAt: '2026-08-03T21:05:00.000Z' })] })
    )!

    expect(repeated).toBe(first)
    expect(isSidebarTerminalOutcomeUnread(first, 'chat-1', firstOutcome)).toBe(false)
    expect(isSidebarTerminalOutcomeUnread(first, 'chat-1', laterOutcome)).toBe(true)
  })

  it('loads only valid persisted fingerprints and writes through the versioned key', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({ 'chat-1': 'run:1', bad: 42 })),
      setItem: vi.fn()
    }
    expect(loadSidebarTerminalOutcomeAcknowledgements(storage)).toEqual({ 'chat-1': 'run:1' })

    persistSidebarTerminalOutcomeAcknowledgements({ 'chat-1': 'run:2' }, storage)
    expect(storage.setItem).toHaveBeenCalledWith(
      SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY,
      JSON.stringify({ 'chat-1': 'run:2' })
    )
  })
})
