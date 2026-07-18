export type WelcomeFitLevel = 0 | 1 | 2 | 3

export const WELCOME_FIT_FULL: WelcomeFitLevel = 0
export const WELCOME_FIT_NOTIFICATION_HIDDEN: WelcomeFitLevel = 1
export const WELCOME_FIT_DASHBOARD_HIDDEN: WelcomeFitLevel = 2
export const WELCOME_FIT_HEATMAP_HIDDEN: WelcomeFitLevel = 3

export interface WelcomeFitRequirements {
  availableHeight: number
  fullHeight: number
  notificationHiddenHeight: number
  dashboardHiddenHeight: number
  hasNotification: boolean
  hasHeatmap: boolean
}

export interface ResolveWelcomeFitLevelInput extends WelcomeFitRequirements {
  currentLevel: WelcomeFitLevel
  collapseOverflow?: number
  restoreSlack?: number
}

/**
 * Resolve the full-layout budget when the welcome notification is present.
 *
 * The notification is absolutely positioned, so its rectangle is useful for
 * detecting a collision with the composer/heatmap. It is not, however, a
 * replacement for the normal dashboard + composer flow requirement: when the
 * notice happens to sit below that flow, its geometry can make the collision
 * projection look smaller than the content that is already overflowing.
 */
export function resolveWelcomeFullFitHeight(
  flowHeight: number,
  notificationCollisionHeight: number | null
): number {
  return Math.max(flowHeight, notificationCollisionHeight ?? 0)
}

/**
 * The vertical bounds needed by the welcome fit observer.
 *
 * A welcome composer stack may use `display: contents` so its children can
 * participate directly in the surrounding flex/grid layout. Such an element
 * has no box of its own, even though its rendered children do. This small,
 * DOM-free helper falls back to the union of those direct child boxes.
 */
export interface WelcomeFitStackBounds {
  top: number
  bottom: number
  height: number
}

export function resolveWelcomeFitStackBounds(
  ownBounds: WelcomeFitStackBounds,
  childBounds: readonly WelcomeFitStackBounds[]
): WelcomeFitStackBounds | null {
  if (ownBounds.height > 0) return ownBounds

  const renderedChildren = childBounds.filter((bounds) => bounds.height > 0)
  if (renderedChildren.length === 0) return null

  const top = Math.min(...renderedChildren.map((bounds) => bounds.top))
  const bottom = Math.max(...renderedChildren.map((bounds) => bounds.bottom))
  return { top, bottom, height: bottom - top }
}

const requiredLevelAtTolerance = (
  requirements: WelcomeFitRequirements,
  overflowTolerance: number
): WelcomeFitLevel => {
  const overflows = (requiredHeight: number): boolean =>
    requiredHeight - requirements.availableHeight > overflowTolerance

  let level: WelcomeFitLevel = WELCOME_FIT_FULL
  if (requirements.hasNotification && overflows(requirements.fullHeight)) {
    level = WELCOME_FIT_NOTIFICATION_HIDDEN
  }
  if (overflows(requirements.notificationHiddenHeight)) {
    level = WELCOME_FIT_DASHBOARD_HIDDEN
  }
  if (requirements.hasHeatmap && overflows(requirements.dashboardHiddenHeight)) {
    level = WELCOME_FIT_HEATMAP_HIDDEN
  }
  return level
}

/**
 * Resolve the welcome surface's progressive vertical-fit state.
 *
 * Visibility priority is heatmap > dashboard > notification, so shrinking the
 * pane hides those surfaces in the reverse order. Separate collapse/restore
 * thresholds keep a one-pixel resize around a boundary from flickering.
 */
export function resolveWelcomeFitLevel({
  currentLevel,
  collapseOverflow = 8,
  restoreSlack = 48,
  ...requirements
}: ResolveWelcomeFitLevelInput): WelcomeFitLevel {
  const collapseLevel = requiredLevelAtTolerance(requirements, collapseOverflow)
  if (collapseLevel > currentLevel) return collapseLevel

  const restoreLevel = requiredLevelAtTolerance(requirements, -restoreSlack)
  if (restoreLevel < currentLevel) {
    return (currentLevel - 1) as WelcomeFitLevel
  }

  return currentLevel
}
