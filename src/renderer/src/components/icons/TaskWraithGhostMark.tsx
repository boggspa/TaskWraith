import type { JSX } from 'react'

/**
 * The TaskWraith monoline ghost, as used by every density strip.
 *
 * Shared so the fleet wave strip and the execution graph strip draw the same
 * mark from one source. Consumers declare the viewBox themselves — the paths
 * are meaningless without it, and `fleetWaveGhostStripCss.test.ts` pins the
 * relationship between this box and the CSS stroke weight
 * (effective px = stroke-width × cellPx / 128), so the two must be read
 * together at each call site rather than hidden behind a wrapper.
 */
export const TASKWRAITH_GHOST_VIEWBOX_UNITS = 128

/** Paths from taskwraith-ghost-monoline.svg (viewBox 0 0 128 128). */
export const TASKWRAITH_GHOST_MONOLINE_PATHS: JSX.Element = (
  <>
    <path d="M56 30H80L92 36L98 48V84H92L86 90L80 84L74 96L68 84L56 96L50 84H38V48L44 36Z" />
    <path d="M50 84V104" />
    <path d="M68 84V104" />
    <path d="M86 90V104" />
    <rect x="51" y="54" width="10" height="14" />
    <rect x="75" y="54" width="10" height="14" />
  </>
)
