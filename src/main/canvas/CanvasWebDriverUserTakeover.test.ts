import { describe, expect, it, vi } from 'vitest'
import { CanvasWebDriver } from './CanvasWebDriver'
import type { CanvasHostSurface } from './CanvasHostSurface'

/**
 * The user always wins.
 *
 * Before this, nothing in the canvas layer knew a human existed: there was no
 * pause, no cancel-on-input and no lock, and every click/fill called
 * scrollIntoView + el.focus() unconditionally — so an agent acting while someone
 * was typing yanked their viewport and stole their caret.
 *
 * Two independent clocks are under test here, and the distinction matters:
 *  - PRESENCE (`userActiveUntil`): someone is working in the surface right now,
 *    so don't talk over them at all.
 *  - FRESHNESS (`inputEpoch`): the caller can pin the observation its plan was
 *    built on and have the action refused if the page moved since.
 * Neither is a DOM revision — a counter driven by DOM mutation would never settle
 * on a page with polling or animation, and the agent could never land anything.
 */

type InputListener = (event: unknown, input: { type: string }) => void

function harness(): {
  driver: CanvasWebDriver
  emitInput: (type: string) => void
  executeJavaScript: ReturnType<typeof vi.fn>
} {
  const inputListeners: InputListener[] = []
  const loadListeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const executeJavaScript = vi.fn(async (source: string) => {
    if (source.includes('__twSecretRedaction')) return 0
    if (source.includes('nodeCount')) {
      return {
        url: 'http://localhost:3000/',
        title: 'App',
        viewport: { width: 1280, height: 800 },
        root: { ref: 'e1', role: 'document', tag: 'body' },
        nodeCount: 1,
        truncated: false
      }
    }
    // actScript: pretend the click landed so a refusal can't be mistaken for one.
    return { ok: true, found: true, action: 'click', executed: true, verified: 'changed' }
  })

  const webContents = {
    executeJavaScript,
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    getURL: () => 'http://localhost:3000/',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'input-event') {
        inputListeners.push(handler as unknown as InputListener)
        return
      }
      loadListeners.set(event, [...(loadListeners.get(event) ?? []), handler])
    }),
    removeListener: vi.fn(),
    session: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
        onBeforeSendHeaders: vi.fn(),
        onHeadersReceived: vi.fn(),
        onSendHeaders: vi.fn(),
        onResponseStarted: vi.fn(),
        onBeforeRedirect: vi.fn()
      }
    },
    loadURL: vi.fn(async () => {
      await Promise.resolve()
      for (const handler of loadListeners.get('did-finish-load') ?? []) handler()
    })
  }

  const surface: CanvasHostSurface = {
    webContents: webContents as unknown as CanvasHostSurface['webContents'],
    getTitle: () => 'App',
    setContentSize: vi.fn(),
    isDestroyed: () => false,
    destroy: vi.fn(),
    onClosed: vi.fn()
  }

  const driver = new CanvasWebDriver('s1', {
    createSurface: () => surface,
    resolveHost: async () => ['127.0.0.1']
  })

  return {
    driver,
    emitInput: (type: string) => {
      for (const listener of inputListeners) listener({}, { type })
    },
    executeJavaScript
  }
}

async function openedHarness(): Promise<ReturnType<typeof harness>> {
  const h = harness()
  await h.driver.open({ url: 'http://localhost:3000/' })
  return h
}

describe('canvas user takeover', () => {
  it('refuses to act while the user is interacting, without touching the page', async () => {
    const { driver, emitInput, executeJavaScript } = await openedHarness()
    emitInput('mouseDown')
    executeJavaScript.mockClear()

    const result = await driver.act({ kind: 'click', ref: 'e1' })

    expect(result.ok).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('user_active')
    // Nothing was injected at all — not even the act script.
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('watches the mouse, not just the keyboard', async () => {
    // before-input-event would only have caught keyboard, and a click is exactly
    // the interaction we must not talk over.
    for (const type of ['mouseDown', 'mouseWheel', 'keyDown', 'touchStart']) {
      const { driver, emitInput } = await openedHarness()
      emitInput(type)
      const result = await driver.act({ kind: 'click', ref: 'e1' })
      expect(result.refusalReason, `${type} should hold the surface`).toBe('user_active')
    }
  })

  it('ignores a parked cursor so a resting pointer cannot lock the agent out', async () => {
    const { driver, emitInput } = await openedHarness()
    emitInput('mouseMove')

    const result = await driver.act({ kind: 'click', ref: 'e1' })

    expect(result.executed).toBe(true)
  })

  it('lets the agent act again once the grace window has passed', async () => {
    vi.useFakeTimers()
    try {
      const { driver, emitInput } = await openedHarness()
      emitInput('keyDown')
      expect((await driver.act({ kind: 'click', ref: 'e1' })).refusalReason).toBe('user_active')

      vi.advanceTimersByTime(1600)
      const result = await driver.act({ kind: 'click', ref: 'e1' })

      expect(result.executed).toBe(true)
      expect(result.refusalReason).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps the input epoch onto a snapshot so a plan can be pinned to it', async () => {
    const { driver, emitInput } = await openedHarness()
    const before = await driver.snapshot()
    expect(before.inputEpoch).toBe(0)

    emitInput('mouseDown')
    const after = await driver.snapshot()

    expect(after.inputEpoch).toBe(1)
  })

  it('refuses a stale expectedInputEpoch even after the user has stopped', async () => {
    vi.useFakeTimers()
    try {
      const { driver, emitInput } = await openedHarness()
      const snapshot = await driver.snapshot()
      emitInput('mouseDown')
      // Presence has lapsed, but the page still moved since the observation.
      vi.advanceTimersByTime(1600)

      const result = await driver.act({
        kind: 'click',
        ref: 'e1',
        expectedInputEpoch: snapshot.inputEpoch
      })

      expect(result.executed).toBe(false)
      expect(result.refusalReason).toBe('stale_input_epoch')
    } finally {
      vi.useRealTimers()
    }
  })

  it('acts on a current expectedInputEpoch', async () => {
    const { driver } = await openedHarness()
    const snapshot = await driver.snapshot()

    const result = await driver.act({
      kind: 'click',
      ref: 'e1',
      expectedInputEpoch: snapshot.inputEpoch
    })

    expect(result.executed).toBe(true)
  })

  it('acts without an expectedInputEpoch, so the guard is opt-in', async () => {
    vi.useFakeTimers()
    try {
      const { driver, emitInput } = await openedHarness()
      emitInput('mouseDown')
      vi.advanceTimersByTime(1600)

      const result = await driver.act({ kind: 'click', ref: 'e1' })

      expect(result.executed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
