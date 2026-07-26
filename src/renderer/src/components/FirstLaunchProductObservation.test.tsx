import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  FirstLaunchProductObservation,
  readProductObservationChoice,
  saveProductObservationChoice,
  type ProductObservationSettingsApi
} from './FirstLaunchProductObservation'

function settingsApi(enabled: boolean): ProductObservationSettingsApi {
  return {
    getSettings: vi.fn().mockResolvedValue({ activityReportingEnabled: enabled }),
    updateSettings: vi.fn().mockResolvedValue(undefined)
  }
}

describe('FirstLaunchProductObservation', () => {
  it('presents equal Share and Don’t share choices with the complete privacy boundary', () => {
    const html = renderToStaticMarkup(<FirstLaunchProductObservation api={settingsApi(false)} />)

    expect(html).toContain('Product observation — choose now')
    expect(html).toContain('Share minimal activity')
    expect(html).toContain('Don&#x27;t share')
    expect(html).toContain('Off until you choose Share.')
    expect(html).toContain('provider or model choices')
    expect(html).toContain('stable installation ID')
    expect(html).toContain('IP address')
    expect(html).toContain('Settings → Safety &amp; Privacy')
    expect(html).toContain('PRIVACY.md')
  })

  it('reads only an explicit true value as enabled', async () => {
    await expect(readProductObservationChoice(settingsApi(true))).resolves.toBe(true)
    await expect(readProductObservationChoice(settingsApi(false))).resolves.toBe(false)
  })

  it('persists each first-launch choice immediately', async () => {
    const api = settingsApi(false)

    await expect(saveProductObservationChoice(api, true)).resolves.toBe(true)
    expect(api.updateSettings).toHaveBeenLastCalledWith({ activityReportingEnabled: true })

    await expect(saveProductObservationChoice(api, false)).resolves.toBe(false)
    expect(api.updateSettings).toHaveBeenLastCalledWith({ activityReportingEnabled: false })
  })
})
