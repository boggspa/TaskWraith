import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('TUI headless Host main integration', () => {
  it('suppresses initial desktop presentation for an exact headless session', () => {
    expect(indexSource).toContain('const tuiHeadlessHostSession = new TuiHeadlessHostSession()')
    expect(indexSource).toContain('tuiHeadlessHostSession.shouldSuppressMacPresentation')
    expect(indexSource).toContain(
      'if (!openedForDeferredSecondInstance && !tuiHeadlessHostSession.isHeadless) createWindow()'
    )
    expect(indexSource).toContain('if (tuiHeadlessHostSession.isHeadless) return')
    expect(indexSource).toContain('tuiHeadlessHostSession.promoteToDesktop()')
    expect(indexSource).toContain('restoreDesktopAppPresentation()')
  })

  it('distinguishes a duplicate headless launch from ordinary desktop promotion', () => {
    const handler = indexSource.indexOf("app.on('second-instance', (_event, commandLine) =>")
    const postureCheck = indexSource.indexOf(
      'tuiHeadlessHostSession.shouldPresentForSecondInstance(commandLine)',
      handler
    )
    const windowRequest = indexSource.indexOf(
      'startupWindowGate.requestWindow(createWindow)',
      handler
    )

    expect(handler).toBeGreaterThanOrEqual(0)
    expect(postureCheck).toBeGreaterThan(handler)
    expect(windowRequest).toBeGreaterThan(postureCheck)
  })

  it('keeps a no-window Host alive for clients or work and disposes on quit', () => {
    const monitor = indexSource.indexOf('tuiHeadlessHostSession.startMonitoring({')
    const clientCount = indexSource.indexOf('hostLifecycle.getConnectedClientCount()', monitor)
    const activeThreads = indexSource.indexOf('getActiveTaskWraithThreadCount() > 0', monitor)
    const activeStreams = indexSource.indexOf('hasActiveStreamingTaskWraithRun()', monitor)
    const dispose = indexSource.indexOf('tuiHeadlessHostSession.dispose()', monitor)

    expect(monitor).toBeGreaterThanOrEqual(0)
    expect(clientCount).toBeGreaterThan(monitor)
    expect(activeThreads).toBeGreaterThan(clientCount)
    expect(activeStreams).toBeGreaterThan(activeThreads)
    expect(dispose).toBeGreaterThan(activeStreams)
  })
})
