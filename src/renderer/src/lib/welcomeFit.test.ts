import { describe, expect, it } from 'vitest'
import {
  WELCOME_FIT_DASHBOARD_HIDDEN,
  WELCOME_FIT_FULL,
  WELCOME_FIT_HEATMAP_HIDDEN,
  WELCOME_FIT_NOTIFICATION_HIDDEN,
  resolveWelcomeFitLevel
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
