import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasBrowserProfileController } from './CanvasBrowserProfile'
import type { CanvasHostSurface, CanvasSurfaceOptions } from './CanvasHostSurface'
import { CanvasWebDriver } from './CanvasWebDriver'

describe('CanvasWebDriver browser profile binding', () => {
  it('opens on the injected persistent partition and releases only its own route', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const release = vi.fn()
    const register = vi.fn(() => release)
    const profile: CanvasBrowserProfileController = {
      partition: 'persist:test-canvas-browser',
      activeSurfaceCount: 0,
      register,
      clearBrowsingData: vi.fn(async () => {})
    }
    const webContents = {
      id: 17,
      session: {} as Session,
      setWindowOpenHandler: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      getURL: vi.fn(() => 'http://localhost:3000/'),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      }),
      removeListener: vi.fn(),
      loadURL: vi.fn(async () => {
        for (const listener of listeners.get('did-finish-load') ?? []) listener()
      })
    } as unknown as WebContents
    const destroy = vi.fn()
    const surface: CanvasHostSurface = {
      webContents,
      getTitle: () => 'Browser',
      setContentSize: vi.fn(),
      isDestroyed: () => false,
      destroy,
      onClosed: vi.fn()
    }
    const surfaceOptions: CanvasSurfaceOptions[] = []
    const driver = new CanvasWebDriver('canvas-1', {
      browserProfile: profile,
      createSurface: (options) => {
        surfaceOptions.push(options)
        return surface
      },
      resolveHost: async () => ['127.0.0.1']
    })

    await driver.open({ url: 'http://localhost:3000/' })

    expect(surfaceOptions).toEqual([
      { partition: 'persist:test-canvas-browser', width: 1280, height: 800 }
    ])
    expect(register).toHaveBeenCalledWith(webContents, expect.any(Object))

    await driver.close()
    expect(release).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
  })
})
