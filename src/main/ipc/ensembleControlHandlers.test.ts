import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import {
  blackboardQueuedEnsemblePrompt,
  registerEnsembleControlHandlers,
  type EnsembleControlHandlerDeps
} from './ensembleControlHandlers'
import { makeBlackboardEntry, upsertBlackboardEntry } from '../blackboard/Blackboard'
import type { BlackboardEntry, ChatRecord } from '../store/types'
import type { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'

type OrchestratorStub = Pick<EnsembleOrchestrator, 'steerQueuedPrompt' | 'removeQueuedPrompt'>

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../blackboard/Blackboard', () => ({
  makeBlackboardEntry: vi.fn(),
  upsertBlackboardEntry: vi.fn(),
  formatBlackboardCapacityNotice: vi.fn(() => 'Blackboard is full.')
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedMakeEntry = vi.mocked(makeBlackboardEntry)
const mockedUpsert = vi.mocked(upsertBlackboardEntry)

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

const EVENT = { sender: { id: 1 } }

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function ensembleChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    workspaceId: 'ws-1',
    scope: 'workspace',
    ensemble: {
      activeRound: { roundId: 'round-1' },
      blackboard: [],
      blackboardTombstones: []
    },
    updatedAt: 1,
    ...overrides
  } as unknown as ChatRecord
}

const ENTRY = {
  id: 'entry-1',
  key: 'queued-note',
  value: 'queued text'
} as unknown as BlackboardEntry

interface Harness {
  deps: EnsembleControlHandlerDeps
  orchestrator: {
    steerQueuedPrompt: Mock<OrchestratorStub['steerQueuedPrompt']>
    removeQueuedPrompt: Mock<OrchestratorStub['removeQueuedPrompt']>
  } | null
  setOrchestrator: (next: Harness['orchestrator']) => void
  calls: string[]
}

function harness(overrides: Partial<EnsembleControlHandlerDeps> = {}): Harness {
  const calls: string[] = []
  let orchestrator: Harness['orchestrator'] = {
    steerQueuedPrompt: vi.fn<OrchestratorStub['steerQueuedPrompt']>(() => ({
      status: 'steered'
    })),
    removeQueuedPrompt: vi.fn<OrchestratorStub['removeQueuedPrompt']>(() => ({
      ok: true,
      prompt: 'queued text'
    }))
  }
  const deps: EnsembleControlHandlerDeps = {
    getEnsembleOrchestrator: () => orchestrator,
    isEnsembleModeEnabled: () => true,
    getChat: vi.fn(() => ensembleChat()),
    requireNonEmptyString: (value, label) => {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
      return value
    },
    assertSenderChatScope: vi.fn(() => {
      calls.push('scope')
    }),
    assertScheduledEnsembleInteractiveAvailable: vi.fn(() => {
      calls.push('scheduled')
    }),
    broadcastChatUpdated: vi.fn(() => {
      calls.push('broadcastChatUpdated')
    }),
    broadcastThreadUpdate: vi.fn(() => {
      calls.push('broadcastThreadUpdate')
    }),
    saveAndBroadcastChat: vi.fn(() => {
      calls.push('saveAndBroadcastChat')
    }),
    pushRemoteThreadSnapshot: vi.fn(() => {
      calls.push('pushRemoteThreadSnapshot')
    }),
    pushRemoteTaskCardDelta: vi.fn(() => {
      calls.push('pushRemoteTaskCardDelta')
    }),
    canonicalRemoteWorkspaceId: vi.fn(() => 'ws-1'),
    ...overrides
  }
  const self: Harness = {
    deps,
    get orchestrator() {
      return orchestrator
    },
    setOrchestrator: (next) => {
      orchestrator = next
    },
    calls
  }
  return self
}

beforeEach(() => {
  mockedHandle.mockReset()
  mockedMakeEntry.mockReset()
  mockedUpsert.mockReset()
  mockedMakeEntry.mockReturnValue(ENTRY)
  mockedUpsert.mockReturnValue({ ok: true, entries: [ENTRY], tombstones: [] } as never)
})

