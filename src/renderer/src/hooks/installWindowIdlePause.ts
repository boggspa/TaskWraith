/**
 * Non-React bootstrap for the window-idle ambient-animation pause.
 *
 * Complements `useWindowActive` (ported by the work lane that owns the hook).
 * Installed from `main.tsx` so ambient animations pause even before React
 * mounts, and so we never need a one-line call inside the App.tsx monolith.
 *
 * Applies `is-window-idle` to `document.documentElement` when the window is
 * not both visible AND focused. The stylesheet gates on that class.
 */
import { WINDOW_IDLE_CLASS, readWindowActive } from './useWindowActive'

function syncWindowIdleClass(): void {
  if (typeof document === 'undefined') return
  const active = readWindowActive(document.visibilityState, document.hasFocus())
  document.documentElement.classList.toggle(WINDOW_IDLE_CLASS, !active)
}

/**
 * Idempotent. Safe to call once at renderer boot.
 * Returns a disposer for tests / hot reload.
 */
export function installWindowIdlePause(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined
  }

  const update = (): void => syncWindowIdleClass()
  window.addEventListener('focus', update)
  window.addEventListener('blur', update)
  document.addEventListener('visibilitychange', update)
  update()

  return () => {
    window.removeEventListener('focus', update)
    window.removeEventListener('blur', update)
    document.removeEventListener('visibilitychange', update)
    document.documentElement.classList.remove(WINDOW_IDLE_CLASS)
  }
}
