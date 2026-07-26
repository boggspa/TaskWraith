import { describe, expect, it, vi } from 'vitest'
import { CanvasSketchDriver } from './CanvasSketchDriver'
import type { CanvasHostSurface } from './CanvasHostSurface'
import type { CanvasSketchDocument } from './canvasTypes'

/**
 * Covers the sketch-update concurrency guards.
 *
 * The bug being pinned (2026-07-26): a human's in-progress stroke is pushed into
 * doc.elements at pointerdown and then mutated in place through a local `draft`
 * reference. An agent canvas_sketch_update with mode:'replace' or 'clear' reset
 * doc.elements unconditionally, dropping the draft from the document while the
 * drag carried on mutating an orphan — render() rebuilds only from doc.elements
 * and finish() cannot put it back, so the stroke was silently destroyed.
 * doc.updatedAt was maintained the whole time and never used as a precondition.
 */

function fakeSurface(executeJavaScript: (source: string) => Promise<unknown>): {
  surface: CanvasHostSurface
  calls: string[]
} {
  const calls: string[] = []
  // waitForLoad registers did-finish-load / did-fail-load, calls loadURL, then
  // removeListener on settle — the fake has to honour all four or open() hangs.
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler])
  })
  const removeListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    listeners.set(
      event,
      (listeners.get(event) ?? []).filter((entry) => entry !== handler)
    )
  })
  const webContents = {
    executeJavaScript: (source: string) => {
      calls.push(source)
      return executeJavaScript(source)
    },
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    on,
    once: on,
    removeListener,
    removeAllListeners: vi.fn(),
    session: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn()
    },
    loadURL: vi.fn(async () => {
      // Resolve the load on the next microtask, as a real navigation would.
      await Promise.resolve()
      for (const handler of listeners.get('did-finish-load') ?? []) handler()
    })
  }
  const surface: CanvasHostSurface = {
    webContents: webContents as unknown as CanvasHostSurface['webContents'],
    getTitle: () => 'Sketch',
    setContentSize: vi.fn(),
    isDestroyed: () => false,
    destroy: vi.fn(),
    onClosed: vi.fn()
  }
  return { surface, calls }
}

const DOC: CanvasSketchDocument = {
  schemaVersion: 1,
  title: 'Board',
  viewport: { width: 1280, height: 800 },
  elements: [],
  updatedAt: 'T2'
}

async function openedDriver(
  applyResult: unknown
): Promise<{ driver: CanvasSketchDriver; calls: string[] }> {
  // Anything the page is asked for other than applyUpdate answers with a
  // document — open() bootstraps through the page too.
  const { surface, calls } = fakeSurface(async (source) =>
    source.includes('applyUpdate') ? applyResult : DOC
  )
  const driver = new CanvasSketchDriver('s1', {
    createSurface: () => surface,
    now: () => 'T1'
  })
  await driver.open({ driver: 'sketch' })
  return { driver, calls }
}

describe('CanvasSketchDriver update guards', () => {
  it('refuses an update while the user is mid-stroke, with a retryable reason', async () => {
    const { driver } = await openedDriver({ __twRefused: 'user_drawing' })

    await expect(driver.sketchUpdate({ mode: 'replace', elements: [] })).rejects.toThrow(
      /user is drawing/
    )
  })

  it('refuses an update whose expectedUpdatedAt is stale', async () => {
    const { driver } = await openedDriver({
      __twRefused: 'stale_document',
      updatedAt: 'T9'
    })

    await expect(driver.sketchUpdate({ mode: 'clear', expectedUpdatedAt: 'T2' })).rejects.toThrow(
      /stale expectedUpdatedAt/
    )
  })

  it('does not report a refusal as a document, and never caches one', async () => {
    const changed = vi.fn()
    const { surface } = fakeSurface(async (source) =>
      source.includes('applyUpdate') ? { __twRefused: 'user_drawing' } : DOC
    )
    const observed = new CanvasSketchDriver('s2', {
      createSurface: () => surface,
      onDocumentChange: changed
    })
    await observed.open({ driver: 'sketch' })
    changed.mockClear()

    await expect(observed.sketchUpdate({ mode: 'clear' })).rejects.toThrow()
    // A refusal is not a document change — nothing should be persisted for it.
    expect(changed).not.toHaveBeenCalled()
  })

  it('forwards expectedUpdatedAt into the page call so the page can compare it', async () => {
    const { driver, calls } = await openedDriver(DOC)

    await driver.sketchUpdate({ mode: 'clear', expectedUpdatedAt: 'T2' })

    const applyCall = calls.find((source) => source.includes('applyUpdate'))
    expect(applyCall).toBeDefined()
    expect(applyCall).toContain('"expectedUpdatedAt":"T2"')
  })

  it('applies normally and returns the document when nothing is in flight', async () => {
    const { driver } = await openedDriver(DOC)

    const result = await driver.sketchUpdate({ mode: 'clear' })

    expect(result.updatedAt).toBe('T2')
    expect(result.title).toBe('Board')
  })

  it('hardens the sketch session to parity with the web surface', async () => {
    const { surface } = fakeSurface(async () => DOC)
    const driver = new CanvasSketchDriver('s3', { createSurface: () => surface })
    await driver.open({ driver: 'sketch' })

    const wc = surface.webContents as unknown as {
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>
      session: {
        setPermissionRequestHandler: ReturnType<typeof vi.fn>
        setPermissionCheckHandler: ReturnType<typeof vi.fn>
        on: ReturnType<typeof vi.fn>
      }
    }
    expect(wc.setWindowOpenHandler).toHaveBeenCalled()
    expect(wc.session.setPermissionRequestHandler).toHaveBeenCalled()
    // The three that used to be web-only.
    expect(wc.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    expect(wc.session.setPermissionCheckHandler).toHaveBeenCalled()
    expect(wc.session.on).toHaveBeenCalledWith('will-download', expect.any(Function))
  })
})
