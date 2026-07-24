import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL,
  ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL,
  ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL,
  ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL,
  registerAntigravityGeminiApiSecretHandlers
} from './antigravityGeminiApiSecretHandlers'
import { validateIpcArgs } from '../IpcValidation'
import { createAntigravityGeminiApiMutationSuccessHandler } from '../antigravity/AntigravityGeminiApiMutationLifecycle'

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
    const onSecretMutationSuccess = vi.fn()
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: store,
      isMainRendererSender: () => true,
      onSecretMutationSuccess
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
    expect(onSecretMutationSuccess).toHaveBeenCalledTimes(2)
  })

  it('starts discovery before withdrawing the paired catalog on successful set and clear', () => {
    const order: string[] = []
    const store = createStore()
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: store,
      isMainRendererSender: () => true,
      onSecretMutationSuccess: createAntigravityGeminiApiMutationSuccessHandler({
        startDiscovery: () => order.push('discovery.start'),
        broadcastPendingCatalog: () => order.push('paired.pending')
      })
    })
    const event = { sender: { id: 1 } }

    handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL)?.(event, 'key')
    expect(order).toEqual(['discovery.start', 'paired.pending'])

    order.length = 0
    handlers.get(ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL)?.(event)
    expect(order).toEqual(['discovery.start', 'paired.pending'])
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

  it('projects the last discovery outcome and reports null before the first probe', () => {
    let outcome: unknown = null
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: createStore(),
      isMainRendererSender: () => true,
      getDiscoveryOutcome: () => outcome as never
    })
    const event = { sender: { id: 1 } }
    const invoke = (): unknown =>
      handlers.get(ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL)?.(event)

    expect(invoke()).toBeNull()

    outcome = { status: 'ok', modelCount: 12, checkedAt: '2026-07-24T12:00:00.000Z' }
    expect(invoke()).toEqual({
      status: 'ok',
      modelCount: 12,
      checkedAt: '2026-07-24T12:00:00.000Z'
    })

    outcome = { status: 'timedOut', modelCount: 0, checkedAt: '2026-07-24T12:00:00.000Z' }
    expect(invoke()).toEqual({
      status: 'timedOut',
      modelCount: 0,
      checkedAt: '2026-07-24T12:00:00.000Z'
    })
  })

  it('reports null when no discovery recorder is wired', () => {
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: createStore(),
      isMainRendererSender: () => true
    })
    expect(
      handlers.get(ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL)?.({ sender: { id: 1 } })
    ).toBeNull()
  })

  it('drops secret-bearing, unknown-status and noncanonical fields from the outcome', () => {
    const cases: Array<[unknown, unknown]> = [
      // Extra fields, however plausible, never cross the boundary.
      [
        {
          status: 'unauthorized',
          modelCount: 0,
          checkedAt: '2026-07-24T12:00:00.000Z',
          apiKey: 'AIza-secret',
          error: 'API key not valid. Please pass a valid API key. project=leaky-project',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta/models'
        },
        { status: 'unauthorized', modelCount: 0, checkedAt: '2026-07-24T12:00:00.000Z' }
      ],
      // A status outside the closed enum collapses to "nothing recorded".
      [{ status: 'somethingNew', modelCount: 1, checkedAt: '2026-07-24T12:00:00.000Z' }, null],
      // An impossible or noncanonical timestamp collapses the whole outcome.
      [{ status: 'ok', modelCount: 1, checkedAt: '2026-02-30T12:00:00.000Z' }, null],
      [{ status: 'ok', modelCount: 1, checkedAt: '2026-07-24T12:00:00Z' }, null],
      [{ status: 'ok', modelCount: 1 }, null],
      // A failure can never smuggle in a model count.
      [
        { status: 'unauthorized', modelCount: 99, checkedAt: '2026-07-24T12:00:00.000Z' },
        { status: 'unauthorized', modelCount: 0, checkedAt: '2026-07-24T12:00:00.000Z' }
      ],
      // Counts are bounded integers.
      [
        { status: 'ok', modelCount: 10_000, checkedAt: '2026-07-24T12:00:00.000Z' },
        { status: 'ok', modelCount: 1_024, checkedAt: '2026-07-24T12:00:00.000Z' }
      ],
      [
        { status: 'ok', modelCount: '7', checkedAt: '2026-07-24T12:00:00.000Z' },
        { status: 'ok', modelCount: 0, checkedAt: '2026-07-24T12:00:00.000Z' }
      ],
      ['not-an-object', null],
      [null, null]
    ]

    for (const [stored, expected] of cases) {
      handlers.clear()
      registerAntigravityGeminiApiSecretHandlers({
        secretStore: createStore(),
        isMainRendererSender: () => true,
        getDiscoveryOutcome: () => stored as never
      })
      const projected = handlers.get(ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL)?.({
        sender: { id: 1 }
      })
      expect(projected).toEqual(expected)
      expect(JSON.stringify(projected ?? null)).not.toContain('AIza-secret')
      expect(JSON.stringify(projected ?? null)).not.toContain('leaky-project')
      expect(JSON.stringify(projected ?? null)).not.toContain('googleapis.com')
    }
  })

  it('keeps the discovery outcome behind main-renderer authority and survives a throwing source', () => {
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: createStore(),
      isMainRendererSender: () => false,
      getDiscoveryOutcome: () => {
        throw new Error('should never be reached')
      }
    })
    expect(() =>
      handlers.get(ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL)?.({ sender: { id: 2 } })
    ).toThrow('Only the main renderer can manage the Gemini API key.')

    handlers.clear()
    registerAntigravityGeminiApiSecretHandlers({
      secretStore: createStore(),
      isMainRendererSender: () => true,
      getDiscoveryOutcome: () => {
        throw new Error('reader exploded')
      }
    })
    expect(
      handlers.get(ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL)?.({ sender: { id: 1 } })
    ).toBeNull()
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
