import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildSoloScratchpadRecall,
  buildSoloWakeupResumePayload,
  isSoloWakeupResumePrompt,
  resolveSoloWakeAtMs,
  SOLO_MAX_WAKEUP_DELAY_MS,
  SoloChatWakeupService
} from './SoloChatWakeupService'
import { WakeupTimerService } from './WakeupTimerService'
import type { AgentRunPayload } from './run/AgentRunTypes'
import type {
  ChatMessage,
  ChatRecord,
  EffectiveRunPermissions,
  ExternalPathGrant,
  SoloChatWakeupRecord
} from './store/types'

/**
 * 1.0.5-EW37 — Tests for the solo-chat wakeup service.
 *
 * The pure helpers (`resolveSoloWakeAtMs`,
 * `buildSoloWakeupResumePayload`) are tested directly. The
 * orchestrator-style methods on the service use an in-memory fake
 * chat store + spy dispatch so we can verify persistence + fire
 * semantics without spinning up Electron/IPC.
 */

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-solo-1',
    title: 'Solo chat',
    chatKind: 'single',
    provider: 'codex',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeExternalPathGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'grant-1',
    provider: 'codex',
    path: '/Users/test/extra',
    kind: 'directory',
    access: 'read',
    duration: 'thisThread',
    createdAt: '2026-05-27T10:00:00.000Z',
    ...overrides
  }
}

function makeEffectivePermissions(
  overrides: Partial<EffectiveRunPermissions> = {}
): EffectiveRunPermissions {
  const externalPathGrants = overrides.externalPathGrants || [makeExternalPathGrant()]
  const base: EffectiveRunPermissions = {
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      externalPublish: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'deny',
      canvasInteraction: 'ask',
      meshCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'deny',
      mediaRecording: 'deny',
      canvasEval: 'ask'
    },
    networkAccess: 'deny',
    externalPathGrants,
    workspaceGrantServiceIds: ['mcpTools'],
    readOnly: true
  }
  return {
    ...base,
    ...overrides,
    presetId: overrides.presetId ?? base.presetId,
    approvalMode: overrides.approvalMode ?? base.approvalMode,
    agenticServices: overrides.agenticServices ?? base.agenticServices,
    networkAccess: overrides.networkAccess ?? base.networkAccess,
    externalPathGrants,
    workspaceGrantServiceIds: overrides.workspaceGrantServiceIds ?? base.workspaceGrantServiceIds,
    readOnly: overrides.readOnly ?? base.readOnly
  }
}

describe('resolveSoloWakeAtMs', () => {
  const NOW = 1_700_000_000_000

  it('parses an explicit wakeAt ISO string', () => {
    const iso = new Date(NOW + 5000).toISOString()
    expect(resolveSoloWakeAtMs({ wakeAt: iso }, NOW)).toBe(NOW + 5000)
  })

  it('adds delayMs to now when provided', () => {
    expect(resolveSoloWakeAtMs({ delayMs: 1500 }, NOW)).toBe(NOW + 1500)
  })

  it('converts delaySeconds to ms then adds to now', () => {
    expect(resolveSoloWakeAtMs({ delaySeconds: 30 }, NOW)).toBe(NOW + 30_000)
  })

  it('clamps a negative delayMs to 0 (no wakeup in the past from a negative)', () => {
    expect(resolveSoloWakeAtMs({ delayMs: -100 }, NOW)).toBe(NOW)
  })

  it('returns NaN for malformed wakeAt and falls through to delayMs', () => {
    expect(resolveSoloWakeAtMs({ wakeAt: 'not-a-date', delayMs: 200 }, NOW)).toBe(NOW + 200)
  })

  it('returns NaN when no input is provided', () => {
    expect(resolveSoloWakeAtMs({}, NOW)).toBeNaN()
  })
})

