import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { SessionCheckpointRecord } from '../checkpoints/SessionCheckpoint'
import { registerCheckpointHandlers } from './checkpointHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function makeCheckpoint(overrides: Partial<SessionCheckpointRecord> = {}): SessionCheckpointRecord {
  return {
    schemaVersion: 1,
    id: 'checkpoint-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    status: 'available',
    reason: 'round-updated',
    createdAt: '2026-06-30T12:00:00.000Z',
    updatedAt: '2026-06-30T12:00:00.000Z',
    snapshot: {
      blackboard: [],
      openTasks: [],
      queueState: {
        roundStatus: 'running',
        prompt: 'Continue',
        startedAt: '2026-06-30T12:00:00.000Z',
        queuedPrompts: [],
        sleepingParticipantIds: [],
        pendingWakeupIds: [],
        participants: []
      }
    },
    ...overrides
  } as SessionCheckpointRecord
}

function createDeps() {
  let store: {
    list: () => SessionCheckpointRecord[]
    latestForChat: (chatId: string) => SessionCheckpointRecord | null
    accept: (
      checkpointId: string
    ) => { checkpoint: SessionCheckpointRecord; resumePrompt: string } | null
    dismiss: (checkpointId: string) => SessionCheckpointRecord | null
  } | null = null

  const deps = {
    getSessionCheckpointStore: vi.fn(() => store),
    requireNonEmptyString: vi.fn((value: unknown, label: string) => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${label} required`)
      }
      return value.trim()
    }),
    formatSessionCheckpointResumePrompt: vi.fn(() => 'formatted resume prompt'),
    assertSenderChatScope: vi.fn()
  }

  return {
    deps,
    setStore(nextStore: typeof store) {
      store = nextStore
    }
  }
}

describe('registerCheckpointHandlers', () => {
  it('registers checkpoint IPC channels', () => {
    registerCheckpointHandlers(createDeps().deps)

    expect(handlerFor('session-checkpoints:latest')).toBeTypeOf('function')
    expect(handlerFor('session-checkpoints:accept')).toBeTypeOf('function')
    expect(handlerFor('session-checkpoints:dismiss')).toBeTypeOf('function')
  })

  it('validates chat and checkpoint ids with the expected labels', async () => {
    const { deps } = createDeps()
    registerCheckpointHandlers(deps)

    await expect(handlerFor('session-checkpoints:latest')({}, '')).rejects.toThrow(
      'Chat id required'
    )
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('', 'Chat id')

    await expect(handlerFor('session-checkpoints:accept')({}, '')).rejects.toThrow(
      'Checkpoint id required'
    )
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('', 'Checkpoint id')

    await expect(handlerFor('session-checkpoints:dismiss')({}, '')).rejects.toThrow(
      'Checkpoint id required'
    )
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('', 'Checkpoint id')
  })

  it('returns null from latest when no store is available and a record when it exists', async () => {
    const { deps, setStore } = createDeps()
    registerCheckpointHandlers(deps)

    await expect(handlerFor('session-checkpoints:latest')({}, 'chat-1')).resolves.toBeNull()

    const checkpoint = makeCheckpoint()
    setStore({
      list: vi.fn(() => [checkpoint]),
      latestForChat: vi.fn(() => checkpoint),
      accept: vi.fn(() => null),
      dismiss: vi.fn(() => null)
    })
    await expect(handlerFor('session-checkpoints:latest')({}, 'chat-1')).resolves.toEqual(
      checkpoint
    )
  })

  it('returns the no-match error for accept and dismiss when store or checkpoint is missing', async () => {
    const { deps, setStore } = createDeps()
    registerCheckpointHandlers(deps)

    await expect(handlerFor('session-checkpoints:accept')({}, 'checkpoint-1')).resolves.toEqual({
      ok: false,
      error: 'No checkpoint matches.'
    })
    await expect(handlerFor('session-checkpoints:dismiss')({}, 'checkpoint-1')).resolves.toEqual({
      ok: false,
      error: 'No checkpoint matches.'
    })

    setStore({
      list: vi.fn(() => []),
      latestForChat: vi.fn(() => null),
      accept: vi.fn(() => null),
      dismiss: vi.fn(() => null)
    })
    await expect(handlerFor('session-checkpoints:accept')({}, 'checkpoint-1')).resolves.toEqual({
      ok: false,
      error: 'No checkpoint matches.'
    })
    await expect(handlerFor('session-checkpoints:dismiss')({}, 'checkpoint-1')).resolves.toEqual({
      ok: false,
      error: 'No checkpoint matches.'
    })
  })

  it('returns accepted checkpoints and falls back resumePrompt when needed', async () => {
    const { deps, setStore } = createDeps()
    registerCheckpointHandlers(deps)

    const checkpoint = makeCheckpoint()
    setStore({
      list: vi.fn(() => [checkpoint]),
      latestForChat: vi.fn(() => null),
      accept: vi.fn(() => ({ checkpoint, resumePrompt: '' })),
      dismiss: vi.fn(() => null)
    })

    await expect(handlerFor('session-checkpoints:accept')({}, 'checkpoint-1')).resolves.toEqual({
      ok: true,
      checkpoint,
      resumePrompt: 'formatted resume prompt'
    })
    expect(deps.formatSessionCheckpointResumePrompt).toHaveBeenCalledWith(checkpoint)
  })

  it('returns dismissed checkpoints when present', async () => {
    const { deps, setStore } = createDeps()
    registerCheckpointHandlers(deps)

    const checkpoint = makeCheckpoint({ status: 'dismissed' })
    setStore({
      list: vi.fn(() => [checkpoint]),
      latestForChat: vi.fn(() => null),
      accept: vi.fn(() => null),
      dismiss: vi.fn(() => checkpoint)
    })

    await expect(handlerFor('session-checkpoints:dismiss')({}, 'checkpoint-1')).resolves.toEqual({
      ok: true,
      checkpoint
    })
  })

  it('rejects a Test 1 popout reading the latest checkpoint for Test 3', async () => {
    const event = { sender: { id: 11 } }
    const { deps, setStore } = createDeps()
    const latestForChat = vi.fn(() => makeCheckpoint({ chatId: 'chat-test-3' }))
    deps.assertSenderChatScope.mockImplementation((_event, chatId) => {
      if (chatId !== 'chat-test-1') throw new Error('Renderer chat ownership mismatch.')
    })
    setStore({
      list: vi.fn(() => []),
      latestForChat,
      accept: vi.fn(() => null),
      dismiss: vi.fn(() => null)
    })
    registerCheckpointHandlers(deps)

    await expect(handlerFor('session-checkpoints:latest')(event, 'chat-test-3')).rejects.toThrow(
      'Renderer chat ownership mismatch.'
    )
    expect(deps.assertSenderChatScope).toHaveBeenCalledWith(event, 'chat-test-3')
    expect(latestForChat).not.toHaveBeenCalled()
  })

  it.each(['session-checkpoints:accept', 'session-checkpoints:dismiss'])(
    'resolves checkpoint ownership before %s and rejects a foreign chat without mutation',
    async (channel) => {
      const event = { sender: { id: 11 } }
      const checkpoint = makeCheckpoint({ chatId: 'chat-test-3' })
      const accept = vi.fn(() => ({ checkpoint, resumePrompt: 'resume' }))
      const dismiss = vi.fn(() => checkpoint)
      const { deps, setStore } = createDeps()
      deps.assertSenderChatScope.mockImplementation((_event, chatId) => {
        if (chatId !== 'chat-test-1') throw new Error('Renderer chat ownership mismatch.')
      })
      setStore({
        list: vi.fn(() => [checkpoint]),
        latestForChat: vi.fn(() => null),
        accept,
        dismiss
      })
      registerCheckpointHandlers(deps)

      await expect(handlerFor(channel)(event, checkpoint.id)).rejects.toThrow(
        'Renderer chat ownership mismatch.'
      )
      expect(deps.assertSenderChatScope).toHaveBeenCalledWith(event, 'chat-test-3')
      expect(accept).not.toHaveBeenCalled()
      expect(dismiss).not.toHaveBeenCalled()
    }
  )
})
