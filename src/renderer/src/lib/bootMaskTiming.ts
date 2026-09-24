/**
 * Boot-mask timing, stated once.
 *
 * `.app-boot-mask` is a `position: fixed; inset: 0` overlay with
 * `-webkit-app-region: drag`, so while it is mounted it swallows every click —
 * a drag region intercepts mouse input regardless of `pointer-events`. The
 * unmount timer was a flat 760 ms even under `prefers-reduced-motion`, where the
 * visual is a 160 ms fade, so a reduced-motion user spent ~600 ms unable to
 * click an app that looked completely ready.
 *
 * Two separate fixes follow from that, and they are deliberately independent:
 * input is released the moment boot is ready (see `.is-leaving` in
 * `16-boot-mask.css`), and the element is unmounted when its own animation has
 * actually finished.
 */

/** Matches `taskwraith-boot-wipe` in 16-boot-mask.css. */
export const BOOT_MASK_WIPE_MS = 720

/** Matches `taskwraith-boot-fade` under `prefers-reduced-motion: reduce`. */
export const BOOT_MASK_REDUCED_MOTION_FADE_MS = 160

/** One frame of slack so the node is not removed mid-composite. */
export const BOOT_MASK_UNMOUNT_BUFFER_MS = 40

export function bootMaskUnmountDelayMs(prefersReducedMotion: boolean): number {
  const animation = prefersReducedMotion ? BOOT_MASK_REDUCED_MOTION_FADE_MS : BOOT_MASK_WIPE_MS
  return animation + BOOT_MASK_UNMOUNT_BUFFER_MS
}

/** Safe in non-DOM environments (SSR-rendered tests, popouts mid-teardown). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
