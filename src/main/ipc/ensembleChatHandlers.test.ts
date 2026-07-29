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
  return {
    chat,
    updateLiveRoundConfig,
    deps: {
      getEnsembleOrchestrator: () => ({ updateLiveRoundConfig }),
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
        maxContinuationHops: 6
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
      maxContinuationHops: 6
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
})