describe('buildSoloWakeupResumePayload', () => {
  it('produces a payload with a wakeup-resume prompt', () => {
    const chat = makeChat({ workspacePath: '/Users/test/workspace' })
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: 'solo-wakeup-x',
      chatId: chat.appChatId,
      provider: 'codex',
      scheduledAt: '2026-05-27T10:00:00.000Z',
      wakeAt: '2026-05-27T11:00:00.000Z',
      status: 'fired',
      reason: 'wait for build'
    }
    const payload = buildSoloWakeupResumePayload(
      chat,
      wakeup,
      'codex-run-99',
      '2026-05-27T11:00:00.000Z'
    )
    expect(payload.provider).toBe('codex')
    expect(payload.appChatId).toBe(chat.appChatId)
    expect(payload.appRunId).toBe('codex-run-99')
    expect(payload.workspace).toBe('/Users/test/workspace')
    expect(payload.scope).toBe('workspace')
    expect(payload.prompt).toContain('Resumed at 2026-05-27T11:00:00.000Z')
    expect(payload.prompt).toContain('wait for build')
    expect(payload.prompt).toContain('Continue your task')
  })

  it('uses scope=global when no workspace is bound', () => {
    const chat = makeChat({ workspacePath: undefined })
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: 'w',
      chatId: chat.appChatId,
      provider: 'claude',
      scheduledAt: '2026-05-27T10:00:00Z',
      wakeAt: '2026-05-27T11:00:00Z',
      status: 'fired'
    }
    const payload = buildSoloWakeupResumePayload(chat, wakeup, 'run-1', '2026-05-27T11:00:00Z')
    expect(payload.scope).toBe('global')
    expect(payload.workspace).toBeUndefined()
  })

  it('passes through linkedProviderSessionId when set', () => {
    const chat = makeChat({ linkedProviderSessionId: 'codex-session-abc' })
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: 'w',
      chatId: chat.appChatId,
      provider: 'codex',
      scheduledAt: '2026-05-27T10:00:00Z',
      wakeAt: '2026-05-27T11:00:00Z',
      status: 'fired'
    }
    const payload = buildSoloWakeupResumePayload(chat, wakeup, 'run-1', '2026-05-27T11:00:00Z')
    expect(payload.providerSessionId).toBe('codex-session-abc')
  })

  it('replays the captured permission posture into the resume payload', () => {
    const chat = makeChat({ workspacePath: '/Users/test/workspace' })
    const grant = makeExternalPathGrant({ path: '/Users/test/extra' })
    const effectivePermissions = makeEffectivePermissions({ externalPathGrants: [grant] })
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: 'w',
      chatId: chat.appChatId,
      provider: 'codex',
      scheduledAt: '2026-05-27T10:00:00Z',
      wakeAt: '2026-05-27T11:00:00Z',
      status: 'fired',
      resumePermissions: {
        approvalMode: 'plan',
        sessionTrust: false,
        externalPathGrants: [grant],
        effectivePermissions
      }
    }
    const payload = buildSoloWakeupResumePayload(chat, wakeup, 'run-1', '2026-05-27T11:00:00Z')
    expect(payload.approvalMode).toBe('plan')
    expect(payload.sessionTrust).toBe(false)
    expect(payload.externalPathGrants).toEqual([grant])
    expect(payload.effectivePermissions).toEqual(effectivePermissions)
  })

  it('produces a prompt without reason line when no reason was provided', () => {
    const chat = makeChat()
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: 'w',
      chatId: chat.appChatId,
      provider: 'codex',
      scheduledAt: '2026-05-27T10:00:00Z',
      wakeAt: '2026-05-27T11:00:00Z',
      status: 'fired'
    }
    const payload = buildSoloWakeupResumePayload(chat, wakeup, 'run-1', '2026-05-27T11:00:00Z')
    expect(payload.prompt).not.toContain('Reason recorded at schedule time')
  })

  it('1.0.7 — folds the scratchpad recall (last message + tool trace) into the prompt', () => {
    const chat = makeChat({
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: 'Refactor the auth module.',
          timestamp: '2026-05-27T09:00:00Z'
        },
        {
          id: 'a1',
          role: 'assistant',
          runId: 'run-prior',
          content: 'I split AuthService into AuthService + TokenStore and added tests.',
          timestamp: '2026-05-27T09:05:00Z',
          toolActivities: [
            { toolName: 'edit_file', status: 'success' },
            { toolName: 'edit_file', status: 'success' },
            { toolName: 'run_tests', status: 'success' }
          ]
        } as ChatMessage
      ]
    })
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: 'w',
      chatId: chat.appChatId,
      provider: 'codex',
      scheduledAt: '2026-05-27T10:00:00Z',
      wakeAt: '2026-05-27T11:00:00Z',
      status: 'fired'
    }
    const payload = buildSoloWakeupResumePayload(chat, wakeup, 'run-1', '2026-05-27T11:00:00Z')
    expect(payload.prompt).toContain('Where you left off before sleeping:')
    expect(payload.prompt).toContain('I split AuthService into AuthService + TokenStore')
    // De-duplicated tool trace with counts.
    expect(payload.prompt).toContain('edit_file ×2')
    expect(payload.prompt).toContain('run_tests')
    // The base continuation line is still present.
    expect(payload.prompt).toContain('Continue your task')
  })
})

describe('buildSoloScratchpadRecall', () => {
  it('returns empty string for a brand-new chat with no assistant turn', () => {
    expect(buildSoloScratchpadRecall(makeChat())).toBe('')
    expect(
      buildSoloScratchpadRecall(
        makeChat({
          messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: '2026-05-27T09:00:00Z' }]
        })
      )
    ).toBe('')
  })

  it('recalls the MOST RECENT substantive assistant message', () => {
    const recall = buildSoloScratchpadRecall(
      makeChat({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: 'First answer.',
            timestamp: '2026-05-27T09:00:00Z'
          } as ChatMessage,
          {
            id: 'a2',
            role: 'assistant',
            content: '   ',
            timestamp: '2026-05-27T09:01:00Z'
          } as ChatMessage,
          {
            id: 'a3',
            role: 'assistant',
            content: 'Latest substantive answer.',
            timestamp: '2026-05-27T09:02:00Z'
          } as ChatMessage
        ]
      })
    )
    expect(recall).toContain('Latest substantive answer.')
    expect(recall).not.toContain('First answer.')
  })

  it('truncates an over-long recalled message with an ellipsis', () => {
    const long = 'x'.repeat(5000)
    const recall = buildSoloScratchpadRecall(
      makeChat({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: long,
            timestamp: '2026-05-27T09:00:00Z'
          } as ChatMessage
        ]
      })
    )
    expect(recall.endsWith('…')).toBe(true)
    expect(recall.length).toBeLessThan(long.length)
  })

  it('omits the tool trace when the turn ran no tools', () => {
    const recall = buildSoloScratchpadRecall(
      makeChat({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: 'Pure prose, no tools.',
            timestamp: '2026-05-27T09:00:00Z'
          } as ChatMessage
        ]
      })
    )
    expect(recall).toContain('Pure prose, no tools.')
    expect(recall).not.toContain('Tools you used')
  })
})

