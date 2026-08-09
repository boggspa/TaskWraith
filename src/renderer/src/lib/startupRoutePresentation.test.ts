import { describe, expect, it } from 'vitest'

import { shouldRevealStartupRoute } from './startupRoutePresentation'

describe('shouldRevealStartupRoute', () => {
  it('keeps the mask up until appearance and initial loading have settled', () => {
    expect(
      shouldRevealStartupRoute({
        appearanceLoaded: false,
        initialRouteReady: true,
        hasCommittedRoute: true,
        allowEmptyRoute: false
      })
    ).toBe(false)
    expect(
      shouldRevealStartupRoute({
        appearanceLoaded: true,
        initialRouteReady: false,
        hasCommittedRoute: true,
        allowEmptyRoute: false
      })
    ).toBe(false)
  })

  it('does not reveal a selected route before currentChat has committed', () => {
    expect(
      shouldRevealStartupRoute({
        appearanceLoaded: true,
        initialRouteReady: true,
        hasCommittedRoute: false,
        allowEmptyRoute: false
      })
    ).toBe(false)
  })

  it('reveals a committed route', () => {
    expect(
      shouldRevealStartupRoute({
        appearanceLoaded: true,
        initialRouteReady: true,
        hasCommittedRoute: true,
        allowEmptyRoute: false
      })
    ).toBe(true)
  })

  it('allows an explicitly settled empty route so startup errors cannot trap the mask', () => {
    expect(
      shouldRevealStartupRoute({
        appearanceLoaded: true,
        initialRouteReady: true,
        hasCommittedRoute: false,
        allowEmptyRoute: true
      })
    ).toBe(true)
  })

  it('stays revealed when the selected chat is deleted after startup', () => {
    expect(
      shouldRevealStartupRoute({
        appearanceLoaded: true,
        initialRouteReady: true,
        hasCommittedRoute: false,
        allowEmptyRoute: false,
        routeWasRevealed: true
      })
    ).toBe(true)
  })
})
