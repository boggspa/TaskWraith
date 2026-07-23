import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleEnsembleContinue, transitionWorkSession } from './EnsembleContinue'
import type {
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  WorkSessionConfig
} from './store/types'

/*
 * 1.0.4-AK1 regression coverage for `handleEnsembleContinue`.
 *
 * The handler is the participant-facing surface that drives Work
 * Session lifecycle transitions (active → completed / paused /
 * limit_reached) and queues the next round's prompt. These tests
 * pin every branch — wrong handling of acceptanceStatus, the
 * idempotency guard, the budget exhaustion check, and the
 * allowed-participants gate — so the production code can be
 * refactored without losing the contract.
 */

function makeParticipant(over: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'codex-1',
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    instructions: 'Do the work.',
    order: 1,
    permissionPresetId: 'workspace_write',
    ...over
  }
}

function makeWorkSession(over: Partial<WorkSessionConfig> = {}): WorkSessionConfig {
  return {
    enabled: true,
    status: 'active',
    objective: 'Ship the Excel export feature',
    acceptanceCriteria: 'User can export .xlsx from the reports view.',
    allowedParticipantIds: null,
    permissionPresetId: 'workspace_write',
    maxRoundsPerProvider: 38,
    maxDurationMs: 6 * 60 * 60 * 1000,
    enableScoutPass: false,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    roundsUsed: { codex: 0, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0 },
    totalRoundsUsed: 0,
    ...over
  }
}

function makeChat(
  over: Partial<ChatRecord> = {},
  ensembleOver: Partial<EnsembleConfig> = {}
): ChatRecord {
  const ensemble: EnsembleConfig = {
    enabled: true,
    maxParticipants: 4,
    participants: [makeParticipant()],
    activeRound: {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Initial prompt',
      startedAt: new Date().toISOString(),
      queuedPrompts: [],
      participants: []
    },
    workSession: makeWorkSession(),
    ...ensembleOver
  }
  return {
    appChatId: 'chat-1',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Work session',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble,
    ...over
  }
}

function makeDeps(chat: ChatRecord) {
  const saveChat = vi.fn((updated: ChatRecord) => {
    // Mutate the test's chat reference so subsequent getChat calls
    // see the persisted update — mirrors the real ChatStore behavior.
    Object.assign(chat, updated)
  })
  const queueFollowUpPrompt = vi.fn(() => true)
  return {
    deps: {
      getChat: () => chat,
      saveChat,
      queueFollowUpPrompt,
      callingProvider: 'codex' as const,
      callingParticipantId: 'codex-1'
    },
    saveChat,
    queueFollowUpPrompt
  }
}

