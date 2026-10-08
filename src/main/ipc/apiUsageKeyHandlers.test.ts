import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  API_USAGE_KEY_CLEAR_CHANNEL,
  API_USAGE_KEY_SET_CHANNEL,
  API_USAGE_KEY_STATUS_CHANNEL,
  registerApiUsageKeyHandlers,
  type ApiUsageKeyHandlerDeps
} from './apiUsageKeyHandlers'
import type { ApiUsageKeyMutationResult, ApiUsageKeyStatus } from '../usage/ApiUsageKeyStore'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function fakeStore(initialKey: string | null = null) {
  let key = initialKey
  const status = (): ApiUsageKeyStatus => ({
    configured: key !== null,
    encryptionAvailable: true,
    ...(key !== null ? { updatedAt: '2026-10-08T01:00:00.000Z' } : {})
  })
  return {
    getStatus: vi.fn(status),
    setApiKey: vi.fn((value: string): ApiUsageKeyMutationResult => {
      key = value.trim()
      return { ok: true, status: status() }
    }),
    clear: vi.fn((): ApiUsageKeyMutationResult => {
      key = null
      return { ok: true, status: status() }
    }),
    peek: () => key
  }
}

describe('registerApiUsageKeyHandlers', () => {
  // Stand-in sender events; the handlers only ever hand them to
  // `isMainRendererSender`, so a marker object is enough.
  const mainEvent = { sender: 'main' }
  const otherEvent = { sender: 'other' }
  let anthropic: ReturnType<typeof fakeStore>
  let openai: ReturnType<typeof fakeStore>
  let onKeyMutationSuccess: ReturnType<
    typeof vi.fn<NonNullable<ApiUsageKeyHandlerDeps['onKeyMutationSuccess']>>
  >

  beforeEach(() => {
    mockedHandle.mockReset()
    anthropic = fakeStore('sk-ant-admin01-existing')
    openai = fakeStore()
    onKeyMutationSuccess = vi.fn<NonNullable<ApiUsageKeyHandlerDeps['onKeyMutationSuccess']>>()
    const deps: ApiUsageKeyHandlerDeps = {
      keyStore: (provider) => (provider === 'anthropic' ? anthropic : openai),
      isMainRendererSender: (event) => (event as unknown) === mainEvent,
      onKeyMutationSuccess
    }
    registerApiUsageKeyHandlers(deps)
  })

  it('projects status per provider and never the key itself', () => {
    const status = handlerFor(API_USAGE_KEY_STATUS_CHANNEL)
    expect(status(mainEvent, 'anthropic')).toEqual({
      configured: true,
      encryptionAvailable: true,
      updatedAt: '2026-10-08T01:00:00.000Z'
    })
    expect(status(mainEvent, 'openai')).toEqual({ configured: false, encryptionAvailable: true })
    expect(JSON.stringify(status(mainEvent, 'anthropic'))).not.toContain('sk-ant')
    expect(status(mainEvent, 'mistral')).toBeNull()
    expect(status(otherEvent, 'anthropic')).toBeNull()
  })

  it('stores a key for the named provider only and reports the mutation', () => {
    const set = handlerFor(API_USAGE_KEY_SET_CHANNEL)
    expect(set(mainEvent, 'openai', '  sk-admin-new  ')).toMatchObject({ ok: true })
    expect(openai.peek()).toBe('sk-admin-new')
    expect(anthropic.peek()).toBe('sk-ant-admin01-existing')
    expect(onKeyMutationSuccess).toHaveBeenCalledWith('openai')
    expect(set(mainEvent, 'openai', '   ')).toMatchObject({ ok: false, error: 'invalidApiKey' })
    expect(set(mainEvent, 'nope', 'sk')).toMatchObject({ ok: false, error: 'unavailable' })
    expect(set(otherEvent, 'openai', 'sk-smuggled')).toMatchObject({
      ok: false,
      error: 'writeFailed'
    })
    expect(openai.peek()).toBe('sk-admin-new')
  })

  it('clears a key for the named provider and notifies', () => {
    const clear = handlerFor(API_USAGE_KEY_CLEAR_CHANNEL)
    expect(clear(otherEvent, 'anthropic')).toMatchObject({ ok: false, error: 'clearFailed' })
    expect(anthropic.peek()).toBe('sk-ant-admin01-existing')
    expect(clear(mainEvent, 'anthropic')).toMatchObject({ ok: true, status: { configured: false } })
    expect(anthropic.peek()).toBeNull()
    expect(onKeyMutationSuccess).toHaveBeenCalledWith('anthropic')
  })
})
