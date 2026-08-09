import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  CANVAS_BROWSER_PARTITION,
  CanvasBrowserProfile,
  type CanvasBrowserProfileRequestHandlers
} from './CanvasBrowserProfile'

type BeforeListener = (
  details: Record<string, unknown>,
  callback: (result: { cancel?: boolean }) => void
) => void
type EventListener = (details: Record<string, unknown>) => void

function sessionHarness() {
  const listeners: {
    before?: BeforeListener
    send?: EventListener
    completed?: EventListener
    error?: EventListener
    download?: (event: { preventDefault(): void }) => void
    permission?: (
      webContents: unknown,
      permission: string,
      callback: (allowed: boolean) => void
    ) => void
  } = {}
  const clearStorageData = vi.fn(async () => {})
  const clearCache = vi.fn(async () => {})
  const flushStorageData = vi.fn()
  const session = {
    setPermissionRequestHandler: vi.fn((listener) => {
      listeners.permission = listener
    }),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
      if (event === 'will-download') listeners.download = listener
    }),
    webRequest: {
      onBeforeRequest: vi.fn((listener: BeforeListener) => {
        listeners.before = listener
      }),
      onSendHeaders: vi.fn((listener: EventListener) => {
        listeners.send = listener
      }),
      onCompleted: vi.fn((listener: EventListener) => {
        listeners.completed = listener
      }),
      onErrorOccurred: vi.fn((listener: EventListener) => {
        listeners.error = listener
      })
    },
    clearStorageData,
    clearCache,
    flushStorageData
  } as unknown as Session
  return { session, listeners, clearStorageData, clearCache, flushStorageData }
}

function webContents(id: number, session: Session): Pick<WebContents, 'id' | 'session'> {
  return { id, session }
}

function handlers(blocked = false): CanvasBrowserProfileRequestHandlers {
  return {
    shouldBlock: vi.fn(async () => blocked),
    onSendHeaders: vi.fn(),
    onCompleted: vi.fn(),
    onErrorOccurred: vi.fn()
  }
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    url: 'https://example.test/',
    method: 'GET',
    webContentsId: 1,
    resourceType: 'mainFrame',
    referrer: '',
    timestamp: 1,
    uploadData: [],
    requestHeaders: {},
    responseHeaders: {},
    fromCache: false,
    statusCode: 200,
    statusLine: 'HTTP/1.1 200 OK',
    error: '',
    ...overrides
  }
}

async function beforeResult(
  listener: BeforeListener | undefined,
  details: Record<string, unknown>
): Promise<{ cancel?: boolean }> {
  if (!listener) throw new Error('before-request listener missing')
  return new Promise((resolve) => listener(details, resolve))
}

describe('CanvasBrowserProfile', () => {
  it('uses one app-wide persistent partition and routes simultaneous surfaces independently', async () => {
    const harness = sessionHarness()
    const profile = new CanvasBrowserProfile()
    const first = handlers(false)
    const second = handlers(true)

    profile.register(webContents(1, harness.session), first)
    profile.register(webContents(2, harness.session), second)

    expect(profile.partition).toBe(CANVAS_BROWSER_PARTITION)
    expect(profile.partition.startsWith('persist:')).toBe(true)
    expect(profile.activeSurfaceCount).toBe(2)
    expect(harness.session.setPermissionRequestHandler).toHaveBeenCalledOnce()
    expect(harness.session.webRequest.onBeforeRequest).toHaveBeenCalledOnce()

    expect(await beforeResult(harness.listeners.before, request())).toEqual({ cancel: false })
    expect(
      await beforeResult(harness.listeners.before, request({ id: 20, webContentsId: 2 }))
    ).toEqual({ cancel: true })
    expect(first.shouldBlock).toHaveBeenCalledOnce()
    expect(second.shouldBlock).toHaveBeenCalledOnce()

    harness.listeners.send?.(request())
    harness.listeners.completed?.(request({ webContentsId: undefined }))
    expect(first.onSendHeaders).toHaveBeenCalledOnce()
    expect(first.onCompleted).toHaveBeenCalledOnce()
    expect(second.onCompleted).not.toHaveBeenCalled()
  })

  it('fails unknown requests closed, denies page permissions/downloads, and releases one surface only', async () => {
    const harness = sessionHarness()
    const profile = new CanvasBrowserProfile()
    const first = handlers()
    const second = handlers()
    const releaseFirst = profile.register(webContents(1, harness.session), first)
    profile.register(webContents(2, harness.session), second)

    expect(await beforeResult(harness.listeners.before, request({ webContentsId: 999 }))).toEqual({
      cancel: true
    })

    const permissionResult = vi.fn()
    harness.listeners.permission?.({}, 'notifications', permissionResult)
    expect(permissionResult).toHaveBeenCalledWith(false)
    const preventDefault = vi.fn()
    harness.listeners.download?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()

    releaseFirst()
    releaseFirst()
    expect(profile.activeSurfaceCount).toBe(1)
    expect(await beforeResult(harness.listeners.before, request())).toEqual({ cancel: true })
    expect(
      await beforeResult(harness.listeners.before, request({ id: 21, webContentsId: 2 }))
    ).toEqual({ cancel: false })
    expect(harness.session.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
    expect(harness.flushStorageData).toHaveBeenCalledOnce()
  })

  it('clears durable storage/cache only when no browser surface is live', async () => {
    const harness = sessionHarness()
    const profile = new CanvasBrowserProfile({
      resolveSession: () => harness.session
    })
    const release = profile.register(webContents(1, harness.session), handlers())

    await expect(profile.clearBrowsingData()).rejects.toThrow(/close all/i)
    release()
    await profile.clearBrowsingData()

    expect(harness.clearStorageData).toHaveBeenCalledOnce()
    expect(harness.clearCache).toHaveBeenCalledOnce()
    expect(harness.flushStorageData).toHaveBeenCalledTimes(2)
  })
})