describe('registerEnsembleControlHandlers', () => {
  it('registers exactly the three queue-control channels, in order', () => {
    registerEnsembleControlHandlers(harness().deps)
    expect(mockedHandle.mock.calls.map(([channel]) => channel)).toEqual([
      'steer-queued-ensemble-prompt',
      'remove-queued-ensemble-prompt',
      'blackboard-queued-ensemble-prompt'
    ])
  })

  it('refuses every channel while Ensemble Mode is disabled', async () => {
    registerEnsembleControlHandlers(harness({ isEnsembleModeEnabled: () => false }).deps)
    for (const channel of [
      'steer-queued-ensemble-prompt',
      'remove-queued-ensemble-prompt',
      'blackboard-queued-ensemble-prompt'
    ]) {
      await expect(handlerFor(channel)(EVENT, { chatId: 'chat-1', index: 0 })).rejects.toThrow(
        'Ensemble Mode is disabled.'
      )
    }
  })

  it('reads the orchestrator at invocation time, not registration time', async () => {
    const h = harness()
    h.setOrchestrator(null)
    registerEnsembleControlHandlers(h.deps)

    const steer = handlerFor('steer-queued-ensemble-prompt')
    await expect(steer(EVENT, { chatId: 'chat-1', index: 0 })).resolves.toEqual({
      status: 'ignored',
      error: 'Ensemble orchestrator is not initialized.'
    })

    const live: NonNullable<Harness['orchestrator']> = {
      steerQueuedPrompt: vi.fn<OrchestratorStub['steerQueuedPrompt']>(() => ({
        status: 'steered'
      })),
      removeQueuedPrompt: vi.fn<OrchestratorStub['removeQueuedPrompt']>(() => ({
        ok: true,
        prompt: 'queued text'
      }))
    }
    h.setOrchestrator(live)
    await expect(steer(EVENT, { chatId: 'chat-1', index: 2 })).resolves.toEqual({
      status: 'steered'
    })
    expect(live.steerQueuedPrompt).toHaveBeenCalledTimes(1)
  })

  it('asserts sender scope and scheduled availability before steering', async () => {
    const h = harness()
    registerEnsembleControlHandlers(h.deps)
    await handlerFor('steer-queued-ensemble-prompt')(EVENT, { chatId: 'chat-1', index: 0 })
    expect(h.calls).toEqual(['scope', 'scheduled'])
    expect(h.deps.assertSenderChatScope).toHaveBeenCalledWith(EVENT, 'chat-1')
  })

  it('rejects an empty chat id before touching the orchestrator', async () => {
    const h = harness()
    registerEnsembleControlHandlers(h.deps)
    await expect(
      handlerFor('steer-queued-ensemble-prompt')(EVENT, { chatId: '  ', index: 0 })
    ).rejects.toThrow('Ensemble chat id is required')
    expect(h.orchestrator?.steerQueuedPrompt).not.toHaveBeenCalled()
  })

  it('normalizes a non-finite queue index to -1', async () => {
    const h = harness()
    registerEnsembleControlHandlers(h.deps)
    await handlerFor('steer-queued-ensemble-prompt')(EVENT, { chatId: 'chat-1' })
    expect(h.orchestrator?.steerQueuedPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ index: -1 })
    )
  })

  it('broadcasts the chat, thread, and task-card delta after a removal', async () => {
    const h = harness()
    registerEnsembleControlHandlers(h.deps)
    const result = await handlerFor('remove-queued-ensemble-prompt')(EVENT, {
      chatId: 'chat-1',
      index: 1
    })
    expect(result).toEqual({ ok: true, prompt: 'queued text' })
    expect(h.calls).toEqual([
      'scope',
      'broadcastChatUpdated',
      'broadcastThreadUpdate',
      'pushRemoteTaskCardDelta'
    ])
  })

  it('still broadcasts the thread when the chat has already disappeared', async () => {
    const h = harness({ getChat: vi.fn(() => null) })
    registerEnsembleControlHandlers(h.deps)
    await handlerFor('remove-queued-ensemble-prompt')(EVENT, { chatId: 'chat-1', index: 1 })
    expect(h.deps.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(h.deps.broadcastThreadUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('blackboardQueuedEnsemblePrompt', () => {
  it('posts the removed prompt and pushes the remote snapshot exactly once', () => {
    const h = harness()
    const result = blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 0 })
    expect(result).toEqual({ ok: true, entry: ENTRY })
    expect(h.calls).toEqual([
      'saveAndBroadcastChat',
      'broadcastThreadUpdate',
      'pushRemoteThreadSnapshot',
      'pushRemoteTaskCardDelta'
    ])
  })

  it('consumes the queue through the exact Delete path, preserving textPrefix', () => {
    const h = harness()
    blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 3, textPrefix: 'abc' })
    expect(h.orchestrator?.removeQueuedPrompt).toHaveBeenCalledWith({
      chatId: 'chat-1',
      index: 3,
      textPrefix: 'abc'
    })
  })

  it('refuses without mutating the chat when the queue removal fails', () => {
    const h = harness()
    h.orchestrator?.removeQueuedPrompt.mockReturnValue({ ok: false, error: 'index moved' })
    expect(blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 0 })).toEqual({
      ok: false,
      error: 'index moved'
    })
    expect(h.deps.saveAndBroadcastChat).not.toHaveBeenCalled()
  })

  it('refuses a removal that yielded a blank prompt', () => {
    const h = harness()
    h.orchestrator?.removeQueuedPrompt.mockReturnValue({ ok: true, prompt: '   ' })
    expect(blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 0 }).ok).toBe(false)
    expect(h.deps.saveAndBroadcastChat).not.toHaveBeenCalled()
  })

  it('refuses when the chat is not an Ensemble chat', () => {
    const h = harness({ getChat: vi.fn(() => ({ appChatId: 'chat-1' }) as unknown as ChatRecord) })
    expect(blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 0 })).toEqual({
      ok: false,
      error: 'Blackboard entries require an Ensemble chat.'
    })
  })

  it('surfaces the capacity code and notice when the upsert is refused', () => {
    const h = harness()
    mockedUpsert.mockReturnValue({
      ok: false,
      code: 'capacity',
      entries: [],
      tombstones: []
    } as never)
    const result = blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 0 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('capacity: Blackboard is full.')
    expect(h.deps.saveAndBroadcastChat).not.toHaveBeenCalled()
  })

  it('falls back to the global remote scope for a global chat with no workspace', () => {
    const h = harness({
      getChat: vi.fn(() => ensembleChat({ workspaceId: undefined, scope: 'global' })),
      canonicalRemoteWorkspaceId: vi.fn(() => null)
    })
    blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 0 })
    expect(h.deps.pushRemoteThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ appChatId: 'chat-1' }),
      'global'
    )
  })

  it('skips the remote snapshot when no workspace scope can be resolved', () => {
    const h = harness({
      getChat: vi.fn(() => ensembleChat({ workspaceId: 'ws-1', scope: 'workspace' })),
      canonicalRemoteWorkspaceId: vi.fn(() => null)
    })
    blackboardQueuedEnsemblePrompt(h.deps, { chatId: 'chat-1', index: 0 })
    expect(h.deps.pushRemoteThreadSnapshot).not.toHaveBeenCalled()
    expect(h.deps.pushRemoteTaskCardDelta).toHaveBeenCalledTimes(1)
  })
})
