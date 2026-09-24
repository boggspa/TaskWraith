import { describe, expect, it } from 'vitest'

import { hostNodeProviderEnvironment } from './HostNodeProviderEnvironment'

describe('hostNodeProviderEnvironment', () => {
  it('strips Host elevation/auth material without removing provider credentials or lock identity', () => {
    const env = hostNodeProviderEnvironment(
      {
        OPENAI_API_KEY: 'provider-secret',
        TASKWRAITH_LOCK_OWNER_ID: 'run-owner',
        TASKWRAITH_FULL_ACCESS_BOOTSTRAP_SECRET: 'must-not-leak',
        TASKWRAITH_PERMISSION_CONSENT_SECRET: 'must-not-leak',
        TASKWRAITH_HOST_TOKEN: 'must-not-leak',
        TASKWRAITH_HOST_SESSION_TOKEN: 'must-not-leak',
        TASKWRAITH_LOCAL_TRANSPORT_TOKEN: 'must-not-leak'
      },
      {
        FORCE_COLOR: '0',
        TASKWRAITH_FULL_ACCESS_PROOF: 'must-not-reenter'
      }
    )

    expect(env).toMatchObject({
      OPENAI_API_KEY: 'provider-secret',
      TASKWRAITH_LOCK_OWNER_ID: 'run-owner',
      FORCE_COLOR: '0'
    })
    expect(JSON.stringify(env)).not.toContain('must-not-leak')
    expect(JSON.stringify(env)).not.toContain('must-not-reenter')
  })
})
