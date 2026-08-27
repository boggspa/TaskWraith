import { describe, expect, it } from 'vitest'

import { isDesktopExternalHostEnabled } from './DesktopExternalHostPolicy'

describe('DesktopExternalHostPolicy', () => {
  it('uses the external Host by default and treats only 0 as the opt-out', () => {
    expect(isDesktopExternalHostEnabled({})).toBe(true)
    expect(isDesktopExternalHostEnabled({ TASKWRAITH_DESKTOP_EXTERNAL_HOST: undefined })).toBe(true)
    expect(isDesktopExternalHostEnabled({ TASKWRAITH_DESKTOP_EXTERNAL_HOST: '1' })).toBe(true)
    expect(isDesktopExternalHostEnabled({ TASKWRAITH_DESKTOP_EXTERNAL_HOST: 'true' })).toBe(true)
    expect(isDesktopExternalHostEnabled({ TASKWRAITH_DESKTOP_EXTERNAL_HOST: '0' })).toBe(false)
  })
})
