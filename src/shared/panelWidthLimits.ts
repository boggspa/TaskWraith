/**
 * Right-dock (inspector) width bounds — the single source of truth for every
 * seam that clamps this width: the renderer resize handlers and appearance
 * normalizer, and main's settings sanitizer.
 *
 * Both processes MUST read these. A stale local copy on either side silently
 * re-clamps dragged widths at that seam: a renderer-local MAX of 720 once
 * undid every appearance.update(), and after that was fixed main's sanitizer
 * copy (also 720) kept snapping wide drags back on the next settings
 * round-trip/relaunch — capping canvas surfaces in the dock at 720px however
 * far the user dragged.
 *
 * The transcript needs no protection from these numbers: `.right-dock`'s CSS
 * `max-width: calc(100% - 430px)` reserves the transcript floor out of the
 * split region regardless, and `rightPanelViewportMax` keeps stored widths
 * proportional on windows narrower than the one they were saved on.
 */
export const MIN_INSPECTOR_PANEL_WIDTH = 300

/**
 * Wide-window ceiling only. Canvas surfaces in the dock (large Mesh scenes,
 * desktop-style Browser work) legitimately want most of a fullscreen or
 * ultrawide window, so this stops nothing short of the dock swallowing the
 * layout entirely; narrow windows are protected by proportion, not by this.
 */
export const MAX_INSPECTOR_PANEL_WIDTH = 2400

/**
 * Fraction of the window the dock may occupy. High enough that fullscreen and
 * ultrawide windows can give canvas work a desktop-sized viewport; on laptop
 * widths the CSS transcript-floor reservation bites first anyway.
 */
export const RIGHT_PANEL_VIEWPORT_FRACTION = 0.72

/** The window-proportional ceiling every right-dock clamp site applies. */
export function rightPanelViewportMax(viewportWidth: number): number {
  return Math.min(
    MAX_INSPECTOR_PANEL_WIDTH,
    Math.max(MIN_INSPECTOR_PANEL_WIDTH, Math.floor(viewportWidth * RIGHT_PANEL_VIEWPORT_FRACTION))
  )
}