describe('SoloChatWakeupService — scheduleWakeup', () => {
  let chats: Map<string, ChatRecord>
  let saved: ChatRecord[]
  let scheduledTimers: SoloChatWakeupRecord[]
  let dispatched: number
  let service: SoloChatWakeupService

  beforeEach(() => {
    chats = new Map<string, ChatRecord>()
    saved = []
    scheduledTimers = []
    dispatched = 0
    service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => {
        chats.set(chat.appChatId, chat)
        saved.push(chat)
      },
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => {
        dispatched++
        return { dispatched: true, appRunId: 'run-x' }
      },
      scheduleWakeupTimer: (wakeup) => {
        scheduledTimers.push(wakeup)
      },
      cancelWakeupTimer: () => {},
      createRunId: (provider) => `${provider}-run-${Math.random().toString(36).slice(2, 8)}`,
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T10:00:00.000Z'
    })
    const chat = makeChat()
    chats.set(chat.appChatId, chat)
  })

  it('rejects when chat id is empty', () => {
    const result = service.scheduleWakeup('', 'codex', 'run-1', { delayMs: 100 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/chat id/)
  })

  it('rejects when chat does not exist', () => {
    const result = service.scheduleWakeup('unknown-chat', 'codex', 'run-1', { delayMs: 100 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No chat matches/)
  })

  it('rejects when chat is an ensemble chat', () => {
    chats.set('chat-ensemble', makeChat({ appChatId: 'chat-ensemble', chatKind: 'ensemble' }))
    const result = service.scheduleWakeup('chat-ensemble', 'codex', 'run-1', { delayMs: 100 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/ensemble round path/)
  })

  it('rejects when no wakeAt/delay is provided', () => {
    const result = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/wakeAt, delayMs, or delaySeconds/)
  })

  it('rejects when delay exceeds 7 days', () => {
    const result = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', {
      delayMs: SOLO_MAX_WAKEUP_DELAY_MS + 1
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/max delay is 7 days/)
  })

  it('persists the wakeup + arms a timer on success', () => {
    const result = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    expect(result.ok).toBe(true)
    expect(result.wakeup?.status).toBe('pending')
    expect(result.wakeup?.provider).toBe('codex')
    expect(saved).toHaveLength(1)
    expect(saved[0].soloWakeups).toBeDefined()
    expect(scheduledTimers).toHaveLength(1)
  })

  it('persists the active run permission posture on the wakeup', () => {
    const grant = makeExternalPathGrant()
    const effectivePermissions = makeEffectivePermissions({ externalPathGrants: [grant] })
    const result = service.scheduleWakeup(
      'chat-solo-1',
      'codex',
      'run-1',
      { delayMs: 60_000 },
      {
        approvalMode: 'plan',
        sessionTrust: false,
        externalPathGrants: [grant],
        effectivePermissions
      }
    )
    expect(result.ok).toBe(true)
    const wakeup = saved[0].soloWakeups?.[result.wakeup!.wakeupId]
    expect(wakeup?.resumePermissions?.approvalMode).toBe('plan')
    expect(wakeup?.resumePermissions?.sessionTrust).toBe(false)
    expect(wakeup?.resumePermissions?.externalPathGrants).toEqual([grant])
    expect(wakeup?.resumePermissions?.effectivePermissions).toEqual(effectivePermissions)
  })

  it('does not persist or replay run-only external path authority into a wakeup', () => {
    const threadGrant = makeExternalPathGrant({ id: 'thread-grant' })
    const runGrant = makeExternalPathGrant({
      id: 'run-grant',
      duration: 'thisRun',
      appRunId: 'run-1'
    })
    const effectivePermissions = makeEffectivePermissions({
      externalPathGrants: [threadGrant, runGrant]
    })
    const result = service.scheduleWakeup(
      'chat-solo-1',
      'codex',
      'run-1',
      { delayMs: 60_000 },
      {
        externalPathGrants: [threadGrant, runGrant],
        effectivePermissions
      }
    )

    expect(result.ok).toBe(true)
    const wakeup = saved[0].soloWakeups?.[result.wakeup!.wakeupId]
    expect(wakeup?.resumePermissions?.externalPathGrants).toEqual([threadGrant])
    expect(wakeup?.resumePermissions?.effectivePermissions?.externalPathGrants).toEqual([
      threadGrant
    ])
  })

  it('rejects when chat already has a pending wakeup', () => {
    service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    const result = service.scheduleWakeup('chat-solo-1', 'codex', 'run-2', { delayMs: 60_000 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already has a pending wakeup/)
  })

  it('does NOT dispatch a run at schedule time (fire-time only)', () => {
    service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    expect(dispatched).toBe(0)
  })
})

