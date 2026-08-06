import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnsembleChatFlushScheduler } from './ensembleChatFlushScheduler'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

describe('EnsembleChatFlushScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms one timer per chat even when many runs schedule', () => {
    vi.useFakeTimers()
    const onFlush = vi.fn()
    const scheduler = new EnsembleChatFlushScheduler({ delayMs: 250, onFlush })

    scheduler.schedule('chat-a', 'run-1')
    scheduler.schedule('chat-a', 'run-2')
    scheduler.schedule('chat-a', 'run-3')
    scheduler.schedule('chat-b', 'run-9')

    expect(scheduler.isArmed('chat-a')).toBe(true)
    expect(scheduler.isArmed('chat-b')).toBe(true)
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)

    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenCalledWith(
      'chat-a',
      expect.arrayContaining(['run-1', 'run-2', 'run-3'])
    )
    expect(onFlush.mock.calls.find((call) => call[0] === 'chat-a')?.[1]).toHaveLength(3)
    expect(onFlush).toHaveBeenCalledWith('chat-b', ['run-9'])
    expect(scheduler.isArmed('chat-a')).toBe(false)
    expect(scheduler.isArmed('chat-b')).toBe(false)
  })

  it('does not reset the debounce window when another run schedules mid-wait', () => {
    vi.useFakeTimers()
    const onFlush = vi.fn()
    const scheduler = new EnsembleChatFlushScheduler({ delayMs: 250, onFlush })

    scheduler.schedule('chat-a', 'run-1')
    vi.advanceTimersByTime(200)
    scheduler.schedule('chat-a', 'run-2')
    vi.advanceTimersByTime(50)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('chat-a', expect.arrayContaining(['run-1', 'run-2']))
  })

  it('cancelRun drops one run and disarms when the set empties', () => {
    vi.useFakeTimers()
    const onFlush = vi.fn()
    const scheduler = new EnsembleChatFlushScheduler({ delayMs: 250, onFlush })

    scheduler.schedule('chat-a', 'run-1')
    scheduler.schedule('chat-a', 'run-2')
    scheduler.cancelRun('chat-a', 'run-1')
    expect(scheduler.isArmed('chat-a')).toBe(true)
    expect(scheduler.pendingRunIds('chat-a')).toEqual(['run-2'])

    scheduler.cancelRun('chat-a', 'run-2')
    expect(scheduler.isArmed('chat-a')).toBe(false)
    vi.advanceTimersByTime(250)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('cancelChat clears pending runs and the timer', () => {
    vi.useFakeTimers()
    const onFlush = vi.fn()
    const scheduler = new EnsembleChatFlushScheduler({ delayMs: 250, onFlush })

    scheduler.schedule('chat-a', 'run-1')
    scheduler.schedule('chat-a', 'run-2')
    scheduler.cancelChat('chat-a')
    expect(scheduler.isArmed('chat-a')).toBe(false)
    expect(scheduler.pendingRunIds('chat-a')).toEqual([])
    vi.advanceTimersByTime(250)
    expect(onFlush).not.toHaveBeenCalled()
  })
})

describe('EnsembleOrchestrator per-chat scheduleFlush', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function participant(
    id: string,
    provider: EnsembleParticipant['provider'],
    role: string,
    order: number
  ): EnsembleParticipant {
    return {
      id,
      provider,
      enabled: true,
      role,
      instructions: `${role}.`,
      order,
      model: `${provider}-model`,
      permissionPresetId: 'read_only',
      stageRole: 'worker'
    }
  }

  it('batches N lane scheduleFlush calls into one saveChat after 250ms', () => {
    vi.useFakeTimers()
    const participants = [
      participant('p1', 'claude', 'W1', 1),
      participant('p2', 'codex', 'W2', 2),
      participant('p3', 'grok', 'W3', 3)
    ]
    let chat: ChatRecord = {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      scope: 'workspace',
      provider: 'claude',
      title: 'Per-chat flush',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: participants.map((p, index) => ({
        runId: `run-${index + 1}`,
        provider: p.provider,
        status: 'running',
        startedAt: '2026-08-06T01:00:00.000Z'
      })),
      ensemble: {
        enabled: true,
        maxParticipants: participants.length,
        fanoutPolicy: 'read_only',
        participants,
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          startedAt: '2026-08-06T01:00:00.000Z',
          prompt: 'fan out',
          participants: participants.map((p, index) => ({
            participantId: p.id,
            provider: p.provider,
            role: p.role,
            order: p.order ?? index,
            status: 'running' as const,
            runId: `run-${index + 1}`
          }))
        }
      }
    }
    const saveChat = vi.fn((next: ChatRecord) => {
      chat = next
    })
    const orchestrator = new EnsembleOrchestrator({
      getChat: () => chat,
      saveChat,
      getSettings: () =>
        ({
          storeLocalChatHistory: true,
          storeRawEvents: false,
          ensembleModeEnabled: true,
          chatContextTurns: 8
        }) as unknown as AppSettings,
      dispatch: vi.fn(async (payload: AgentRunPayload) => ({
        dispatched: true,
        appRunId: payload.appRunId || ''
      })),
      cancelRun: vi.fn(async () => true),
      createRunId: (provider) => `${provider}-run`,
      now: () => Date.now(),
      nowIso: () => '2026-08-06T01:00:00.000Z'
    })

    const internal = orchestrator as unknown as {
      runsByRunId: Map<string, any>
      scheduleFlush: (run: any) => void
    }
    for (let i = 0; i < participants.length; i += 1) {
      const runId = `run-${i + 1}`
      const run = {
        runId,
        chatId: 'ensemble-chat',
        roundId: 'round-1',
        participant: participants[i],
        timeline: [{ kind: 'content', text: `lane-${i + 1}` }],
        content: `lane-${i + 1}`,
        status: 'running' as const,
        toolActivities: []
      }
      internal.runsByRunId.set(runId, run)
      internal.scheduleFlush(run)
    }

    expect(saveChat).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(saveChat).toHaveBeenCalledTimes(1)
    expect(chat.messages.some((m) => String(m.content).includes('lane-1'))).toBe(true)
    expect(chat.messages.some((m) => String(m.content).includes('lane-2'))).toBe(true)
    expect(chat.messages.some((m) => String(m.content).includes('lane-3'))).toBe(true)
  })
})
