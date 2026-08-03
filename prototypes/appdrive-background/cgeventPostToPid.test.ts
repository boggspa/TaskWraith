import { describe, expect, it } from 'vitest'
import { attemptCgEventPostToPid, refuseGlobalCgEventPost } from './cgeventPostToPid'
import { DEFAULT_FIXTURE_TARGET } from './fixtureTarget'

describe('cgeventPostToPid prototype', () => {
  it('dry-run never posts', () => {
    const out = attemptCgEventPostToPid({
      target: DEFAULT_FIXTURE_TARGET,
      event: { type: 'key', keyCode: 0, down: true }
    })
    expect(out.ok).toBe(true)
    expect(out.posted).toBe(false)
    expect(out.dryRun).toBe(true)
  })

  it('refuses global post helper', () => {
    const out = refuseGlobalCgEventPost()
    expect(out.ok).toBe(false)
    expect(out.posted).toBe(false)
  })

  it('live path refuses missing native impl without silent fallback to foreground', () => {
    const out = attemptCgEventPostToPid({
      target: { ...DEFAULT_FIXTURE_TARGET, pid: 99901 },
      event: { type: 'mouse', x: 0, y: 0, button: 'left', phase: 'down' },
      mode: 'live_post',
      explicitUserInvocation: true,
      envAllowPost: true
    })
    expect(out.posted).toBe(false)
    expect(out.ok).toBe(false)
    expect(out.policy.allow).toBe(false)
    if (!out.policy.allow) {
      expect(out.policy.refused).toBe('silent_foreground_fallback')
    }
  })
})