describe('SoloChatWakeupService — cancelWakeup', () => {
  let chats: Map<string, ChatRecord>
  let cancelledTimers: string[]
  let service: SoloChatWakeupService

  beforeEach(() => {
    chats = new Map<string, ChatRecord>()
    cancelledTimers = []
    service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => chats.set(chat.appChatId, chat),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => ({ dispatched: true, appRunId: 'r' }),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: (id) => {
        cancelledTimers.push(id)
      },
      createRunId: () => 'run-id',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T10:00:00.000Z'
    })
    const chat = makeChat()
    chats.set(chat.appChatId, chat)
  })

  it('returns ok with empty list when chat has no pending wakeups', () => {
    const result = service.cancelWakeup('chat-solo-1')
    expect(result.ok).toBe(true)
    expect(result.cancelled).toEqual([])
  })

  it('rejects when chat id is empty', () => {
    const result = service.cancelWakeup('')
    expect(result.ok).toBe(false)
  })

  it('cancels all pending wakeups when no id is provided', () => {
    service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    const result = service.cancelWakeup('chat-solo-1')
    expect(result.ok).toBe(true)
    expect(result.cancelled?.length).toBe(1)
    expect(result.cancelled?.[0].status).toBe('cancelled')
    expect(cancelledTimers.length).toBe(1)
  })

  it('cancels exactly the wakeupId provided', () => {
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    const id = scheduled.wakeup!.wakeupId
    const result = service.cancelWakeup('chat-solo-1', id)
    expect(result.ok).toBe(true)
    expect(result.cancelled?.[0].wakeupId).toBe(id)
  })

  it('rejects with not-found error when wakeupId does not match', () => {
    service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    const result = service.cancelWakeup('chat-solo-1', 'non-existent')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No matching pending wakeup/)
  })
})

describe('SoloChatWakeupService — cancelWakeupsOnUserInput', () => {
  let chats: Map<string, ChatRecord>
  let cancelledTimers: string[]
  let service: SoloChatWakeupService

  beforeEach(() => {
    chats = new Map<string, ChatRecord>()
    cancelledTimers = []
    service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => chats.set(chat.appChatId, chat),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => ({ dispatched: true, appRunId: 'r' }),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: (id) => {
        cancelledTimers.push(id)
      },
      createRunId: () => 'run-id',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T10:00:00.000Z'
    })
  })

  it('cancels pending wakeups when cancelOnUserInput defaults to true', () => {
    const chat = makeChat()
    chats.set(chat.appChatId, chat)
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', {
      delayMs: 60_000
    })
    expect(scheduled.wakeup?.cancelOnUserInput).toBe(true)

    const cancelled = service.cancelWakeupsOnUserInput('chat-solo-1')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0].status).toBe('cancelled')
    expect(cancelledTimers).toEqual([scheduled.wakeup!.wakeupId])
    expect(chats.get('chat-solo-1')?.soloWakeups?.[scheduled.wakeup!.wakeupId]?.status).toBe(
      'cancelled'
    )
  })

  it('retains pending wakeups when cancelOnUserInput is explicitly false', () => {
    const chat = makeChat()
    chats.set(chat.appChatId, chat)
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', {
      delayMs: 60_000,
      cancelOnUserInput: false
    })
    expect(scheduled.wakeup?.cancelOnUserInput).toBe(false)

    const cancelled = service.cancelWakeupsOnUserInput('chat-solo-1')
    expect(cancelled).toEqual([])
    expect(cancelledTimers).toEqual([])
    expect(chats.get('chat-solo-1')?.soloWakeups?.[scheduled.wakeup!.wakeupId]?.status).toBe(
      'pending'
    )
  })

  it('does not touch ensemble chat wakeups (ensemble path owns those)', () => {
    const ensembleChat = makeChat({
      appChatId: 'chat-ensemble-1',
      chatKind: 'ensemble',
      soloWakeups: {
        'solo-should-not-exist': {
          wakeupId: 'solo-should-not-exist',
          chatId: 'chat-ensemble-1',
          provider: 'codex',
          scheduledAt: '2026-05-27T10:00:00.000Z',
          wakeAt: '2026-05-27T11:00:00.000Z',
          status: 'pending',
          cancelOnUserInput: true
        }
      }
    })
    chats.set(ensembleChat.appChatId, ensembleChat)

    const cancelled = service.cancelWakeupsOnUserInput('chat-ensemble-1')
    expect(cancelled).toEqual([])
    expect(cancelledTimers).toEqual([])
    expect(
      chats.get('chat-ensemble-1')?.soloWakeups?.['solo-should-not-exist']?.status
    ).toBe('pending')
  })

  it('returns empty when chat has no pending wakeups', () => {
    chats.set(makeChat().appChatId, makeChat())
    expect(service.cancelWakeupsOnUserInput('chat-solo-1')).toEqual([])
  })
})

