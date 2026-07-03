import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildSoloScratchpadRecall,
  buildSoloWakeupResumePayload,
  resolveSoloWakeAtMs,
  SOLO_MAX_WAKEUP_DELAY_MS,
  SoloChatWakeupService
} from './SoloChatWakeupService'
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
      crossThreadRead: 'ask',
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
