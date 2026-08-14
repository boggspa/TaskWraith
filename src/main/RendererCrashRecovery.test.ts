import { EventEmitter } from 'node:events'
import type { BrowserWindow, Event } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRendererCrashRecoveryHtml,
  buildRendererCrashRecoveryUrl,
  RendererCrashRecovery
} from './RendererCrashRecovery'

class FakeWebContents extends EventEmitter {
  currentUrl = 'file:///Applications/TaskWraith.app/renderer/index.html'
  destroyed = false

  getURL(): string {
    return this.currentUrl
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function createWindow() {
  const webContents = new FakeWebContents()
  const loadedUrls: string[] = []
  const close = vi.fn()
  const window = {
    webContents,
    isDestroyed: () => false,
    close,
    loadURL: vi.fn(async (url: string) => {
      loadedUrls.push(url)
    })
  } as unknown as BrowserWindow
  return { window, webContents, loadedUrls, close }
}

const details = {
  reason: 'oom' as const,
  exitCode: 9,
  activeRunCount: 2
}

describe('RendererCrashRecovery', () => {
  it('builds a self-contained recovery document with truthful run continuity copy', () => {
    const html = buildRendererCrashRecoveryHtml(details)
    expect(html).toContain('The TaskWraith interface stopped unexpectedly')
    expect(html).toContain('Your 2 active runs are still continuing in the background.')
    expect(html).toContain('Reloading rebuilds this window and does not cancel provider work.')
    expect(html).toContain('Renderer exit: oom (9)')

    const dataUrl = buildRendererCrashRecoveryUrl(details)
    expect(dataUrl).toMatch(/^data:text\/html;charset=utf-8,/)
    expect(decodeURIComponent(dataUrl.split(',', 2)[1])).toBe(html)
  })

  it('uses singular and idle copy without claiming a run was stopped', () => {
    expect(buildRendererCrashRecoveryHtml({ ...details, activeRunCount: 1 })).toContain(
      'Your active run is still continuing in the background.'
    )
    expect(buildRendererCrashRecoveryHtml({ ...details, activeRunCount: 0 })).toContain(
      'No run was stopped by this renderer failure.'
    )
  })

  it('loads recovery after a crash and reloads the remembered application URL', async () => {
    const { window, webContents, loadedUrls } = createWindow()
    const recovery = new RendererCrashRecovery(window)

    expect(recovery.show(details)).toBe(true)
    expect(loadedUrls).toHaveLength(1)
    expect(loadedUrls[0]).toMatch(/^data:text\/html/)

    webContents.emit(
      'did-navigate-in-page',
      {} as Event,
      `${loadedUrls[0]}#reload-taskwraith`,
      true,
      1,
      1
    )
    await Promise.resolve()

    expect(loadedUrls.at(-1)).toBe('file:///Applications/TaskWraith.app/renderer/index.html')
  })

  it('lets the recovery document close its window and ignores subframe actions', () => {
    const { window, webContents, loadedUrls, close } = createWindow()
    const recovery = new RendererCrashRecovery(window)
    recovery.show(details)

    webContents.emit(
      'did-navigate-in-page',
      {} as Event,
      `${loadedUrls[0]}#close-taskwraith`,
      false,
      1,
      2
    )
    expect(close).not.toHaveBeenCalled()

    webContents.emit(
      'did-navigate-in-page',
      {} as Event,
      `${loadedUrls[0]}#close-taskwraith`,
      true,
      1,
      1
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not install a fallback when no application URL was ever loaded', () => {
    const { window, webContents, loadedUrls } = createWindow()
    webContents.currentUrl = ''
    const recovery = new RendererCrashRecovery(window)

    expect(recovery.show(details)).toBe(false)
    expect(loadedUrls).toEqual([])
  })

  it('removes its navigation listeners on disposal', () => {
    const { window, webContents } = createWindow()
    const recovery = new RendererCrashRecovery(window)
    expect(webContents.listenerCount('did-navigate')).toBe(1)
    expect(webContents.listenerCount('did-navigate-in-page')).toBe(1)

    recovery.dispose()
    expect(webContents.listenerCount('did-navigate')).toBe(0)
    expect(webContents.listenerCount('did-navigate-in-page')).toBe(0)
  })
})