describe('isSoloWakeupResumePrompt', () => {
  it('matches the main-built solo wakeup resume preamble', () => {
    const chat = makeChat()
    const wakeup: SoloChatWakeupRecord = {
      wakeupId: 'w1',
      chatId: chat.appChatId,
      provider: 'codex',
      scheduledAt: '2026-05-27T10:00:00.000Z',
      wakeAt: '2026-05-27T11:00:00.000Z',
      status: 'pending'
    }
    const payload = buildSoloWakeupResumePayload(chat, wakeup, 'run-1', '2026-05-27T11:00:00Z')
    expect(isSoloWakeupResumePrompt(payload.prompt)).toBe(true)
  })

  it('rejects ordinary user prompts', () => {
    expect(isSoloWakeupResumePrompt('Please continue the refactor.')).toBe(false)
    expect(isSoloWakeupResumePrompt('')).toBe(false)
    expect(isSoloWakeupResumePrompt(undefined)).toBe(false)
  })
})

describe('SoloChatWakeupService — handleWakeupFired', () => {
  let chats: Map<string, ChatRecord>
  let dispatchCalls: number
  let dispatchPayloads: AgentRunPayload[]
  let service: SoloChatWakeupService

  beforeEach(() => {
    chats = new Map<string, ChatRecord>()
    dispatchCalls = 0
    dispatchPayloads = []
    service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => chats.set(chat.appChatId, chat),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async (payload) => {
        dispatchCalls++
        dispatchPayloads.push(payload)
        return { dispatched: true, appRunId: 'r' }
      },
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: () => {},
      createRunId: () => 'run-fired-1',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T11:00:00.000Z'
    })
    const chat = makeChat()
    chats.set(chat.appChatId, chat)
  })

  it('returns false when no record matches the wakeupId', async () => {
    const handled = await service.handleWakeupFired('unknown-wakeup-id')
    expect(handled).toBe(false)
    expect(dispatchCalls).toBe(0)
  })

  it('returns true and dispatches when a pending record matches', async () => {
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    const id = scheduled.wakeup!.wakeupId
    const handled = await service.handleWakeupFired(id)
    expect(handled).toBe(true)
    expect(dispatchCalls).toBe(1)
  })

  it('marks the record fired in the persistent store', async () => {
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    const id = scheduled.wakeup!.wakeupId
    await service.handleWakeupFired(id)
    const chat = chats.get('chat-solo-1')!
    expect(chat.soloWakeups?.[id].status).toBe('fired')
    expect(chat.soloWakeups?.[id].firedAt).toBeDefined()
  })

  it('dispatches the resumed run with the stored permission posture', async () => {
    const grant = makeExternalPathGrant()
    const effectivePermissions = makeEffectivePermissions({ externalPathGrants: [grant] })
    const scheduled = service.scheduleWakeup(
      'chat-solo-1',
      'codex',
      'run-1',
      { delayMs: 60_000 },
      {
        approvalMode: 'plan',
        sessionTrust: false,
        externalPathGrants: [grant],
        effectivePermissions
      }
    )
    await service.handleWakeupFired(scheduled.wakeup!.wakeupId)
    expect(dispatchPayloads).toHaveLength(1)
    expect(dispatchPayloads[0].approvalMode).toBe('plan')
    expect(dispatchPayloads[0].sessionTrust).toBe(false)
    expect(dispatchPayloads[0].externalPathGrants).toEqual([grant])
    expect(dispatchPayloads[0].effectivePermissions).toEqual(effectivePermissions)
  })

  it('does not double-fire a non-pending record', async () => {
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'run-1', { delayMs: 60_000 })
    const id = scheduled.wakeup!.wakeupId
    await service.handleWakeupFired(id)
    expect(dispatchCalls).toBe(1)
    await service.handleWakeupFired(id) // already fired
    expect(dispatchCalls).toBe(1)
  })

  it('expires the record when dispatch throws', async () => {
    const failingService = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => chats.set(chat.appChatId, chat),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => {
        throw new Error('preflight rejection')
      },
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: () => {},
      createRunId: () => 'run-fail-1',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T11:00:00.000Z'
    })
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scheduled = failingService.scheduleWakeup('chat-solo-1', 'codex', 'run-1', {
      delayMs: 60_000
    })
    const id = scheduled.wakeup!.wakeupId
    const handled = await failingService.handleWakeupFired(id)
    expect(handled).toBe(true)
    const chat = chats.get('chat-solo-1')!
    expect(chat.soloWakeups?.[id].status).toBe('expired')
    consoleWarnSpy.mockRestore()
  })

  it('expires the exact record when dispatch resolves without starting a run', async () => {
    const declinedService = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => chats.set(chat.appChatId, chat),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async (payload) => ({
        dispatched: false,
        appRunId: payload.appRunId || 'run-declined-1'
      }),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: () => {},
      createRunId: () => 'run-declined-1',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T11:00:00.000Z'
    })
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scheduled = declinedService.scheduleWakeup('chat-solo-1', 'codex', 'run-1', {
      delayMs: 60_000
    })

    const handled = await declinedService.handleWakeupFired(scheduled.wakeup!.wakeupId)

    expect(handled).toBe(true)
    expect(chats.get('chat-solo-1')?.soloWakeups?.[scheduled.wakeup!.wakeupId]).toMatchObject({
      status: 'expired',
      expiredAt: '2026-05-27T11:00:00.000Z'
    })
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(scheduled.wakeup!.wakeupId),
      expect.stringContaining('declined')
    )
    consoleWarnSpy.mockRestore()
  })
})

