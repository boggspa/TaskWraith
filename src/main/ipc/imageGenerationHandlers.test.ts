import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { AppSettings } from '../store/types'
import { registerImageGenerationHandlers } from './imageGenerationHandlers'

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

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    imageGeneration: {
      enabled: true,
      provider: 'xai',
      encryptedKeys: {
        openai: 'openai-key',
        xai: 'xai-key'
      }
    },
    ...overrides
  } as unknown as AppSettings
}

function createDeps() {
  let settings = createSettings()
  const deps = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch } as AppSettings
    }),
    isRecord: (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`))
  }

  return {
    deps,
    getSettingsSnapshot: () => settings
  }
}

describe('registerImageGenerationHandlers', () => {
  it('registers image-generation config channels', () => {
    registerImageGenerationHandlers(createDeps().deps)

    expect(handlerFor('image-generation:get-status')).toBeTypeOf('function')
    expect(handlerFor('image-generation:set-enabled')).toBeTypeOf('function')
    expect(handlerFor('image-generation:set-key')).toBeTypeOf('function')
    expect(handlerFor('image-generation:clear-key')).toBeTypeOf('function')
  })

  it('returns redacted status only and never exposes encrypted keys', () => {
    const { deps } = createDeps()
    registerImageGenerationHandlers(deps)

    const result = handlerFor('image-generation:get-status')({})
    expect(result).toEqual({
      enabled: true,
      defaultProvider: 'xai',
      encryptionAvailable: true,
      configured: {
        openai: true,
        xai: true
      }
    })
    expect(result).not.toHaveProperty('encryptedKeys')
    expect(JSON.stringify(result)).not.toContain('openai-key')
    expect(JSON.stringify(result)).not.toContain('xai-key')
  })

  it('returns invalid input for non-record set-enabled and set-key/clear-key payloads', () => {
    const { deps } = createDeps()
    registerImageGenerationHandlers(deps)

    expect(handlerFor('image-generation:set-enabled')({}, null)).toEqual({
      ok: false,
      error: 'invalid input'
    })
    expect(handlerFor('image-generation:set-key')({}, null)).toEqual({
      ok: false,
      error: 'invalid input'
    })
    expect(handlerFor('image-generation:clear-key')({}, null)).toEqual({
      ok: false,
      error: 'invalid input'
    })
  })

  it('set-enabled preserves current provider when input provider is invalid', () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerImageGenerationHandlers(deps)

    expect(
      handlerFor('image-generation:set-enabled')({}, { enabled: 0, provider: 'bad-provider' })
    ).toEqual({ ok: true })
    expect(deps.updateSettings).toHaveBeenCalledWith({
      imageGeneration: {
        enabled: false,
        provider: 'xai',
        encryptedKeys: {
          openai: 'openai-key',
          xai: 'xai-key'
        }
      }
    })
    expect(getSettingsSnapshot().imageGeneration?.provider).toBe('xai')
  })

  it('set-key preserves provider validation, key trimming, encryption gate, and merge behavior', () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerImageGenerationHandlers(deps)

    expect(
      handlerFor('image-generation:set-key')({}, { provider: 'bad-provider', key: 'abc' })
    ).toEqual({
      ok: false,
      error: 'provider must be openai or xai'
    })
    expect(handlerFor('image-generation:set-key')({}, { provider: 'openai', key: '   ' })).toEqual({
      ok: false,
      error: 'key is required'
    })

    deps.isEncryptionAvailable.mockReturnValue(false)
    expect(
      handlerFor('image-generation:set-key')({}, { provider: 'openai', key: 'abc' })
    ).toEqual({
      ok: false,
      error: 'OS keychain encryption is unavailable; cannot store the key.'
    })

    deps.isEncryptionAvailable.mockReturnValue(true)
    expect(
      handlerFor('image-generation:set-key')({}, { provider: 'openai', key: '  new-key  ' })
    ).toEqual({ ok: true })
    expect(deps.encryptString).toHaveBeenCalledWith('new-key')
    expect(getSettingsSnapshot().imageGeneration?.encryptedKeys).toEqual({
      openai: Buffer.from('enc:new-key').toString('base64'),
      xai: 'xai-key'
    })
  })

  it('clear-key deletes only the targeted provider key and preserves the other', () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerImageGenerationHandlers(deps)

    expect(
      handlerFor('image-generation:clear-key')({}, { provider: 'bad-provider' })
    ).toEqual({
      ok: false,
      error: 'provider must be openai or xai'
    })

    expect(handlerFor('image-generation:clear-key')({}, { provider: 'openai' })).toEqual({
      ok: true
    })
    expect(getSettingsSnapshot().imageGeneration?.encryptedKeys).toEqual({
      xai: 'xai-key'
    })
  })
})
