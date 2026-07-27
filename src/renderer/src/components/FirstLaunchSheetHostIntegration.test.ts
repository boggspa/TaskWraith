import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

describe('FirstLaunchSheet host integration', () => {
  it('uses the authoritative host offer snapshot for conditional AntiGravity reporting', () => {
    const mount = appSource.slice(
      appSource.indexOf('<FirstLaunchSheet'),
      appSource.indexOf('{/* BugReportSheet', appSource.indexOf('<FirstLaunchSheet'))
    )

    expect(mount).toContain(
      "antigravityProviderOffered={configuredProviderSnapshot.providerIds.includes(\n          'antigravity'\n        )}"
    )
    expect(mount).not.toContain('antigravityConsentGranted=')
    expect(mount).not.toContain('antigravityCredentialConfigured=')
  })

  it('passes Mistral Vibe runtime discovery into the onboarding card', () => {
    const mount = appSource.slice(
      appSource.indexOf('<FirstLaunchSheet'),
      appSource.indexOf('{/* BugReportSheet', appSource.indexOf('<FirstLaunchSheet'))
    )

    expect(mount).toContain('mistralStatus={agentStatusByProvider.mistral}')
    expect(mount).toContain('void handleProviderLogin(provider)')
  })

  it('refreshes every live provider discovery snapshot at app launch', () => {
    const start = appSource.indexOf('void refreshProviderMetadata(initialProvider)')
    const end = appSource.indexOf('// 1.0.6-G3d', start)
    const launchDiscovery = appSource.slice(start, end)

    expect(launchDiscovery).toContain('LIVE_SELECTABLE_PROVIDER_IDS')
    expect(launchDiscovery).toContain('void refreshProviderMetadata(provider)')
    expect(launchDiscovery).not.toContain('void refreshProviderModelCatalog(provider)')
  })
})
