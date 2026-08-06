/**
 * Ported from the decayed `.WORK-IN-PROGRESS-observatory-gpu-calm` claim.
 *
 * The finding being ported: Electron disables macOS occlusion tracking, so a
 * window fully covered by other applications STILL COMPOSITES EVERY FRAME at
 * full display rate. That is a steady-state GPU cost burning on every user's
 * machine right now — it needs no fan-out to reproduce — and it is fixed by
 * PAUSING ambient animation, not by removing it.
 *
 * The whole correctness of this hook is the conjunction below. `visibilityState`
 * alone is NOT enough: a window that is covered by another app is still
 * `'visible'` to the page, which is exactly the case Electron fails to occlude.
 * `hasFocus()` alone is NOT enough either: a minimised window can retain focus
 * in some window managers. Both signals are required, and the app's existing
 * `visibilityState !== 'hidden'` checks (App.tsx, MistralQuotaMeter) are data-
 * refresh triggers that deliberately do NOT cover the covered-window case.
 */
import { describe, expect, it } from 'vitest'
import { WINDOW_IDLE_CLASS, readWindowActive, windowIdleClassName } from './useWindowActive'

describe('readWindowActive', () => {
  it('is active only when the window is both visible and focused', () => {
    expect(readWindowActive('visible', true)).toBe(true)
  })

  /**
   * THE case this port exists for. A window covered by other applications
   * reports `visible` and loses focus; without the focus half of the
   * conjunction it would keep compositing ambient animation around the clock.
   */
  it('is inactive when visible but unfocused — the covered-window case', () => {
    expect(readWindowActive('visible', false)).toBe(false)
  })

  it('is inactive when hidden, even if it somehow still holds focus', () => {
    expect(readWindowActive('hidden', true)).toBe(false)
  })

  it('is inactive when hidden and unfocused', () => {
    expect(readWindowActive('hidden', false)).toBe(false)
  })

  it('treats any non-visible state as inactive', () => {
    expect(readWindowActive('prerender', true)).toBe(false)
  })
})

describe('windowIdleClassName', () => {
  /**
   * Idle is the marked state, not active. Marking the ACTIVE state instead
   * would leave the animations paused during the first paint, before the hook
   * has run — the app would boot visibly frozen.
   */
  it('marks the idle state and leaves the active state unmarked', () => {
    expect(windowIdleClassName(false)).toBe(WINDOW_IDLE_CLASS)
    expect(windowIdleClassName(true)).toBe('')
  })

  it('exposes the class the stylesheet gates on', () => {
    expect(WINDOW_IDLE_CLASS).toBe('is-window-idle')
  })
})
