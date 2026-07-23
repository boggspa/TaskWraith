import { describe, expect, it } from 'vitest'
import type { ChatRecord, WorkSessionConfig } from '../../../main/store/types'
import { applyWorkSessionConfirmation, cancelWorkSessionOnChat } from './workSessionChat'

function workSession(overrides: Partial<WorkSessionConfig> = {}): WorkSessionConfig {
  return {
    enabled: true,
    status: 'active',
    objective: 'Ship the fix.',
    acceptanceCriteria: 'Tests pass.',
    allowedParticipantIds: null,
    permissionPresetId: 'workspace_write',
    maxRoundsPerProvider: 3,
    maxDurationMs: 60 * 60 * 1000,
    enableScoutPass: false,
    roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0 },
    totalRoundsUsed: 0,
    ...overrides
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Ensemble',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 6,
      orchestrationMode: 'turn_bound',
      participants: [],
      updatedAt: '2026-06-06T00:00:00.000Z'
    },
    ...overrides
  }
}

describe('workSessionChat', () => {
  it('applies Work Session confirmation fields and records the status transition', () => {
    const source = chat()
    const config = workSession({ leadParticipantId: 'codex' })

    const updated = applyWorkSessionConfirmation(
      source,
      {
        config,
        roundMode: 'chair-summary',
        synthesizerParticipantId: 'claude'
      },
      '2026-06-06T12:00:00.000Z'
    )

    expect(updated.ensemble?.workSession).toEqual(config)
    expect(updated.ensemble?.roundMode).toBe('chair-summary')
    expect(updated.ensemble?.synthesizerParticipantId).toBe('claude')
    expect(updated.ensemble?.updatedAt).toBe('2026-06-06T12:00:00.000Z')
    expect(updated.ensemble?.sessionActivityLedger?.[0]).toMatchObject({
      scope: 'session',
      target: 'work session',
      oldValue: 'idle',
      newValue: 'active'
    })
  })

  it('cancels an existing Work Session without rebuilding App.tsx state inline', () => {
    const source = chat({
      ensemble: {
        enabled: true,
        maxParticipants: 6,
        orchestrationMode: 'turn_bound',
        participants: [],
        updatedAt: '2026-06-06T00:00:00.000Z',
        workSession: workSession()
      }
    })

    const updated = cancelWorkSessionOnChat(source, '2026-06-06T13:00:00.000Z')

    expect(updated.ensemble?.workSession).toMatchObject({
      status: 'cancelled',
      endedAt: '2026-06-06T13:00:00.000Z',
      endedReason: 'Stopped by user.'
    })
    expect(updated.ensemble?.updatedAt).toBe('2026-06-06T13:00:00.000Z')
    expect(updated.ensemble?.sessionActivityLedger?.[0]).toMatchObject({
      target: 'work session',
      oldValue: 'active',
      newValue: 'cancelled'
    })
  })
})
