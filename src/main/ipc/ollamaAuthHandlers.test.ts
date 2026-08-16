import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerOllamaAuthHandlers } from './ollamaAuthHandlers'

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
  let settings = { ollamaApiKey: 'encrypted-key' as string | undefined }
  const deps = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((patch: { ollamaApiKey?: string }) => {
      settings = { ...settings, ...patch }
    }),
    isEncryptionAvailable: vi.fn(() => true),
    encryptApiKey: vi.fn((value: string) => `encrypted:${value}`)
  }
  return { deps, getSettingsSnapshot: () => settings }
}

describe('registerOllamaAuthHandlers', () => {
  it('registers status, store, and clear channels', () => {
    registerOllamaAuthHandlers(createDeps().deps)

    expect(handlerFor('get-ollama-auth-status')).toBeTypeOf('function')
    expect(handlerFor('store-ollama-api-key')).toBeTypeOf('function')
    expect(handlerFor('clear-ollama-api-key')).toBeTypeOf('function')
  })

  it('projects only configured state and secure-storage availability', async () => {
    const { deps } = createDeps()
    registerOllamaAuthHandlers(deps)

    await expect(handlerFor('get-ollama-auth-status')({})).resolves.toEqual({
      apiKeyConfigured: true,
      encryptionAvailable: true
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
})
