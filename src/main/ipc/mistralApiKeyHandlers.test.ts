import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MISTRAL_API_KEY_CLEAR_CHANNEL,
  MISTRAL_API_KEY_SET_CHANNEL,
  MISTRAL_API_KEY_STATUS_CHANNEL,
  MISTRAL_WEB_SESSION_CLEAR_CHANNEL,
  MISTRAL_WEB_SESSION_IMPORT_CHANNEL,
  MISTRAL_WEB_SESSION_STATUS_CHANNEL,
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
    getStatus: vi.fn(
      (): { configured: boolean; encryptionAvailable: boolean; updatedAt?: string } => ({
        configured: false,
        encryptionAvailable: true
      })
    ),
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

function createWebSessionStore() {
  return {
    getStatus: vi.fn(() => ({
      configured: true,
      encryptionAvailable: true,
      updatedAt: '2026-08-18T12:00:00.000Z'
    })),
    setCookie: vi.fn(() => ({
      ok: true,
      status: {
        configured: true,
        encryptionAvailable: true,
        updatedAt: '2026-08-18T12:00:00.000Z'
      }
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
    expect(handlers.get(MISTRAL_API_KEY_CLEAR_CHANNEL)?.(event)).toEqual({
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error: 'clearFailed'
    })
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('round-trips no-millisecond updatedAt timestamps', () => {
    const store = createStore()
    store.getStatus.mockReturnValue({
      configured: true,
      encryptionAvailable: true,
      updatedAt: '2026-08-18T12:00:00Z'
    })
    registerMistralApiKeyHandlers({
      keyStore: store,
      isMainRendererSender: () => true
    })

    const event = { sender: { id: 1 } }
    expect(handlers.get(MISTRAL_API_KEY_STATUS_CHANNEL)?.(event)).toEqual({
      configured: true,
      encryptionAvailable: true,
      updatedAt: '2026-08-18T12:00:00Z'
    })
  })

  it('unregisters handlers cleanly', () => {
    const store = createStore()
    registerMistralApiKeyHandlers({
      keyStore: store,
      isMainRendererSender: () => true
    })
    expect(handlers.has(MISTRAL_API_KEY_STATUS_CHANNEL)).toBe(true)
    expect(handlers.has(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)).toBe(true)

    unregisterMistralApiKeyHandlers()
    expect(handlers.has(MISTRAL_API_KEY_STATUS_CHANNEL)).toBe(false)
    expect(handlers.has(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)).toBe(false)
    expect(handlers.has(MISTRAL_WEB_SESSION_STATUS_CHANNEL)).toBe(false)
    expect(handlers.has(MISTRAL_WEB_SESSION_CLEAR_CHANNEL)).toBe(false)
  })

  describe('web session import', () => {
    const event = { sender: { id: 1 } }

    it('persists the captured cookie main-side and returns ONLY the status projection', async () => {
      const webSessionStore = createWebSessionStore()
      const onWebSessionImported = vi.fn()
      registerMistralApiKeyHandlers({
        keyStore: createStore(),
        isMainRendererSender: () => true,
        webSessionStore: () => webSessionStore,
        importWebSession: async () => ({
          cookieHeader: 'ory_session=secret-cookie',
          summary: { currency: 'EUR', apiSpent: 0.28, vibeSpent: 21.3 }
        }),
        onWebSessionImported
      })

      const outcome = await handlers.get(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)?.(event)
      expect(webSessionStore.setCookie).toHaveBeenCalledWith('ory_session=secret-cookie')
      expect(onWebSessionImported).toHaveBeenCalledWith({
        currency: 'EUR',
        apiSpent: 0.28,
        vibeSpent: 21.3
      })
      expect(outcome).toEqual({
        ok: true,
        status: {
          configured: true,
          encryptionAvailable: true,
          updatedAt: '2026-08-18T12:00:00.000Z'
        }
      })
      // The renderer-facing outcome must never carry the cookie.
      expect(JSON.stringify(outcome)).not.toContain('secret-cookie')
    })

    it('reports a closed window as cancelled without touching the store', async () => {
      const webSessionStore = createWebSessionStore()
      registerMistralApiKeyHandlers({
        keyStore: createStore(),
        isMainRendererSender: () => true,
        webSessionStore: () => webSessionStore,
        importWebSession: async () => null
      })

      await expect(handlers.get(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)?.(event)).resolves.toEqual({
        ok: false,
        reason: 'cancelled'
      })
      expect(webSessionStore.setCookie).not.toHaveBeenCalled()
    })

    it('surfaces a store write failure with its status', async () => {
      const webSessionStore = createWebSessionStore()
      webSessionStore.setCookie.mockReturnValue({
        ok: false,
        status: { configured: true, encryptionAvailable: true },
        error: 'existingRecordUnreadable'
      } as never)
      registerMistralApiKeyHandlers({
        keyStore: createStore(),
        isMainRendererSender: () => true,
        webSessionStore: () => webSessionStore,
        importWebSession: async () => ({
          cookieHeader: 'a=1',
          summary: { currency: 'EUR' }
        })
      })

      await expect(handlers.get(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)?.(event)).resolves.toEqual({
        ok: false,
        reason: 'storeFailed',
        status: { configured: true, encryptionAvailable: true }
      })
    })

    it('refuses an unauthorized sender and an unconfigured store', async () => {
      const importWebSession = vi.fn()
      registerMistralApiKeyHandlers({
        keyStore: createStore(),
        isMainRendererSender: () => false,
        webSessionStore: () => createWebSessionStore(),
        importWebSession
      })
      await expect(handlers.get(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)?.(event)).resolves.toEqual({
        ok: false,
        reason: 'unavailable'
      })
      expect(importWebSession).not.toHaveBeenCalled()

      handlers.clear()
      registerMistralApiKeyHandlers({
        keyStore: createStore(),
        isMainRendererSender: () => true,
        webSessionStore: () => null,
        importWebSession
      })
      await expect(handlers.get(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)?.(event)).resolves.toEqual({
        ok: false,
        reason: 'unavailable'
      })
      expect(importWebSession).not.toHaveBeenCalled()
    })

    it('serves and clears the stored session status', async () => {
      const webSessionStore = createWebSessionStore()
      registerMistralApiKeyHandlers({
        keyStore: createStore(),
        isMainRendererSender: () => true,
        webSessionStore: () => webSessionStore
      })

      expect(handlers.get(MISTRAL_WEB_SESSION_STATUS_CHANNEL)?.(event)).toEqual({
        configured: true,
        encryptionAvailable: true,
        updatedAt: '2026-08-18T12:00:00.000Z'
      })
      expect(handlers.get(MISTRAL_WEB_SESSION_CLEAR_CHANNEL)?.(event)).toEqual({
        ok: true,
        status: { configured: false, encryptionAvailable: true }
      })
      expect(webSessionStore.clear).toHaveBeenCalledTimes(1)
    })
  })
})
