import { useEffect, useState } from 'react'

/**
 * Whether the window is both visible AND focused.
 *
 * Ported from the decayed `.WORK-IN-PROGRESS-observatory-gpu-calm` claim, whose
 * finding is the reason this exists: **Electron disables macOS occlusion
 * tracking, so a window fully covered by other applications still composites
 * every frame at full display rate.** That is a steady-state GPU cost paid on
 * every user's machine whenever the app is behind another window — it needs no
 * ensemble fan-out to reproduce.
 *
 * The conjunction is the whole correctness of this hook, and neither half is
 * sufficient alone:
 *  - `visibilityState` alone misses the case this exists for. A window covered
 *    by other apps is still `'visible'` to the page; that is precisely what
 *    Electron fails to occlude.
 *  - `hasFocus()` alone is not enough either — a minimised window can retain
 *    focus under some window managers.
 *
 * Note the app's existing `document.visibilityState !== 'hidden'` checks
 * (App.tsx, MistralQuotaMeter) are data-refresh triggers with a deliberately
 * different question: "should I re-fetch?". They are not a substitute for this
 * and must not be consolidated with it.
 */
function readWindowActiveFromDocument(): boolean {
  if (typeof document === 'undefined') return true
  return readWindowActive(document.visibilityState, document.hasFocus())
}

/**
 * Pure core, split out so it is testable without a DOM — this repo runs vitest
 * with no jsdom environment (see `useViewportWidth`'s `initialViewportWidth`
 * for the same split).
 */
export function readWindowActive(visibilityState: string, hasFocus: boolean): boolean {
  return visibilityState === 'visible' && hasFocus
}

/** Applied to the shell root while the window is idle. */
export const WINDOW_IDLE_CLASS = 'is-window-idle'

/**
 * IDLE is the marked state, not active.
 *
 * Marking the active state instead would leave every ambient animation paused
 * during the first paint — before the hook has mounted and applied the class —
 * so the app would boot visibly frozen and then unfreeze. Marking idle means
 * the default (unmarked) state is the running one.
 */
export function windowIdleClassName(active: boolean): string {
  return active ? '' : WINDOW_IDLE_CLASS
}

export function useWindowActive(): boolean {
  const [active, setActive] = useState(readWindowActiveFromDocument)

  useEffect(() => {
    const update = (): void => setActive(readWindowActiveFromDocument())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    // The window can gain or lose focus between first render and this effect,
    // which would otherwise leave the initial value uncorrected until the next
    // transition.
    update()
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  return active
}
