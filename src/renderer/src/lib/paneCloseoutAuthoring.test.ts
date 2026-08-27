import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  TASKWRAITH_CLOSEOUT_KIND,
  taskWraithRoundCloseoutId
} from '../../../shared/taskWraithCloseout'
import { applyRestingChatCloseout, resolveRestingChatCloseoutTarget } from './paneCloseoutAuthoring'

const ROUND_STARTED_AT = '2026-08-27T03:52:00.000Z'
const ROUND_ENDED_AT = '2026-08-27T05:51:12.000Z'

function makeRoundChat(over: Record<string, unknown> = {}): ChatRecord {
  return {
    appChatId: 'chat-tui',
    chatKind: 'ensemble',
    updatedAt: Date.parse(ROUND_ENDED_AT),
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Make the TUI standalone',
        timestamp: ROUND_STARTED_AT
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Round summary: done.',
        timestamp: ROUND_ENDED_AT,
        runId: 'run-a',
        metadata: { ensembleRoundId: 'round-1' }
      }
    ],
    runs: [
      {
        runId: 'run-a',
        provider: 'codex',
        status: 'completed',
        startedAt: ROUND_STARTED_AT,
        endedAt: '2026-08-27T05:51:08.000Z',
        ensembleRoundId: 'round-1',
        ensembleParticipantId: 'seat-a',
        ensembleRole: 'Boss',
        ensembleOrder: 1
      },
      {
        runId: 'run-b',
        provider: 'kimi',
        status: 'completed',
        startedAt: ROUND_STARTED_AT,
        endedAt: '2026-08-27T05:50:59.000Z',
        ensembleRoundId: 'round-1',
        ensembleParticipantId: 'seat-b',
        ensembleRole: 'Capt',
        ensembleOrder: 2
      }
    ],
    ensemble: {
      enabled: true,
      maxParticipants: 4,
      participants: [],
      activeRound: {
        roundId: 'round-1',
        status: 'completed',
        prompt: 'Make the TUI standalone',
        startedAt: ROUND_STARTED_AT,
        endedAt: ROUND_ENDED_AT,
        participants: [
          {
            participantId: 'seat-a',
            provider: 'codex',
            role: 'Boss',
            order: 1,
            status: 'answered',
            runId: 'run-a'
          },
          {
            participantId: 'seat-b',
            provider: 'kimi',
            role: 'Capt',
            order: 2,
            status: 'answered',
            runId: 'run-b'
          }
        ]
      }
    },
    ...over
  } as unknown as ChatRecord
}

function makeSoloChat(over: Record<string, unknown> = {}): ChatRecord {
  return {
    appChatId: 'chat-solo',
    updatedAt: Date.parse(ROUND_ENDED_AT),
    messages: [
      { id: 'user-1', role: 'user', content: 'Do the thing', timestamp: ROUND_STARTED_AT },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Did the thing.',
        timestamp: ROUND_ENDED_AT,
        runId: 'run-solo'
      }
    ],
    runs: [
      {
        runId: 'run-solo',
        provider: 'claude',
        status: 'completed',
        exitCode: 0,
        startedAt: ROUND_STARTED_AT,
        endedAt: ROUND_ENDED_AT
      }
    ],
    ...over
  } as unknown as ChatRecord
}

describe('resolveRestingChatCloseoutTarget', () => {
  it('resolves a completion-scoped round target for a finished ensemble round', () => {
    const target = resolveRestingChatCloseoutTarget(makeRoundChat(), { isRunning: false })
    expect(target).not.toBeNull()
    expect(target?.scope).toBe('ensembleRound')
    expect(target?.round?.roundId).toBe('round-1')
    expect(target?.completedAt).toBe(ROUND_ENDED_AT)
    const closeoutId = taskWraithRoundCloseoutId('round-1')
    expect(target?.closeoutId).toBe(closeoutId)
    expect(target?.aiSummaryKey).toBe(`${closeoutId}@${ROUND_ENDED_AT}`)
    expect(target?.authoringKey).toBe(`chat-tui|${closeoutId}|${ROUND_ENDED_AT}`)
  })

  it('returns null while the chat is running', () => {
    expect(resolveRestingChatCloseoutTarget(makeRoundChat(), { isRunning: true })).toBeNull()
  })

  it('returns null while the round is still live', () => {
    const chat = makeRoundChat()
    const round = (chat.ensemble!.activeRound as unknown as Record<string, unknown>)!
    round.status = 'collecting'
    delete round.endedAt
    expect(resolveRestingChatCloseoutTarget(chat, { isRunning: false })).toBeNull()
  })

  it('returns null when run-complete summaries are disabled in Settings', () => {
    expect(
      resolveRestingChatCloseoutTarget(makeRoundChat(), {
        isRunning: false,
        showRunCompleteSummary: false
      })
    ).toBeNull()
  })

  it('returns null for a steer-suppressed solo completion', () => {
    const chat = makeSoloChat()
    ;(chat.runs![0] as unknown as Record<string, unknown>).suppressRunSummary = true
    expect(resolveRestingChatCloseoutTarget(chat, { isRunning: false })).toBeNull()
  })

  it('resolves a run target for a finished solo run', () => {
    const target = resolveRestingChatCloseoutTarget(makeSoloChat(), { isRunning: false })
    expect(target?.scope).toBe('run')
    expect(target?.run?.runId).toBe('run-solo')
    expect(target?.completedAt).toBe(ROUND_ENDED_AT)
    expect(target?.exitCode).toBe(0)
  })

  it('mints a fresh authoring key when the same round re-completes later', () => {
    const first = resolveRestingChatCloseoutTarget(makeRoundChat(), { isRunning: false })
    const reCompletedAt = '2026-08-27T06:10:00.000Z'
    const reopened = makeRoundChat()
    ;(reopened.ensemble!.activeRound as unknown as Record<string, unknown>).endedAt = reCompletedAt
    const second = resolveRestingChatCloseoutTarget(reopened, { isRunning: false })
    expect(first?.authoringKey).not.toBe(second?.authoringKey)
    expect(second?.completedAt).toBe(reCompletedAt)
  })
})

