import { describe, expect, it, vi } from 'vitest'

// Spy the WebContentsView constructor so the exact webPreferences handed to
// Electron can be asserted (same pattern as OffscreenImageRenderer.test.ts).
const { webContentsViewCtor } = vi.hoisted(() => ({ webContentsViewCtor: vi.fn() }))

vi.mock('electron', () => ({
  WebContentsView: webContentsViewCtor
}))

import { createElectronEmbedView } from './CanvasEmbedView'

describe('createElectronEmbedView', () => {
  it('disables background throttling for emulator surfaces', () => {
    webContentsViewCtor.mockClear()
    createElectronEmbedView('canvas-emulator', 'emulator')
    expect(webContentsViewCtor).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({ backgroundThrottling: false })
    })
  })

  it('keeps the default throttling policy for web, sketch, and kindless embeds', () => {
    webContentsViewCtor.mockClear()
    createElectronEmbedView('canvas-web', 'web')
    createElectronEmbedView('canvas-sketch', 'sketch')
    createElectronEmbedView('canvas-default')
    expect(webContentsViewCtor).toHaveBeenCalledTimes(3)
    for (const [options] of webContentsViewCtor.mock.calls) {
      expect(options.webPreferences.backgroundThrottling).toBe(true)
    }
  })

  it('preserves the sandboxed profile prefs for every kind', () => {
    webContentsViewCtor.mockClear()
    createElectronEmbedView('canvas-emulator', 'emulator')
    expect(webContentsViewCtor).toHaveBeenCalledWith({
      webPreferences: {
        partition: 'canvas-emulator',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        backgroundThrottling: false
      }
    })
  })
})