describe('SoloChatWakeupService — getAllPersistedWakeups', () => {
  it('collects pending records across all solo chats', () => {
    const chats = new Map<string, ChatRecord>()
    const chatA = makeChat({ appChatId: 'a' })
    const chatB = makeChat({ appChatId: 'b' })
    chats.set('a', chatA)
    chats.set('b', chatB)
    const service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => chats.set(chat.appChatId, chat),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => ({ dispatched: true, appRunId: 'r' }),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: () => {},
      createRunId: () => 'rid',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T10:00:00.000Z'
    })
    service.scheduleWakeup('a', 'codex', 'r1', { delayMs: 60_000 })
    service.scheduleWakeup('b', 'claude', 'r2', { delayMs: 60_000 })
    expect(service.getAllPersistedWakeups()).toHaveLength(2)
  })

  it('skips ensemble chats', () => {
    const chats = new Map<string, ChatRecord>()
    const ens = makeChat({ appChatId: 'e', chatKind: 'ensemble' })
    chats.set('e', ens)
    // Inject a fake wakeup directly into the ensemble chat to verify
    // it gets skipped. We can't go through scheduleWakeup because that
    // refuses ensemble chats.
    ens.soloWakeups = {
      stale: {
        wakeupId: 'stale',
        chatId: 'e',
        provider: 'codex',
        scheduledAt: '2026-05-27T10:00:00Z',
        wakeAt: '2026-05-27T11:00:00Z',
        status: 'pending'
      }
    }
    const service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: () => {},
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => ({ dispatched: true, appRunId: 'r' }),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: () => {},
      createRunId: () => 'rid',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T10:00:00.000Z'
    })
    expect(service.getAllPersistedWakeups()).toEqual([])
  })

  it('skips cancelled / fired / expired records', () => {
    const chats = new Map<string, ChatRecord>()
    const chat = makeChat()
    chats.set(chat.appChatId, chat)
    const service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (c) => chats.set(c.appChatId, c),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => ({ dispatched: true, appRunId: 'r' }),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: () => {},
      createRunId: () => 'rid',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T10:00:00.000Z'
    })
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'r1', { delayMs: 60_000 })
    service.cancelWakeup('chat-solo-1', scheduled.wakeup!.wakeupId)
    expect(service.getAllPersistedWakeups()).toEqual([])
  })
})

describe('SoloChatWakeupService — expireWakeup', () => {
  it('writes status=expired with the supplied timestamp', () => {
    const chats = new Map<string, ChatRecord>()
    const chat = makeChat()
    chats.set(chat.appChatId, chat)
    const service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (c) => chats.set(c.appChatId, c),
      listChats: () => Array.from(chats.values()),
      dispatchRun: async () => ({ dispatched: true, appRunId: 'r' }),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: () => {},
      createRunId: () => 'rid',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T10:00:00.000Z'
    })
    const scheduled = service.scheduleWakeup('chat-solo-1', 'codex', 'r1', { delayMs: 60_000 })
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    service.expireWakeup(scheduled.wakeup!, '2026-05-28T00:00:00Z', 'past grace window')
    const chatAfter = chats.get('chat-solo-1')!
    expect(chatAfter.soloWakeups?.[scheduled.wakeup!.wakeupId].status).toBe('expired')
    expect(chatAfter.soloWakeups?.[scheduled.wakeup!.wakeupId].expiredAt).toBe(
      '2026-05-28T00:00:00Z'
    )
    consoleWarnSpy.mockRestore()
  })
})