describe('handleEnsembleContinue', () => {
  describe('happy paths', () => {
    let chat: ChatRecord

    beforeEach(() => {
      chat = makeChat()
    })

    it('queues a follow-up prompt and bumps roundsUsed when acceptanceStatus is inProgress', () => {
      const { deps, saveChat, queueFollowUpPrompt } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        {
          summary: 'Wrote the export module.',
          nextPrompt: 'Wire up the toolbar button next.',
          acceptanceStatus: 'inProgress'
        },
        deps
      )
      expect(result.ok).toBe(true)
      expect(result.status).toBe('active')
      expect(result.queued).toBe(true)
      expect(queueFollowUpPrompt).toHaveBeenCalledWith('chat-1', 'Wire up the toolbar button next.')
      expect(saveChat).toHaveBeenCalledOnce()
      expect(chat.ensemble?.workSession?.roundsUsed.codex).toBe(1)
      expect(chat.ensemble?.workSession?.totalRoundsUsed).toBe(1)
    })

    it('lets the configured Work Session manager queue a continuation', () => {
      chat.ensemble!.workSession = makeWorkSession({ managerParticipantId: 'codex-1' })
      const { deps, queueFollowUpPrompt } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'continue under manager', acceptanceStatus: 'inProgress' },
        deps
      )
      expect(result.ok).toBe(true)
      expect(result.queued).toBe(true)
      expect(queueFollowUpPrompt).toHaveBeenCalledWith('chat-1', 'continue under manager')
    })

    it('finalises the session when acceptanceStatus is complete', () => {
      const { deps, saveChat, queueFollowUpPrompt } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { summary: 'All criteria met.', acceptanceStatus: 'complete' },
        deps
      )
      expect(result.ok).toBe(true)
      expect(result.status).toBe('completed')
      expect(result.queued).toBe(false)
      expect(queueFollowUpPrompt).not.toHaveBeenCalled()
      expect(chat.ensemble?.workSession?.status).toBe('completed')
      expect(chat.ensemble?.workSession?.endedAt).toBeDefined()
      expect(chat.ensemble?.workSession?.endedReason).toBe('All criteria met.')
      expect(saveChat).toHaveBeenCalledOnce()
    })

    it('pauses the session when acceptanceStatus is blocked', () => {
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        {
          reason: 'Need OAuth credentials from the user.',
          acceptanceStatus: 'blocked'
        },
        deps
      )
      expect(result.ok).toBe(true)
      expect(result.status).toBe('paused')
      expect(result.queued).toBe(false)
      expect(chat.ensemble?.workSession?.status).toBe('paused')
      expect(chat.ensemble?.workSession?.endedReason).toBe('Need OAuth credentials from the user.')
    })

    it('defaults to inProgress when acceptanceStatus is omitted', () => {
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue('chat-1', { nextPrompt: 'Continue.' }, deps)
      expect(result.ok).toBe(true)
      expect(result.status).toBe('active')
      expect(result.queued).toBe(true)
    })
  })

  describe('error gates', () => {
    it('rejects when no chat is found', () => {
      const result = handleEnsembleContinue(
        'missing-chat',
        { nextPrompt: 'x' },
        {
          getChat: () => null,
          saveChat: vi.fn(),
          queueFollowUpPrompt: vi.fn(),
          callingProvider: 'codex',
          callingParticipantId: 'codex-1'
        }
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('unknown_chat')
    })

    it('rejects when no Work Session is active', () => {
      const chat = makeChat({}, { workSession: undefined })
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue('chat-1', { nextPrompt: 'x' }, deps)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('no_active_work_session')
    })

    it('rejects when the Work Session is already paused', () => {
      const chat = makeChat({}, { workSession: makeWorkSession({ status: 'paused' }) })
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue('chat-1', { nextPrompt: 'x' }, deps)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('no_active_work_session')
      expect(result.status).toBe('paused')
    })

    it('rejects when the calling participant is not in allowedParticipantIds', () => {
      const chat = makeChat(
        {},
        {
          workSession: makeWorkSession({ allowedParticipantIds: ['claude-1'] })
        }
      )
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue('chat-1', { nextPrompt: 'x' }, deps)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('participant_not_allowed')
    })

    it('allows any enabled participant when allowedParticipantIds is null', () => {
      // null = no restriction. Sanity check the lookup doesn't
      // mis-handle the null case (e.g. throw on .includes()).
      const chat = makeChat(
        {},
        {
          workSession: makeWorkSession({ allowedParticipantIds: null })
        }
      )
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'x', acceptanceStatus: 'inProgress' },
        deps
      )
      expect(result.ok).toBe(true)
    })

    it('does not let a background lane advance or complete a Work Session', () => {
      const chat = makeChat(
        {},
        {
          participants: [makeParticipant({ stageRole: 'background' })],
          workSession: makeWorkSession({ allowedParticipantIds: null })
        }
      )
      const { deps, queueFollowUpPrompt } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'background tries to advance', acceptanceStatus: 'inProgress' },
        deps
      )

      expect(result).toMatchObject({
        ok: false,
        queued: false,
        error: 'participant_not_allowed'
      })
      expect(result.message).toContain('background lanes cannot advance or complete')
      expect(queueFollowUpPrompt).not.toHaveBeenCalled()
    })

    it('rejects when nextPrompt is missing for inProgress', () => {
      const chat = makeChat()
      const { deps, queueFollowUpPrompt } = makeDeps(chat)
      const result = handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress' }, deps)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('missing_next_prompt')
      expect(queueFollowUpPrompt).not.toHaveBeenCalled()
    })

    it('requires the Work Session manager to advance a managed session', () => {
      const chat = makeChat(
        {},
        {
          workSession: makeWorkSession({ managerParticipantId: 'boss-1' })
        }
      )
      const { deps, queueFollowUpPrompt } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { acceptanceStatus: 'inProgress', nextPrompt: 'continue' },
        deps
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('work_session_manager_required')
      expect(queueFollowUpPrompt).not.toHaveBeenCalled()
    })

    it('requires the Work Session manager to complete a managed session', () => {
      const chat = makeChat(
        {},
        {
          workSession: makeWorkSession({ managerParticipantId: 'boss-1' })
        }
      )
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { acceptanceStatus: 'complete', summary: 'done' },
        deps
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('work_session_manager_required')
      expect(chat.ensemble?.workSession?.status).toBe('active')
    })

    it('allows non-manager participants to pause a managed session as blocked', () => {
      const chat = makeChat(
        {},
        {
          workSession: makeWorkSession({ managerParticipantId: 'boss-1' })
        }
      )
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { acceptanceStatus: 'blocked', reason: 'Need user decision.' },
        deps
      )
      expect(result.ok).toBe(true)
      expect(result.status).toBe('paused')
      expect(chat.ensemble?.workSession?.status).toBe('paused')
    })

    it('rejects when a continuation is already queued (idempotency)', () => {
      const chat = makeChat(
        {},
        {
          activeRound: {
            roundId: 'round-1',
            status: 'running',
            prompt: 'p',
            startedAt: new Date().toISOString(),
            queuedPrompts: ['already-queued'],
            participants: []
          }
        }
      )
      const { deps, queueFollowUpPrompt } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'second-attempt', acceptanceStatus: 'inProgress' },
        deps
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('continuation_already_queued')
      expect(queueFollowUpPrompt).not.toHaveBeenCalled()
    })

    it('rejects when the round budget is exhausted', () => {
      const chat = makeChat(
        {},
        {
          workSession: makeWorkSession({
            maxRoundsPerProvider: 2,
            roundsUsed: { codex: 2, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0 },
            totalRoundsUsed: 2
          })
        }
      )
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'one more', acceptanceStatus: 'inProgress' },
        deps
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('budget_exhausted')
      expect(result.status).toBe('limit_reached')
      // Session status flips to limit_reached so subsequent calls
      // fail fast on the "no active work session" guard.
      expect(chat.ensemble?.workSession?.status).toBe('limit_reached')
    })

    it('rejects when the duration budget is exhausted', () => {
      const chat = makeChat(
        {},
        {
          workSession: makeWorkSession({
            startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
            maxDurationMs: 6 * 60 * 60 * 1000
          })
        }
      )
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'continue', acceptanceStatus: 'inProgress' },
        deps
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('budget_exhausted')
      expect(result.status).toBe('limit_reached')
    })

    it('rejects an invalid acceptanceStatus rather than coercing', () => {
      const chat = makeChat()
      const { deps } = makeDeps(chat)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'x', acceptanceStatus: 'finished' as never },
        deps
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('invalid_acceptance_status')
    })

    it('rejects when the queueFollowUpPrompt callback returns false (no active runtime)', () => {
      const chat = makeChat()
      const queueFollowUpPrompt = vi.fn(() => false)
      const result = handleEnsembleContinue(
        'chat-1',
        { nextPrompt: 'x', acceptanceStatus: 'inProgress' },
        {
          getChat: () => chat,
          saveChat: vi.fn(),
          queueFollowUpPrompt,
          callingProvider: 'codex',
          callingParticipantId: 'codex-1'
        }
      )
      expect(result.ok).toBe(false)
      expect(result.error).toBe('queue_failed')
    })
  })

  describe('no-progress guard (continuation loop)', () => {
    it('stops a participant looping on a byte-identical continuation', () => {
      const chat = makeChat()
      const { deps } = makeDeps(chat)
      const args = {
        acceptanceStatus: 'inProgress' as const,
        nextPrompt: 'verify the workspace',
        summary: 'all 12 tests pass'
      }
      // MAX_IDENTICAL_CONTINUATIONS = 2 → first two queue, the third is refused.
      expect(handleEnsembleContinue('chat-1', args, deps).queued).toBe(true)
      expect(handleEnsembleContinue('chat-1', args, deps).queued).toBe(true)
      const third = handleEnsembleContinue('chat-1', args, deps)
      expect(third.ok).toBe(false)
      expect(third.queued).toBe(false)
      expect(third.status).toBe('limit_reached')
      expect(third.error).toBe('no_progress')
      expect(chat.ensemble?.workSession?.status).toBe('limit_reached')
    })

    it('does NOT stop when nextPrompt changes each turn (real progress)', () => {
      const chat = makeChat()
      const { deps } = makeDeps(chat)
      const r1 = handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress', nextPrompt: 'step 1' }, deps)
      const r2 = handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress', nextPrompt: 'step 2' }, deps)
      const r3 = handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress', nextPrompt: 'step 3' }, deps)
      expect([r1.queued, r2.queued, r3.queued]).toEqual([true, true, true])
    })

    it('does NOT stop when a DIFFERENT participant reuses the same prompt (baton pass)', () => {
      const chat = makeChat()
      const codex = makeDeps(chat).deps
      handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress', nextPrompt: 'continue' }, codex)
      handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress', nextPrompt: 'continue' }, codex)
      // A different participant queueing the same prompt resets the counter.
      const claude = {
        ...makeDeps(chat).deps,
        callingParticipantId: 'claude-1',
        callingProvider: 'claude' as const
      }
      const result = handleEnsembleContinue(
        'chat-1',
        { acceptanceStatus: 'inProgress', nextPrompt: 'continue' },
        claude
      )
      expect(result.queued).toBe(true)
    })

    it('resets the counter when the same participant changes its summary', () => {
      const chat = makeChat()
      const { deps } = makeDeps(chat)
      handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress', nextPrompt: 'go', summary: 'a' }, deps)
      handleEnsembleContinue('chat-1', { acceptanceStatus: 'inProgress', nextPrompt: 'go', summary: 'a' }, deps)
      // Same prompt but a NEW summary = progress reported → counter resets, queues.
      const fresh = handleEnsembleContinue(
        'chat-1',
        { acceptanceStatus: 'inProgress', nextPrompt: 'go', summary: 'b' },
        deps
      )
      expect(fresh.queued).toBe(true)
    })
  })
})

