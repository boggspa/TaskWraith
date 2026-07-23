import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL,
  ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL,
  ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL,
  registerAntigravityGeminiApiSecretHandlers
} from './antigravityGeminiApiSecretHandlers'
import { validateIpcArgs } from '../IpcValidation'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
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

describe('antigravity Gemini API secret IPC', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('registers dedicated status/set/clear channels and returns renderer-safe store results', () => {
    const store = createStore()
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: store,
      isMainRendererSender: () => true
    })

    const event = { sender: { id: 1 } }
    expect(handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL)?.(event)).toEqual({
      configured: false,
      encryptionAvailable: true
    })
    expect(handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL)?.(event, 'key')).toEqual({
      ok: true,
      status: { configured: true, encryptionAvailable: true }
    })
    expect(handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL)?.(event)).toEqual({
      ok: true,
      status: { configured: false, encryptionAvailable: true }
    })
    expect(store.setApiKey).toHaveBeenCalledWith('key')
    expect(store.clear).toHaveBeenCalledOnce()
  })

  it('rejects every channel from a secondary renderer before touching the store', () => {
    const store = createStore()
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: store,
      isMainRendererSender: () => false
    })
    const event = { sender: { id: 2 } }

    for (const channel of [
      ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL,
      ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL,
      ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL
    ]) {
      expect(() => handlers.get(channel)?.(event, 'secret')).toThrow(
        'Only the main renderer can manage the Gemini API key.'
      )
    }
    expect(store.getStatus).not.toHaveBeenCalled()
    expect(store.setApiKey).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
  })

  it('drops adversarial secret-bearing and untrusted fields from renderer results', () => {
    const store = {
      getStatus: vi.fn(() => ({
        configured: true,
        encryptionAvailable: true,
        updatedAt: 'not-a-timestamp',
        apiKey: 'AIza-secret',
        ciphertext: 'ciphertext-secret',
        nested: { secret: 'nested-secret' }
      })),
      setApiKey: vi.fn(() => ({
        ok: true,
        status: {
          configured: true,
          encryptionAvailable: true,
          updatedAt: '2026-07-23T15:00:00.000Z',
          apiKey: 'AIza-secret'
        },
        error: 'untrusted-secret-error',
        received: 'raw-key'
      })),
      clear: vi.fn(() => ({
        ok: false,
        status: { configured: false, encryptionAvailable: true, ciphertext: 'secret' },
        error: 'clearFailed',
        secret: 'raw-secret'
      }))
    }
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: store as never,
      isMainRendererSender: () => true
    })
    const event = { sender: { id: 1 } }
    const status = handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL)?.(event)
    const mutation = handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL)?.(event, 'key')
    const clear = handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL)?.(event)
    const serialized = JSON.stringify({ status, mutation, clear })

    expect(serialized).not.toContain('AIza-secret')
    expect(serialized).not.toContain('ciphertext-secret')
    expect(serialized).not.toContain('nested-secret')
    expect(serialized).not.toContain('raw-key')
    expect(serialized).not.toContain('raw-secret')
    expect(status).toEqual({ configured: true, encryptionAvailable: true })
    expect(mutation).toEqual({
      ok: true,
      status: { configured: true, encryptionAvailable: true, updatedAt: '2026-07-23T15:00:00.000Z' }
    })
    expect(clear).toEqual({
      ok: false,
      error: 'clearFailed',
      status: { configured: false, encryptionAvailable: true }
    })
  })

  it('drops impossible and noncanonical timestamps in direct and nested status', () => {
    const store = {
      getStatus: vi.fn(() => ({
        configured: true,
        encryptionAvailable: true,
        updatedAt: '2026-02-30T15:00:00.000Z'
      })),
      setApiKey: vi.fn(() => ({
        ok: true,
        status: {
          configured: true,
          encryptionAvailable: true,
          updatedAt: '2026-02-30T15:00:00.000Z'
        }
      })),
      clear: vi.fn(() => ({
        ok: true,
        status: { configured: false, encryptionAvailable: true }
      }))
    }
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: store as never,
      isMainRendererSender: () => true
    })
    const event = { sender: { id: 1 } }

    expect(handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL)?.(event)).toEqual({
      configured: true,
      encryptionAvailable: true
    })
    expect(handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL)?.(event, 'key')).toEqual({
      ok: true,
      status: { configured: true, encryptionAvailable: true }
    })
  })

  it('bounds API-key payloads at the validation boundary', () => {
    expect(() => validateIpcArgs(ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL, [''])).toThrow(
      'non-empty Gemini API key'
    )
    expect(() =>
      validateIpcArgs(ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL, ['x'.repeat(4_097)])
    ).toThrow('at most 4096 bytes')
    expect(validateIpcArgs(ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL, ['valid-key'])).toEqual([
      'valid-key'
    ])
  })
})
