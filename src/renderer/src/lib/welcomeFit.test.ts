import { describe, expect, it } from 'vitest'
import {
  WELCOME_FIT_DASHBOARD_HIDDEN,
  WELCOME_FIT_FULL,
  WELCOME_FIT_HEATMAP_HIDDEN,
  WELCOME_FIT_NOTIFICATION_HIDDEN,
  resolveWelcomeFullFitHeight,
  resolveWelcomeFitLevel,
  resolveWelcomeFitStackBounds
} from './welcomeFit'

const requirements = {
  availableHeight: 1000,
  fullHeight: 980,
  notificationHiddenHeight: 820,
  dashboardHiddenHeight: 520,
  hasNotification: true,
  hasHeatmap: true
}

describe('resolveWelcomeFitLevel', () => {
  it('preserves every optional welcome surface while the full layout fits', () => {
    expect(resolveWelcomeFitLevel({ ...requirements, currentLevel: WELCOME_FIT_FULL })).toBe(
      WELCOME_FIT_FULL
    )
  })

  it('hides the low-priority notification before the dashboard or heatmap', () => {
    expect(
      resolveWelcomeFitLevel({
        ...requirements,
        availableHeight: 940,
        currentLevel: WELCOME_FIT_FULL
      })
    ).toBe(WELCOME_FIT_NOTIFICATION_HIDDEN)
  })

  it('hides the dashboard next and keeps the heatmap until the tightest fit', () => {
    expect(
      resolveWelcomeFitLevel({
        ...requirements,
        availableHeight: 760,
        currentLevel: WELCOME_FIT_NOTIFICATION_HIDDEN
      })
    ).toBe(WELCOME_FIT_DASHBOARD_HIDDEN)

    expect(
      resolveWelcomeFitLevel({
        ...requirements,
        availableHeight: 460,
        currentLevel: WELCOME_FIT_DASHBOARD_HIDDEN
      })
    ).toBe(WELCOME_FIT_HEATMAP_HIDDEN)
  })

  it('skips notification-only fit state when there is no notification', () => {
    expect(
      resolveWelcomeFitLevel({
        ...requirements,
        availableHeight: 760,
        hasNotification: false,
        currentLevel: WELCOME_FIT_FULL
      })
    ).toBe(WELCOME_FIT_DASHBOARD_HIDDEN)
  })

  it('requires restore slack before revealing a lower-priority surface again', () => {
    expect(
      resolveWelcomeFitLevel({
        ...requirements,
        availableHeight: 1000,
        currentLevel: WELCOME_FIT_NOTIFICATION_HIDDEN
      })
    ).toBe(WELCOME_FIT_NOTIFICATION_HIDDEN)

    expect(
      resolveWelcomeFitLevel({
        ...requirements,
        availableHeight: 1040,
        currentLevel: WELCOME_FIT_NOTIFICATION_HIDDEN
      })
    ).toBe(WELCOME_FIT_FULL)
  })

  it('restores one tier at a time so the newly visible layout can be remeasured', () => {
    expect(
      resolveWelcomeFitLevel({
        ...requirements,
        availableHeight: 2000,
        currentLevel: WELCOME_FIT_HEATMAP_HIDDEN
      })
    ).toBe(WELCOME_FIT_DASHBOARD_HIDDEN)
  })
})

describe('resolveWelcomeFullFitHeight', () => {
  it('does not let a floating notice below the flow mask a dashboard overflow', () => {
    const fullHeight = resolveWelcomeFullFitHeight(728, 620)

    expect(fullHeight).toBe(728)
    expect(
      resolveWelcomeFitLevel({
        currentLevel: WELCOME_FIT_FULL,
        availableHeight: 640,
        fullHeight,
        notificationHiddenHeight: 736,
        dashboardHiddenHeight: 300,
        hasNotification: true,
        hasHeatmap: true
      })
    ).toBe(WELCOME_FIT_DASHBOARD_HIDDEN)
  })

  it('includes a floating notice when it needs more height than the flowed content', () => {
    expect(resolveWelcomeFullFitHeight(728, 764)).toBe(764)
  })
})

describe('resolveWelcomeFitStackBounds', () => {
  it('keeps a wrapper’s own bounds when it generates a layout box', () => {
    const bounds = { top: 100, bottom: 240, height: 140 }

    expect(resolveWelcomeFitStackBounds(bounds, [{ top: 120, bottom: 200, height: 80 }])).toBe(
      bounds
    )
  })

  it('unions direct child boxes when display contents leaves the wrapper boxless', () => {
    expect(
      resolveWelcomeFitStackBounds({ top: 0, bottom: 0, height: 0 }, [
        { top: 538, bottom: 570, height: 32 },
        { top: 618, bottom: 670, height: 52 }
      ])
    ).toEqual({ top: 538, bottom: 670, height: 132 })
  })

  it('returns no bounds when neither the wrapper nor its children render', () => {
    expect(resolveWelcomeFitStackBounds({ top: 0, bottom: 0, height: 0 }, [])).toBeNull()
  })
})
