import { describe, expect, it } from 'vitest'

import {
  buildProviderManualSetupFlow,
  providerManualSetupNotice
} from './ProviderManualSetupFlowCatalog'

describe('ProviderManualSetupFlowCatalog', () => {
  it('projects only bounded user-owned flows without commands, urls, device codes, or credentials', () => {
    const flow = buildProviderManualSetupFlow('kimi', 'login')
    expect(flow).toEqual(
      expect.objectContaining({
        provider: 'kimi',
        action: 'login',
        scope: 'user-owned-provider-setup',
        managedRunReady: false
      })
    )
    expect(Object.keys(flow || {})).toEqual([
      'provider',
      'action',
      'scope',
      'managedRunReady',
      'notice'
    ])
    expect(JSON.stringify(flow)).not.toMatch(/https?:|device.?code|credential|token/i)
  })

  it('includes only currently supported manual flows and retains safe notices for unsupported actions', () => {
    expect(buildProviderManualSetupFlow('kimi', 'logout')).toBeNull()
    expect(buildProviderManualSetupFlow('mistral', 'logout')).toBeNull()
    expect(buildProviderManualSetupFlow('muse', 'upgrade')).toMatchObject({
      managedRunReady: false
    })
    expect(providerManualSetupNotice('kimi')).toContain('user-owned Kimi setup')
    expect(providerManualSetupNotice('codex')).toBeNull()
  })
})
