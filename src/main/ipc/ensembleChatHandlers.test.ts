import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type {
  EnsembleLiveRoundConfigUpdateInput,
  EnsembleLiveRoundConfigUpdateResult
} from '../services/EnsembleOrchestrator'
import type { ChatRecord } from '../store/types'
import { registerEnsembleChatHandlers, type EnsembleChatHandlerDeps } from './ensembleChatHandlers'

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

function createDeps() {
  const chat = { appChatId: 'chat-1' } as ChatRecord
  const updateLiveRoundConfig = vi.fn<
    (input: EnsembleLiveRoundConfigUpdateInput) => EnsembleLiveRoundConfigUpdateResult
  >(() => ({
    ok: true,
    orchestrationMode: 'turn_bound',
    fanoutPolicy: 'off',
    maxContinuationHops: 6,
    activeRoundUpdated: true
  }))
  const applyOrQueueUserRosterPreset = vi.fn(() => ({ ok: true, deferred: true }) as const)
  return {
    chat,
    applyOrQueueUserRosterPreset,
    updateLiveRoundConfig,
    deps: {
      getEnsembleOrchestrator: () => ({
        applyOrQueueUserRosterPreset,
        updateLiveRoundConfig
      }),
      getChat: vi.fn(() => chat),
      assertSenderChatScope: vi.fn(),
      broadcastChatUpdated: vi.fn(),
      broadcastThreadUpdate: vi.fn(),
      pushRemoteTaskCardDelta: vi.fn()
    } satisfies EnsembleChatHandlerDeps
  }
}

describe('registerEnsembleChatHandlers', () => {
  it('registers the live Ensemble round configuration channel', () => {
    registerEnsembleChatHandlers(createDeps().deps)
    expect(handlerFor('ensemble:update-live-round-config')).toBeTypeOf('function')
    expect(handlerFor('ensemble:apply-roster-preset')).toBeTypeOf('function')
  })

  it('authorizes, forwards, and broadcasts a valid live configuration update', () => {
    const { deps, updateLiveRoundConfig, chat } = createDeps()
    registerEnsembleChatHandlers(deps)
    const event = { sender: { id: 42 } }

    expect(
      handlerFor('ensemble:update-live-round-config')(event, {
        chatId: '  chat-1  ',
        orchestrationMode: 'turn_bound',
        fanoutPolicy: 'off',
        maxContinuationHops: 6,
        previousMaxContinuationHops: 12
      })
    ).toEqual({
      ok: true,
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      maxContinuationHops: 6,
      activeRoundUpdated: true
    })
    expect(deps.assertSenderChatScope).toHaveBeenCalledWith(event, 'chat-1')
    expect(updateLiveRoundConfig).toHaveBeenCalledWith({
      chatId: 'chat-1',
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      maxContinuationHops: 6,
      previousMaxContinuationHops: 12
    })
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(chat)
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1', {
      remoteProjectionSnapshot: false
    })
    expect(deps.pushRemoteTaskCardDelta).toHaveBeenCalledWith('chat-1')
  })

  it('rejects malformed controls before invoking the orchestrator', () => {
    const { deps, updateLiveRoundConfig } = createDeps()
    registerEnsembleChatHandlers(deps)

    expect(
      handlerFor('ensemble:update-live-round-config')(
        {},
        {
          chatId: 'chat-1',
          fanoutPolicy: 'wide_open'
        }
      )
    ).toEqual({
      ok: false,
      error: 'invalid_config',
      message: 'Unsupported Ensemble fan-out policy.'
    })
    expect(updateLiveRoundConfig).not.toHaveBeenCalled()
    expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()

    expect(
      handlerFor('ensemble:update-live-round-config')(
        {},
        {
          chatId: 'chat-1',
          maxContinuationHops: 6,
          previousMaxContinuationHops: 'twelve'
        }
      )
    ).toEqual({
      ok: false,
      error: 'invalid_config',
      message: 'Previous continuation hops must be a finite number.'
    })
  })

  it('checks popout ownership before changing the requested chat', () => {
    const { deps, updateLiveRoundConfig } = createDeps()
    deps.assertSenderChatScope.mockImplementation(() => {
      throw new Error('Renderer chat ownership mismatch.')
    })
    registerEnsembleChatHandlers(deps)

    expect(() =>
      handlerFor('ensemble:update-live-round-config')(
        { sender: { id: 9 } },
        {
          chatId: 'chat-2',
          fanoutPolicy: 'off'
        }
      )
    ).toThrow('Renderer chat ownership mismatch.')
    expect(updateLiveRoundConfig).not.toHaveBeenCalled()
  })

  it('queues a user roster atomically while the round is live', () => {
    const { applyOrQueueUserRosterPreset, deps } = createDeps()
    const chat = {
      appChatId: 'chat-1',
      chatKind: 'ensemble',
      title: 'Live roster',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: [],
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        orchestrationMode: 'turn_bound',
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'Work.',
          startedAt: '2026-07-29T00:00:00.000Z',
          activeParticipantId: 'current-seat',
          participants: [
            {
              participantId: 'current-seat',
              provider: 'codex',
              role: 'Current',
              order: 1,
              status: 'running'
            }
          ]
        }
      }
    } as ChatRecord
    deps.getChat.mockReturnValue(chat)
    registerEnsembleChatHandlers(deps)

    const result = handlerFor('ensemble:apply-roster-preset')(
      { sender: { id: 1 } },
      {
        chatId: 'chat-1',
        plan: {
          schemaVersion: 1,
          presetId: 'preset-1',
          presetName: 'Next roster',
          queuedAt: '2026-07-29T00:00:01.000Z',
          authority: 'user',
          participants: [
            {
              id: 'boss-1',
              provider: 'codex',
              enabled: true,
              role: 'Boss',
              instructions: '',
              order: 1,
              linkedProviderSessionId: null
            }
          ],
          bossmanParticipantId: 'boss-1',
          orchestrationMode: 'continuous',
          fanoutPolicy: 'off',
          maxParticipants: 2,
          maxContinuationHops: 6,
          ensembleContextChars: 24_000
        }
      }
    )

    expect(result).toMatchObject({ ok: true, deferred: true })
    expect(applyOrQueueUserRosterPreset).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        presetId: 'preset-1',
        authority: 'user'
      })
    )
  })
})
