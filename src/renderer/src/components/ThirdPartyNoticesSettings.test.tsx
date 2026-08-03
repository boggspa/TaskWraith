import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThirdPartyNoticesSettings } from './ThirdPartyNoticesSettings'

describe('ThirdPartyNoticesSettings', () => {
  it('describes exact package coverage and all three retained notice surfaces', () => {
    const html = renderToStaticMarkup(
      <ThirdPartyNoticesSettings
        api={{
          getStatus: async () => ({
            exactPackagedTree: false,
            appVersion: null,
            appLicense: null,
            summary: null,
            available: { taskwraith: false, 'third-party': false, chromium: false },
            message: null
          }),
          open: async () => ({ ok: true })
        }}
      />
    )

    expect(html).toContain('Licenses &amp; Attribution')
    expect(html).toContain('exact dependency tree staged in the application')
    expect(html).toContain('Open app license')
    expect(html).toContain('Open third-party notices')
    expect(html).toContain('Open Chromium notices')
  })
})
