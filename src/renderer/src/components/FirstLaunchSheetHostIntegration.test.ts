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
      "antigravityProviderOffered={configuredProviderSnapshot.providerIds.includes('antigravity')}"
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

  it('warms the cached Pi catalogue once and defers heavyweight provider discovery', () => {
    const start = appSource.indexOf('void refreshProviderMetadata(initialProvider)')
    const end = appSource.indexOf('// 1.0.6-G3d', start)
    const launchDiscovery = appSource.slice(start, end)
    const warmupStart = appSource.indexOf('const armProviderMetadataWarmup')
    const warmupEnd = appSource.indexOf('const markInitialRouteSettled', warmupStart)
    const warmup = appSource.slice(warmupStart, warmupEnd)

    expect(launchDiscovery).not.toContain('for (const provider of LIVE_SELECTABLE_PROVIDER_IDS')
    expect(launchDiscovery).toContain("refreshProviderModelCatalog('pi')")
    expect(warmup).toContain('scheduleProviderMetadataWarmup')
    expect(warmup).toContain('provider !== activeProvider')
    expect(warmup).toContain("provider !== 'pi'")
    expect(warmup).toContain('refresh: (provider) => refreshProviderMetadata(provider)')
    const arm = appSource.indexOf('armProviderMetadataWarmup(initialProvider)')
    expect(arm).toBeLessThan(appSource.indexOf('markInitialRouteSettled()', arm))
  })
})