describe('transitionWorkSession', () => {
  it('applies a partial patch and preserves untouched fields', () => {
    const config: EnsembleConfig = {
      enabled: true,
      maxParticipants: 4,
      participants: [],
      workSession: {
        enabled: true,
        status: 'active',
        objective: 'X',
        acceptanceCriteria: 'Y',
        allowedParticipantIds: null,
        permissionPresetId: 'workspace_write',
        maxRoundsPerProvider: 10,
        maxDurationMs: 1000,
        enableScoutPass: false,
        roundsUsed: { codex: 3, claude: 0, gemini: 0, kimi: 0, grok: 0, cursor: 0, ollama: 0, antigravity: 0 },
        totalRoundsUsed: 3
      }
    }
    const updated = transitionWorkSession(config, {
      status: 'completed',
      endedAt: '2026-05-26T00:00:00.000Z'
    })
    expect(updated.workSession?.status).toBe('completed')
    expect(updated.workSession?.endedAt).toBe('2026-05-26T00:00:00.000Z')
    // Untouched fields preserved
    expect(updated.workSession?.objective).toBe('X')
    expect(updated.workSession?.roundsUsed.codex).toBe(3)
    expect(updated.workSession?.totalRoundsUsed).toBe(3)
  })

  it('is a no-op when the config has no workSession', () => {
    const config: EnsembleConfig = {
      enabled: true,
      maxParticipants: 4,
      participants: []
    }
    const updated = transitionWorkSession(config, { status: 'completed' })
    expect(updated).toEqual(config)
  })
})