describe('applyRestingChatCloseout', () => {
  it('authors a round close-out whose Task Complete card hosts the participant table', () => {
    const chat = makeRoundChat()
    const target = resolveRestingChatCloseoutTarget(chat, { isRunning: false })!
    const updated = applyRestingChatCloseout(chat, target)
    expect(updated).not.toBe(chat)
    const closeout = updated.messages.find(
      (message) => message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND
    )
    expect(closeout).toBeDefined()
    expect(closeout?.id).toBe(target.closeoutId)
    expect(closeout?.timestamp).toBe(ROUND_ENDED_AT)
    expect(closeout?.content.startsWith('**Worked for')).toBe(true)
    expect(closeout?.metadata?.closeoutRoundId).toBe('round-1')
    const table = closeout?.metadata?.closeoutParticipantTable as { rows?: unknown[] } | undefined
    expect(table?.rows?.length).toBe(2)
  })

  it('is idempotent: re-applying to the authored record is a no-op by reference', () => {
    const chat = makeRoundChat()
    const target = resolveRestingChatCloseoutTarget(chat, { isRunning: false })!
    const updated = applyRestingChatCloseout(chat, target)
    expect(applyRestingChatCloseout(updated, target)).toBe(updated)
  })

  it('leaves the record alone when a newer round superseded the target', () => {
    const chat = makeRoundChat()
    const target = resolveRestingChatCloseoutTarget(chat, { isRunning: false })!
    const advanced = makeRoundChat()
    ;(advanced.ensemble!.activeRound as unknown as Record<string, unknown>).roundId = 'round-2'
    expect(applyRestingChatCloseout(advanced, target)).toBe(advanced)
  })

  it('never clobbers a persisted AI summary for the same completion back to fallback prose', () => {
    const chat = makeRoundChat()
    const target = resolveRestingChatCloseoutTarget(chat, { isRunning: false })!
    const authored = applyRestingChatCloseout(chat, target, {
      aiSummaries: {
        [target.aiSummaryKey]: { text: 'The round shipped the standalone TUI.' }
      }
    })
    const withAi = authored.messages.find((message) => message.id === target.closeoutId)
    expect(withAi?.content).toContain('The round shipped the standalone TUI.')
    // A later rebuild without the session cache must reseed from the message
    // metadata instead of downgrading the prose.
    const rebuilt = applyRestingChatCloseout(authored, target)
    expect(rebuilt).toBe(authored)
  })

  it('authors a solo run close-out scoped to the finished run', () => {
    const chat = makeSoloChat()
    const target = resolveRestingChatCloseoutTarget(chat, { isRunning: false })!
    const updated = applyRestingChatCloseout(chat, target)
    const closeout = updated.messages.find(
      (message) => message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND
    )
    expect(closeout?.metadata?.sourceRunId).toBe('run-solo')
    expect(closeout?.runId).toBe('run-solo')
  })
})

describe('App wiring (resting-pane close-out author)', () => {
  it('App authors close-outs for resting Multiview pane chats, not only currentChat', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const refIndex = source.indexOf('restingPaneCloseoutAuthoredRef')
    expect(refIndex).toBeGreaterThan(-1)
    const effectEnd = source.indexOf('], [', refIndex)
    const effect = source.slice(refIndex, effectEnd > refIndex ? effectEnd + 2000 : refIndex + 6000)
    // The effect walks the Multiview panes, skips the focused chat (the
    // focused close-out effect owns it), and routes the upsert through
    // updateChatById so persistence and store fan-out stay canonical.
    expect(effect).toContain('multiview.paneChatIds')
    expect(effect).toContain('currentChatIdRef.current')
    expect(effect).toContain('resolveRestingChatCloseoutTarget(')
    expect(effect).toContain('applyRestingChatCloseout(')
    expect(effect).toContain('updateChatById(')
    expect(effect).toContain('childChatsForCloseout(')
  })
})
