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