describe('SoloChatWakeupService — destructive history fence', () => {
  function createHistoryHarness(initialChats: ChatRecord[]): {
    chats: Map<string, ChatRecord>
    cancelledTimers: string[]
    dispatches: AgentRunPayload[]
    service: SoloChatWakeupService
    setDispatch: (
      dispatch: (payload: AgentRunPayload) => Promise<{ dispatched: boolean; appRunId: string }>
    ) => void
  } {
    const chats = new Map(initialChats.map((chat) => [chat.appChatId, chat]))
    const cancelledTimers: string[] = []
    const dispatches: AgentRunPayload[] = []
    let dispatchImpl = async (payload: AgentRunPayload) => {
      dispatches.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || 'run' }
    }
    const service = new SoloChatWakeupService({
      getChat: (id) => chats.get(id),
      saveChat: (chat) => chats.set(chat.appChatId, chat),
      listChats: () => chats.values(),
      dispatchRun: (payload) => dispatchImpl(payload),
      scheduleWakeupTimer: () => {},
      cancelWakeupTimer: (wakeupId) => {
        cancelledTimers.push(wakeupId)
      },
      createRunId: () => 'history-wakeup-run',
      now: () => 1_700_000_000_000,
      nowIso: () => '2026-05-27T11:00:00.000Z'
    })
    return {
      chats,
      cancelledTimers,
      dispatches,
      service,
      setDispatch: (dispatch) => {
        dispatchImpl = dispatch
      }
    }
  }

  function deferredDispatch(): {
    promise: Promise<{ dispatched: boolean; appRunId: string }>
    resolve: () => void
    reject: (error: Error) => void
  } {
    let resolvePromise!: (result: { dispatched: boolean; appRunId: string }) => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<{ dispatched: boolean; appRunId: string }>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    return {
      promise,
      resolve: () => resolvePromise({ dispatched: true, appRunId: 'history-wakeup-run' }),
      reject: rejectPromise
    }
  }

  it('scoped truncate cancels its timer, exactly joins an already-fired callback, and cannot resurrect the transcript', async () => {
    const harness = createHistoryHarness([
      makeChat({
        appChatId: 'chat-a',
        messages: [
          {
            id: 'before-clear',
            role: 'assistant',
            content: 'must stay deleted',
            timestamp: '2026-05-27T10:00:00.000Z'
          }
        ]
      }),
      makeChat({ appChatId: 'chat-b' })
    ])
    const wakeA = harness.service.scheduleWakeup('chat-a', 'codex', 'run-a', {
      delayMs: 60_000
    }).wakeup!
    const wakeB = harness.service.scheduleWakeup('chat-b', 'codex', 'run-b', {
      delayMs: 60_000
    }).wakeup!
    const dispatch = deferredDispatch()
    harness.setDispatch((payload) => {
      harness.dispatches.push(payload)
      return dispatch.promise
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const firing = harness.service.handleWakeupFired(wakeA.wakeupId)
    await vi.waitFor(() => expect(harness.dispatches).toHaveLength(1))
    const hold = harness.service.beginHistoryClear({ kind: 'chat', chatIds: ['chat-a'] })
    let joined = false
    void hold.completion.then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)

    const current = harness.chats.get('chat-a')!
    harness.chats.set('chat-a', {
      ...current,
      messages: [],
      runs: [],
      soloWakeups: undefined
    })
    dispatch.reject(new Error('dispatch rejected by history generation'))
    await firing
    await hold.completion
    expect(joined).toBe(true)
    expect(harness.chats.get('chat-a')?.messages).toEqual([])
    expect(harness.chats.get('chat-a')?.soloWakeups).toBeUndefined()
    expect(harness.chats.get('chat-b')?.soloWakeups?.[wakeB.wakeupId]?.status).toBe('pending')
    expect(harness.cancelledTimers).not.toContain(wakeB.wakeupId)
    expect(harness.service.endHistoryClear(hold)).toBe(true)
    warning.mockRestore()
  })

  it('scoped delete joins an in-flight rejection without saving the stale deleted chat', async () => {
    const harness = createHistoryHarness([makeChat({ appChatId: 'chat-delete' })])
    const wakeup = harness.service.scheduleWakeup('chat-delete', 'codex', 'run-a', {
      delayMs: 60_000
    }).wakeup!
    const dispatch = deferredDispatch()
    harness.setDispatch((payload) => {
      harness.dispatches.push(payload)
      return dispatch.promise
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const firing = harness.service.handleWakeupFired(wakeup.wakeupId)
    await vi.waitFor(() => expect(harness.dispatches).toHaveLength(1))
    const hold = harness.service.beginHistoryClear({
      kind: 'chat',
      chatIds: ['chat-delete']
    })
    harness.chats.delete('chat-delete')
    dispatch.reject(new Error('chat deleted'))
    await Promise.all([firing, hold.completion])

    expect(harness.chats.has('chat-delete')).toBe(false)
    expect(harness.service.endHistoryClear(hold)).toBe(true)
    warning.mockRestore()
  })

  it('rejects a queued fire after the scoped generation changes, before persistence or dispatch', async () => {
    const harness = createHistoryHarness([makeChat({ appChatId: 'chat-due' })])
    const wakeup = harness.service.scheduleWakeup('chat-due', 'codex', 'run-a', {
      delayMs: 60_000
    }).wakeup!

    // handleWakeupFired registers the activity synchronously but defers its
    // first side effect. Beginning deletion in the same stack invalidates it.
    const firing = harness.service.handleWakeupFired(wakeup.wakeupId)
    const hold = harness.service.beginHistoryClear({ kind: 'chat', chatIds: ['chat-due'] })
    await Promise.all([firing, hold.completion])

    expect(harness.dispatches).toEqual([])
    expect(harness.chats.get('chat-due')?.soloWakeups?.[wakeup.wakeupId]?.status).toBe('pending')
    expect(harness.cancelledTimers).toContain(wakeup.wakeupId)
    expect(harness.service.endHistoryClear(hold)).toBe(true)
  })

  it('workspace clear fences every chat in that workspace while preserving other-workspace timers', async () => {
    const harness = createHistoryHarness([
      makeChat({ appChatId: 'workspace-a-existing', workspaceId: 'workspace-a' }),
      makeChat({ appChatId: 'workspace-a-new', workspaceId: 'workspace-a' }),
      makeChat({ appChatId: 'workspace-b', workspaceId: 'workspace-b' })
    ])
    const wakeA = harness.service.scheduleWakeup('workspace-a-existing', 'codex', 'run-a', {
      delayMs: 60_000
    }).wakeup!
    const wakeB = harness.service.scheduleWakeup('workspace-b', 'codex', 'run-b', {
      delayMs: 60_000
    }).wakeup!

    const hold = harness.service.beginHistoryClear({
      kind: 'workspace',
      workspaceId: 'workspace-a',
      chatIds: ['workspace-a-existing', 'workspace-a-new']
    })
    await hold.completion

    expect(harness.cancelledTimers).toContain(wakeA.wakeupId)
    expect(harness.cancelledTimers).not.toContain(wakeB.wakeupId)
    expect(
      harness.service.scheduleWakeup('workspace-a-new', 'codex', 'run-new', {
        delayMs: 60_000
      })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/history is being cleared/i) })
    expect(harness.service.endHistoryClear(hold)).toBe(true)
    expect(
      harness.service.scheduleWakeup('workspace-a-new', 'codex', 'run-new', {
        delayMs: 60_000
      }).ok
    ).toBe(true)
  })

  it('global clear cancels all pending timer records and blocks all new wakeup admission', async () => {
    const harness = createHistoryHarness([
      makeChat({ appChatId: 'global-chat' }),
      makeChat({ appChatId: 'workspace-chat', workspaceId: 'workspace-a' }),
      makeChat({ appChatId: 'empty-chat', workspaceId: 'workspace-b' })
    ])
    const globalWake = harness.service.scheduleWakeup('global-chat', 'codex', 'run-a', {
      delayMs: 60_000
    }).wakeup!
    const workspaceWake = harness.service.scheduleWakeup('workspace-chat', 'codex', 'run-b', {
      delayMs: 60_000
    }).wakeup!

    const hold = harness.service.beginHistoryClear({ kind: 'global' })
    await hold.completion

    expect(harness.cancelledTimers).toEqual(
      expect.arrayContaining([globalWake.wakeupId, workspaceWake.wakeupId])
    )
    expect(
      harness.service.scheduleWakeup('empty-chat', 'codex', 'run-new', { delayMs: 60_000 })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/history is being cleared/i) })
    expect(harness.service.endHistoryClear(hold)).toBe(true)
    expect(harness.service.endHistoryClear(hold)).toBe(false)
  })

  it('removes the armed wall-clock timer so advancing time after commit cannot fire it', async () => {
    vi.useFakeTimers()
    try {
      const chat = makeChat({ appChatId: 'timer-chat' })
      const chats = new Map([[chat.appChatId, chat]])
      const dispatchRun = vi.fn(async () => ({ dispatched: true, appRunId: 'late-run' }))
      const serviceRef: { current?: SoloChatWakeupService } = {}
      const timer = new WakeupTimerService({
        now: () => 1_700_000_000_000,
        onFire: (wakeupId) => {
          void serviceRef.current?.handleWakeupFired(wakeupId)
        }
      })
      const service = new SoloChatWakeupService({
        getChat: (id) => chats.get(id),
        saveChat: (next) => chats.set(next.appChatId, next),
        listChats: () => chats.values(),
        dispatchRun,
        scheduleWakeupTimer: (wakeup) => timer.schedule(wakeup),
        cancelWakeupTimer: (wakeupId) => {
          timer.cancel(wakeupId)
        },
        createRunId: () => 'late-run',
        now: () => 1_700_000_000_000,
        nowIso: () => '2026-05-27T11:00:00.000Z'
      })
      serviceRef.current = service
      const wakeup = service.scheduleWakeup('timer-chat', 'codex', 'run-a', {
        delayMs: 60_000
      }).wakeup!
      expect(timer.has(wakeup.wakeupId)).toBe(true)

      const hold = service.beginHistoryClear({ kind: 'chat', chatIds: ['timer-chat'] })
      await hold.completion
      expect(timer.has(wakeup.wakeupId)).toBe(false)
      // Model the outer truncate commit before releasing the process-local hold.
      chats.set('timer-chat', { ...chats.get('timer-chat')!, soloWakeups: undefined })
      expect(service.endHistoryClear(hold)).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(dispatchRun).not.toHaveBeenCalled()
      expect(chats.get('timer-chat')?.soloWakeups).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never expires over a newer exact wakeup record after an unrelated dispatch rejection', async () => {
    const harness = createHistoryHarness([makeChat({ appChatId: 'chat-replaced' })])
    const wakeup = harness.service.scheduleWakeup('chat-replaced', 'codex', 'run-a', {
      delayMs: 60_000
    }).wakeup!
    const dispatch = deferredDispatch()
    harness.setDispatch((payload) => {
      harness.dispatches.push(payload)
      return dispatch.promise
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const firing = harness.service.handleWakeupFired(wakeup.wakeupId)
    await vi.waitFor(() => expect(harness.dispatches).toHaveLength(1))
    const current = harness.chats.get('chat-replaced')!
    harness.chats.set('chat-replaced', {
      ...current,
      soloWakeups: {
        ...current.soloWakeups,
        [wakeup.wakeupId]: {
          ...current.soloWakeups![wakeup.wakeupId],
          status: 'cancelled',
          cancelledAt: '2026-05-27T11:00:01.000Z'
        }
      }
    })
    dispatch.reject(new Error('preflight failed'))
    await firing

    expect(harness.chats.get('chat-replaced')?.soloWakeups?.[wakeup.wakeupId]).toMatchObject({
      status: 'cancelled',
      cancelledAt: '2026-05-27T11:00:01.000Z'
    })
    warning.mockRestore()
  })
})
