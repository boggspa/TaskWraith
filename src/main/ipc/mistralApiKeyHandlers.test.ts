import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MISTRAL_API_KEY_CLEAR_CHANNEL,
  MISTRAL_API_KEY_SET_CHANNEL,
  MISTRAL_API_KEY_STATUS_CHANNEL,
  registerMistralApiKeyHandlers,
  unregisterMistralApiKeyHandlers
} from './mistralApiKeyHandlers'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

function createStore() {
  return {
    getStatus: vi.fn(() => ({ configured: false, encryptionAvailable: true })),
    setApiKey: vi.fn((value: string) => ({
      ok: true,
      status: { configured: true, encryptionAvailable: true },
      received: value
    })),
    clear: vi.fn(() => ({
      ok: true,
      status: { configured: false, encryptionAvailable: true }
    }))
  }
}

describe('mistralApiKeyHandlers', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('registers dedicated status, set, and clear handlers and returns safe projections', () => {
    const store = createStore()
    const onKeyMutationSuccess = vi.fn()
    registerMistralApiKeyHandlers({
      keyStore: store,
      isMainRendererSender: () => true,
      onKeyMutationSuccess
    })

    const event = { sender: { id: 1 } }
    expect(handlers.get(MISTRAL_API_KEY_STATUS_CHANNEL)?.(event)).toEqual({
      configured: false,
      encryptionAvailable: true
    })

    const setResult = handlers.get(MISTRAL_API_KEY_SET_CHANNEL)?.(event, 'test-key')
    expect(setResult).toEqual({
      ok: true,
      status: { configured: true, encryptionAvailable: true }
    })
    expect(store.setApiKey).toHaveBeenCalledWith('test-key')
    expect(onKeyMutationSuccess).toHaveBeenCalledTimes(1)

    const clearResult = handlers.get(MISTRAL_API_KEY_CLEAR_CHANNEL)?.(event)
    expect(clearResult).toEqual({
      ok: true,
      status: { configured: false, encryptionAvailable: true }
    })
    expect(store.clear).toHaveBeenCalledTimes(1)
    expect(onKeyMutationSuccess).toHaveBeenCalledTimes(2)
  })

  it('rejects unauthorized sender', () => {
    const store = createStore()
    registerMistralApiKeyHandlers({
      keyStore: store,
      isMainRendererSender: () => false
    })

    const event = { sender: { id: 2 } }
    expect(handlers.get(MISTRAL_API_KEY_STATUS_CHANNEL)?.(event)).toEqual({
      configured: false,
      encryptionAvailable: false
    })
    expect(handlers.get(MISTRAL_API_KEY_SET_CHANNEL)?.(event, 'key')).toEqual({
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error: 'writeFailed'
    })
  })

  it('unregisters handlers cleanly', () => {
    const store = createStore()
    registerMistralApiKeyHandlers({
      keyStore: store,
      isMainRendererSender: () => true
    })
    expect(handlers.has(MISTRAL_API_KEY_STATUS_CHANNEL)).toBe(true)

    unregisterMistralApiKeyHandlers()
    expect(handlers.has(MISTRAL_API_KEY_STATUS_CHANNEL)).toBe(false)
  })
})
