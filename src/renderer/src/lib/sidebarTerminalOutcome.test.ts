import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, ChatRun } from '../../../main/store/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY,
  acknowledgeSidebarTerminalOutcome,
  chatIsAwaitingUserResponse,
  sidebarSuccessInkPredatesEpoch,
  sidebarRowToneClass,
  isSidebarTerminalOutcomeUnread,
  loadSidebarTerminalOutcomeAcknowledgements,
  persistSidebarTerminalOutcomeAcknowledgements,
  projectSidebarTerminalOutcome,
  type SidebarTerminalOutcomeProjection
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

  it('does not paint a round Red when synthesis remains unresolved', () => {
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
          synthesisStatus: 'unresolved',
          participants: []
        },
        escalationSignals: [
          {
            id: 'signal-synthesis',
            chatId: 'chat-1',
            roundId: 'round-1',
            kind: 'disagreement-unresolved',
            evidence: 'Two answers were not reconciled.',
            recommendedAction: 'call-synthesizer',
            createdAt: ISO_END
          }
        ],
        updatedAt: ISO_END
      },
      runs: [run({ status: 'success' })]
    })

    expect(projectSidebarTerminalOutcome(ensembleChat)).toMatchObject({
      source: 'round',
      tone: 'success'
    })
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

describe('chatIsAwaitingUserResponse', () => {
  it('is true for an approval head, a queued approval, or an unanswered question', () => {
    expect(
      chatIsAwaitingUserResponse('chat-1', { approvalHeadByChatId: { 'chat-1': { id: 'a' } } })
    ).toBe(true)
    expect(
      chatIsAwaitingUserResponse('chat-1', { approvalQueueByChatId: { 'chat-1': [{ id: 'a' }] } })
    ).toBe(true)
    expect(
      chatIsAwaitingUserResponse('chat-1', { questionsByChatId: { 'chat-1': [{ id: 'q' }] } })
    ).toBe(true)
  })

  it('is false once nothing is parked — the tone clears without an acknowledgement', () => {
    expect(chatIsAwaitingUserResponse('chat-1', undefined)).toBe(false)
    expect(chatIsAwaitingUserResponse('chat-1', {})).toBe(false)
    // A resolved head is stored as null, and drained queues as empty arrays.
    expect(
      chatIsAwaitingUserResponse('chat-1', {
        approvalHeadByChatId: { 'chat-1': null },
        approvalQueueByChatId: { 'chat-1': [] },
        questionsByChatId: { 'chat-1': [] }
      })
    ).toBe(false)
    expect(chatIsAwaitingUserResponse('', { approvalHeadByChatId: { '': { id: 'a' } } })).toBe(
      false
    )
  })

  it('reads the FILING key, never another thread pending work', () => {
    const sources = { approvalHeadByChatId: { 'other-chat': { id: 'a' } } }
    expect(chatIsAwaitingUserResponse('chat-1', sources)).toBe(false)
    expect(chatIsAwaitingUserResponse('other-chat', sources)).toBe(true)
  })
})

describe('sidebar row tone ink', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/01-sidebar.css'),
    'utf8'
  )
  const block = (selector: string): string => {
    const start = css.indexOf(selector)
    if (start < 0) return ''
    const open = css.indexOf('{', start)
    return css.slice(start, css.indexOf('}', open) + 1)
  }

  it('keeps the terminal class names and gives waiting its own', () => {
    expect(sidebarRowToneClass('success')).toBe('sidebar-terminal-outcome-success')
    expect(sidebarRowToneClass('failure')).toBe('sidebar-terminal-outcome-failure')
    // Not "…-outcome-waiting": nothing has settled, the thread is parked.
    expect(sidebarRowToneClass('waiting')).toBe('sidebar-attention-waiting')
  })

  it('inks waiting amber and joins the same slow sweep as the two outcomes', () => {
    expect(block('.app-sidebar .sidebar-attention-waiting {')).toContain(
      'var(--tool-warning, #f5a623)'
    )
    // One shared sweep: every selector list that drives the animation, the
    // reduced-motion opt-outs included, must carry all three tones.
    const lists = css.split('.sidebar-terminal-outcome-failure,').length - 1
    expect(lists).toBe(3)
    expect(css.split('.sidebar-attention-waiting').length - 1).toBe(4)
    expect(css).toContain('animation: sidebar-terminal-outcome-shimmer 10s linear infinite')
  })
})

describe('sidebarSuccessInkPredatesEpoch', () => {
  const outcome = (
    tone: 'success' | 'failure',
    settledAtMs: number | null
  ): SidebarTerminalOutcomeProjection => ({
    fingerprint: 'run:1',
    source: 'run',
    tone,
    settledAtMs
  })

  it('withholds only SUCCESS that finished before the epoch', () => {
    expect(sidebarSuccessInkPredatesEpoch(outcome('success', 500), 1_000)).toBe(true)
    expect(sidebarSuccessInkPredatesEpoch(outcome('success', 1_500), 1_000)).toBe(false)
  })

  it('never withholds a failure — old failures are unfinished business', () => {
    expect(sidebarSuccessInkPredatesEpoch(outcome('failure', 500), 1_000)).toBe(false)
  })

  it('treats an exactly-at-epoch success as new, and an undateable one as history', () => {
    expect(sidebarSuccessInkPredatesEpoch(outcome('success', 1_000), 1_000)).toBe(false)
    expect(sidebarSuccessInkPredatesEpoch(outcome('success', null), 1_000)).toBe(true)
  })

  it('withholds nothing when no epoch is known', () => {
    expect(sidebarSuccessInkPredatesEpoch(outcome('success', 500), null)).toBe(false)
    expect(sidebarSuccessInkPredatesEpoch(outcome('success', null), null)).toBe(false)
  })
})

describe('projectSidebarTerminalOutcome settle timestamps', () => {
  it('stamps the run end, falling back to the chat updatedAt', () => {
    const dated = chat({
      updatedAt: 4_242,
      runs: [run({ endedAt: '2026-08-04T10:00:00.000Z' })]
    })
    expect(projectSidebarTerminalOutcome(dated)?.settledAtMs).toBe(
      Date.parse('2026-08-04T10:00:00.000Z')
    )

    const undated = chat({
      updatedAt: 4_242,
      runs: [{ runId: 'r2', startedAt: ISO_START, status: 'success', exitCode: 0 }]
    })
    expect(projectSidebarTerminalOutcome(undated)?.settledAtMs).toBe(4_242)
  })
})
