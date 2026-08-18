import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { normalizeOllamaWebSessionInput, registerOllamaAuthHandlers } from './ollamaAuthHandlers'

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

function createDeps(webSessionStore = createWebSessionStore()) {
  let settings = { ollamaApiKey: 'encrypted-key' as string | undefined }
  const deps = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((patch: { ollamaApiKey?: string }) => {
      settings = { ...settings, ...patch }
    }),
    isEncryptionAvailable: vi.fn(() => true),
    encryptApiKey: vi.fn((value: string) => `encrypted:${value}`),
    isMainRendererSender: vi.fn(() => true),
    webSessionStore: () => webSessionStore
  }
  return { deps, webSessionStore, getSettingsSnapshot: () => settings }
}

describe('registerOllamaAuthHandlers', () => {
  it('registers status, store, clear, and web-session channels', () => {
    registerOllamaAuthHandlers(createDeps().deps)

    expect(handlerFor('get-ollama-auth-status')).toBeTypeOf('function')
    expect(handlerFor('store-ollama-api-key')).toBeTypeOf('function')
    expect(handlerFor('clear-ollama-api-key')).toBeTypeOf('function')
    expect(handlerFor('import-ollama-web-session')).toBeTypeOf('function')
    expect(handlerFor('set-ollama-web-session')).toBeTypeOf('function')
    expect(handlerFor('clear-ollama-web-session')).toBeTypeOf('function')
  })

  it('projects configured state, secure-storage availability, and web-session status', async () => {
    const { deps } = createDeps()
    registerOllamaAuthHandlers(deps)

    await expect(handlerFor('get-ollama-auth-status')({})).resolves.toEqual({
      apiKeyConfigured: true,
      encryptionAvailable: true,
      webSessionConfigured: true,
      webSessionUpdatedAt: '2026-08-18T12:00:00.000Z'
    })
  })

  it('reads as unconfigured before the web-session store exists', async () => {
    const { deps } = createDeps()
    registerOllamaAuthHandlers({ ...deps, webSessionStore: () => null })

    await expect(handlerFor('get-ollama-auth-status')({})).resolves.toEqual({
      apiKeyConfigured: true,
      encryptionAvailable: true,
      webSessionConfigured: false
    })
  })

  it('clears empty input, rejects unavailable secure storage, and encrypts keys', async () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerOllamaAuthHandlers(deps)

    await expect(handlerFor('store-ollama-api-key')({}, '   ')).resolves.toEqual({
      stored: false,
      encryptionAvailable: true
    })
    expect(getSettingsSnapshot().ollamaApiKey).toBeUndefined()

    deps.isEncryptionAvailable.mockReturnValue(false)
    deps.updateSettings.mockClear()
    await expect(handlerFor('store-ollama-api-key')({}, 'secret')).resolves.toEqual({
      stored: false,
      encryptionAvailable: false,
      error: 'Secure storage is unavailable, so the Ollama API key was not saved.'
    })
    expect(deps.updateSettings).not.toHaveBeenCalled()

    deps.isEncryptionAvailable.mockReturnValue(true)
    await expect(handlerFor('store-ollama-api-key')({}, '  secret  ')).resolves.toEqual({
      stored: true,
      encryptionAvailable: true
    })
    expect(deps.encryptApiKey).toHaveBeenCalledWith('secret')
    expect(getSettingsSnapshot().ollamaApiKey).toBe('encrypted:secret')
  })

  it('clears the stored key', async () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerOllamaAuthHandlers(deps)

    await expect(handlerFor('clear-ollama-api-key')({})).resolves.toBe(true)
    expect(getSettingsSnapshot().ollamaApiKey).toBeUndefined()
  })

  describe('web session', () => {
    it('imports: persists the captured cookie main-side and returns ONLY the status projection', async () => {
      const { deps, webSessionStore } = createDeps()
      const onWebSessionImported = vi.fn()
      registerOllamaAuthHandlers({
        ...deps,
        importWebSession: async () => ({
          cookieHeader: '__Secure-session=secret-cookie',
          summary: { sessionUsedPercent: 12, weeklyUsedPercent: 48 }
        }),
        onWebSessionImported
      })

      const outcome = await handlerFor('import-ollama-web-session')({})
      expect(webSessionStore.setCookie).toHaveBeenCalledWith('__Secure-session=secret-cookie')
      expect(onWebSessionImported).toHaveBeenCalledWith({
        sessionUsedPercent: 12,
        weeklyUsedPercent: 48
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

    it('imports: reports a closed window as cancelled without touching the store', async () => {
      const { deps, webSessionStore } = createDeps()
      registerOllamaAuthHandlers({ ...deps, importWebSession: async () => null })

      await expect(handlerFor('import-ollama-web-session')({})).resolves.toEqual({
        ok: false,
        reason: 'cancelled'
      })
      expect(webSessionStore.setCookie).not.toHaveBeenCalled()
    })

    it('imports: refuses an unauthorized sender before opening any window', async () => {
      const { deps } = createDeps()
      const importWebSession = vi.fn()
      deps.isMainRendererSender.mockReturnValue(false)
      registerOllamaAuthHandlers({ ...deps, importWebSession })

      await expect(handlerFor('import-ollama-web-session')({})).resolves.toEqual({
        ok: false,
        reason: 'unavailable'
      })
      expect(importWebSession).not.toHaveBeenCalled()
    })

    it('set: normalizes pasted input before storing', async () => {
      const { deps, webSessionStore } = createDeps()
      registerOllamaAuthHandlers(deps)

      await handlerFor('set-ollama-web-session')({}, '  bare-session-value  ')
      expect(webSessionStore.setCookie).toHaveBeenCalledWith('__Secure-session=bare-session-value')

      await expect(handlerFor('set-ollama-web-session')({}, '   ')).resolves.toMatchObject({
        ok: false,
        error: 'invalidCookie'
      })
    })

    it('clear: empties the envelope', async () => {
      const { deps, webSessionStore } = createDeps()
      registerOllamaAuthHandlers(deps)

      await expect(handlerFor('clear-ollama-web-session')({})).resolves.toEqual({
        ok: true,
        status: { configured: false, encryptionAvailable: true }
      })
      expect(webSessionStore.clear).toHaveBeenCalledTimes(1)
    })
  })
})

describe('normalizeOllamaWebSessionInput', () => {
  it('wraps a bare DevTools value as __Secure-session', () => {
    expect(normalizeOllamaWebSessionInput('abc123')).toBe('__Secure-session=abc123')
  })

  it('keeps name=value pairs and full headers as given', () => {
    expect(normalizeOllamaWebSessionInput('__Secure-session=abc')).toBe('__Secure-session=abc')
    expect(normalizeOllamaWebSessionInput('a=1; b=2')).toBe('a=1; b=2')
  })

  it('strips a leading Cookie: label', () => {
    expect(normalizeOllamaWebSessionInput('Cookie: __Secure-session=abc')).toBe(
      '__Secure-session=abc'
    )
  })

  it('rejects empty and non-string input', () => {
    expect(normalizeOllamaWebSessionInput('   ')).toBeNull()
    expect(normalizeOllamaWebSessionInput('Cookie:   ')).toBeNull()
    expect(normalizeOllamaWebSessionInput(42)).toBeNull()
  })
})
