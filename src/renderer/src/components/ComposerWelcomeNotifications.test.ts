import { describe, expect, it } from 'vitest'
import { shouldRenderWelcomeNotifications } from './Composer'

describe('shouldRenderWelcomeNotifications', () => {
  it('keeps app-global welcome notices on the focused welcome composer only', () => {
    expect(shouldRenderWelcomeNotifications(true)).toBe(true)
    expect(shouldRenderWelcomeNotifications(true, false)).toBe(false)
    expect(shouldRenderWelcomeNotifications(false, true)).toBe(false)
  })
})
