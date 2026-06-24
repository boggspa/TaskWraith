import { describe, it, expect, vi, beforeEach } from 'vitest'

// The renderer imports `electron` at module load. We never want a real window in
// a unit test — the area guard under test fires BEFORE any allocation, so a
// spy constructor is enough to PROVE the guard short-circuits (ctor never runs)
// and, for the within-budget direction, that execution reaches the render body.
// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory references it.
const { browserWindowCtor } = vi.hoisted(() => ({ browserWindowCtor: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: browserWindowCtor,
  nativeImage: { createFromBuffer: vi.fn() }
}))

import {
  createNativeImageEngine,
  MAX_OFFSCREEN_RENDER_PIXELS,
  MAX_IMAGE_DIMENSION
} from './OffscreenImageRenderer'

// A minimal fake window that lets renderHtmlToPng enter its try-block and then
// throws a sentinel at the first `webContents.session` access — so the within-
// budget path proves it got PAST the guard, while the `finally` still releases
// the render slot (no semaphore leak across tests).
function fakeWindowThatReachesRenderBody() {
  return {
    webContents: {
      get session(): never {
        throw new Error('SENTINEL_REACHED_RENDER_BODY')
      }
    },
    setContentSize: vi.fn(),
    isDestroyed: () => true,
    destroy: vi.fn()
  }
}

describe('OffscreenImageRenderer area guard (framebuffer-OOM DoS)', () => {
  const engine = createNativeImageEngine()

  beforeEach(() => {
    browserWindowCtor.mockReset()
  })

  it('rejects an over-budget render BEFORE allocating a BrowserWindow', async () => {
    // 8192×8192 = 67M px ≫ the 24M cap — must throw at the area guard, which sits
    // ahead of slot acquisition and window construction.
    await expect(
      engine.renderHtmlToPng('<html></html>', MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, 1000)
    ).rejects.toThrow(/too large/)
    expect(browserWindowCtor).not.toHaveBeenCalled()
  })

  it('does not over-fire: a within-budget render passes the guard into the render body', async () => {
    // Regular function (not an arrow) so it is usable with `new`.
    browserWindowCtor.mockImplementation(function () {
      return fakeWindowThatReachesRenderBody()
    })
    // 1024×768 = 786k px, well within budget — the guard must NOT fire; execution
    // proceeds to construct the window and enter the render body (sentinel).
    await expect(engine.renderHtmlToPng('<html></html>', 1024, 768, 1000)).rejects.toThrow(
      'SENTINEL_REACHED_RENDER_BODY'
    )
    expect(browserWindowCtor).toHaveBeenCalledTimes(1)
  })

  it('the cap rejects the 8192² bomb but admits a 4096² render', () => {
    expect(MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION).toBeGreaterThan(MAX_OFFSCREEN_RENDER_PIXELS)
    expect(4096 * 4096).toBeLessThanOrEqual(MAX_OFFSCREEN_RENDER_PIXELS)
  })
})

describe('OffscreenImageRenderer render-slot leak (semaphore-wedge DoS on window-construction failure)', () => {
  const engine = createNativeImageEngine()

  beforeEach(() => {
    browserWindowCtor.mockReset()
  })

  it('releases the slot when BrowserWindow construction throws, so the semaphore never wedges', async () => {
    // Every construction blows up — simulating GPU/compositor init failure, OOM,
    // or Electron mid-teardown. The throw lands AFTER the slot is acquired. If
    // the slot leaked on each failure (the bug), the (MAX_CONCURRENT_RENDERS+1)th
    // acquire would queue forever and the await below would hang until vitest's
    // timeout. The fix builds the window inside the try, so the `finally` runs
    // and releases the slot on every failure.
    browserWindowCtor.mockImplementation(function () {
      throw new Error('CTOR_BOOM')
    })

    // Fire well past the concurrency cap (3). Each must reject — and crucially
    // each must REACH `new BrowserWindow` (i.e. acquire a slot), not stall.
    const ATTEMPTS = 6
    for (let i = 0; i < ATTEMPTS; i += 1) {
      await expect(engine.renderHtmlToPng('<html></html>', 64, 64, 1000)).rejects.toThrow(
        'CTOR_BOOM'
      )
    }
    // Proof of no wedge: the 4th..6th calls all constructed a window. A leaked
    // slot would have stranded everything past the 3rd, so the count would stop
    // at 3 (and the loop would have hung).
    expect(browserWindowCtor).toHaveBeenCalledTimes(ATTEMPTS)

    // And a subsequent within-budget render STILL acquires a slot (not wedged):
    // swap in a window that reaches the render body and prove execution gets there.
    browserWindowCtor.mockImplementation(function () {
      return fakeWindowThatReachesRenderBody()
    })
    await expect(engine.renderHtmlToPng('<html></html>', 64, 64, 1000)).rejects.toThrow(
      'SENTINEL_REACHED_RENDER_BODY'
    )
    expect(browserWindowCtor).toHaveBeenCalledTimes(ATTEMPTS + 1)
  })
})
