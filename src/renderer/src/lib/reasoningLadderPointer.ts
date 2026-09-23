/**
 * Reasoning ladder pointer maths — pure and DOM-free, so the drag contract is
 * testable without a renderer.
 *
 * The thumb only ever sits on a real (enabled) stop. A pointer resolves to the
 * nearest enabled stop by its TRUE distance along the rail, with exact ties
 * going to the higher stop (iOS parity). Once a stop is held, the pointer has to
 * pass the midpoint to a neighbour by a small deadband before the thumb moves,
 * so a finger resting on a boundary can never make it flicker. Release commits
 * exactly the stop on screen: nothing re-resolves the release point, so letting
 * go never moves the thumb.
 *
 * The old drag rounded the raw position to the nearest of all eight stops
 * first and only then looked for an enabled one, which put the boundary across
 * a gap (Kimi's High → Max skips Extra) off-centre, and it re-read the pointer
 * on release, so a release inside the boundary zone could land one stop away
 * from where the thumb was showing.
 */

/** Pixels past a midpoint before a held stop gives way to its neighbour. */
export const LADDER_DETENT_DEADBAND_PX = 3

const TIE_EPSILON = 1e-9

/** Rail position of a ladder index: 0 = bottom stop … 1 = top stop. */
export function ladderStopFraction(index: number, maxIndex: number): number {
  if (maxIndex <= 0) return 0
  return Math.max(0, Math.min(1, index / maxIndex))
}

/**
 * Pointer y → position on the usable rail (0 = bottom … 1 = top). `inset` is
 * the travel the track reserves above the top stop and below the bottom one.
 */
export function ladderPointerFraction(
  clientY: number,
  rail: { top: number; height: number },
  inset: number
): number {
  const usable = Math.max(1, rail.height - inset * 2)
  return Math.max(0, Math.min(1, 1 - (clientY - rail.top - inset) / usable))
}

/** The pixel deadband expressed as a fraction of the usable rail. */
export function ladderDeadbandFraction(
  railHeight: number,
  inset: number,
  deadbandPx: number = LADDER_DETENT_DEADBAND_PX
): number {
  return Math.max(0, deadbandPx) / Math.max(1, railHeight - inset * 2)
}

/**
 * The enabled stop the thumb should sit on for a pointer position, or null
 * when nothing is enabled. Pass the stop a drag already holds as
 * `currentIndex` to apply the deadband; omit it for a fresh press.
 */
export function resolveLadderPointerStop(params: {
  fraction: number
  enabledIndices: readonly number[]
  maxIndex: number
  currentIndex?: number | null
  deadbandFraction?: number
}): number | null {
  const { enabledIndices, maxIndex } = params
  if (enabledIndices.length === 0) return null
  const fraction = Math.max(0, Math.min(1, params.fraction))
  let best: number | null = null
  let bestDistance = Infinity
  for (const index of enabledIndices) {
    const distance = Math.abs(ladderStopFraction(index, maxIndex) - fraction)
    const tie = Math.abs(distance - bestDistance) < TIE_EPSILON
    if ((!tie && distance < bestDistance) || (tie && best !== null && index > best)) {
      best = index
      bestDistance = distance
    }
  }
  const current = params.currentIndex
  if (best === null || current == null || best === current || !enabledIndices.includes(current)) {
    return best
  }
  // Moving d past the midpoint changes (currentDistance - bestDistance) by 2d.
  const currentDistance = Math.abs(ladderStopFraction(current, maxIndex) - fraction)
  const deadband = Math.max(0, params.deadbandFraction ?? 0)
  return currentDistance - bestDistance > 2 * deadband + TIE_EPSILON ? best : current
}

export type LadderDragEvent =
  | { type: 'press'; fraction: number }
  | { type: 'move'; fraction: number }
  | { type: 'release' }
  | { type: 'cancel' }

export interface LadderDragStep {
  /** The stop the thumb shows while a drag is live; null once it ends. */
  dragIndex: number | null
  /** Set only by a release: the stop to commit, which is the one on screen. */
  commitIndex: number | null
}

/**
 * One step of the drag state machine. A press jumps straight to the nearest
 * stop (no deadband to beat), moves apply the deadband against the held stop,
 * and a release commits the held stop without consulting the pointer again.
 */
export function stepLadderDrag(
  dragIndex: number | null,
  event: LadderDragEvent,
  rail: { enabledIndices: readonly number[]; maxIndex: number; deadbandFraction: number }
): LadderDragStep {
  if (event.type === 'press') {
    return {
      dragIndex: resolveLadderPointerStop({
        fraction: event.fraction,
        enabledIndices: rail.enabledIndices,
        maxIndex: rail.maxIndex
      }),
      commitIndex: null
    }
  }
  if (event.type === 'move') {
    if (dragIndex === null) return { dragIndex: null, commitIndex: null }
    return {
      dragIndex: resolveLadderPointerStop({
        fraction: event.fraction,
        enabledIndices: rail.enabledIndices,
        maxIndex: rail.maxIndex,
        currentIndex: dragIndex,
        deadbandFraction: rail.deadbandFraction
      }),
      commitIndex: null
    }
  }
  if (event.type === 'release') return { dragIndex: null, commitIndex: dragIndex }
  return { dragIndex: null, commitIndex: null }
}

export interface LadderMark {
  index: number
  /** The model offers this stop; false renders the faint "not here" dot. */
  enabled: boolean
  /** An enabled stop below the thumb (the fill has passed it). */
  reached: boolean
  /** The stop the thumb sits on. */
  current: boolean
}

/**
 * One mark per ladder stop for a model with a real ladder; none for a model
 * whose reasoning is not configurable at all (the neutral `—` rail).
 */
export function buildLadderMarks(
  enabledIndices: readonly number[],
  displayIndex: number,
  maxIndex: number
): LadderMark[] {
  if (enabledIndices.length === 0) return []
  const enabled = new Set(enabledIndices)
  return Array.from({ length: maxIndex + 1 }, (_, index) => {
    const isEnabled = enabled.has(index)
    return {
      index,
      enabled: isEnabled,
      reached: isEnabled && index < displayIndex,
      current: isEnabled && index === displayIndex
    }
  })
}
