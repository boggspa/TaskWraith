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
})
