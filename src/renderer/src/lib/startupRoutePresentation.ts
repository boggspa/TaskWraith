export interface StartupRoutePresentationInput {
  appearanceLoaded: boolean
  initialRouteReady: boolean
  hasCommittedRoute: boolean
  allowEmptyRoute: boolean
}

/**
 * Decide when the renderer may reveal the app beneath the boot mask.
 *
 * A successful route load is not presentable until React has committed the
 * selected chat. Startup failures may explicitly allow the empty shell so a
 * missing route can never trap the user behind a permanent mask.
 */
export function shouldRevealStartupRoute(input: StartupRoutePresentationInput): boolean {
  return (
    input.appearanceLoaded &&
    input.initialRouteReady &&
    (input.hasCommittedRoute || input.allowEmptyRoute)
  )
}
