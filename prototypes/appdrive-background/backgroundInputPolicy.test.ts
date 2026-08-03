import { describe, expect, it } from 'vitest'
import {
  evaluateBackgroundInputPolicy,
  refuseSilentForegroundFallback
} from './backgroundInputPolicy'
import { DEFAULT_FIXTURE_TARGET } from './fixtureTarget'

describe('backgroundInputPolicy', () => {
  it('defaults dry-run for harness fixture', () => {
    const d = evaluateBackgroundInputPolicy({
      target: DEFAULT_FIXTURE_TARGET,
      operation: 'cgevent_post_to_pid'
    })
    expect(d.allow).toBe(true)
    if (d.allow) {
      expect(d.dryRun).toBe(true)
      expect(d.actuation).toBe('dry_run_cgevent_post_to_pid')
    }
  })

  it('refuses global CGEventPost', () => {
    const d = evaluateBackgroundInputPolicy({
      target: { ...DEFAULT_FIXTURE_TARGET, pid: 99 },
      mode: 'live_post',
      explicitUserInvocation: true,
      envAllowPost: true,
      operation: 'global_cgevent_post'
    })
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.refused).toBe('global_cgevent_post')
  })

  it('refuses cursor warp, clipboard, activate, permission prompt', () => {
    for (const op of [
      'cursor_warp',
      'clipboard_write',
      'activate_or_raise',
      'permission_prompt',
      'silent_foreground_fallback'
    ]) {
      const d = evaluateBackgroundInputPolicy({
        target: DEFAULT_FIXTURE_TARGET,
        operation: op
      })
      expect(d.allow).toBe(false)
    }
  })

  it('refuses live post without triple gate', () => {
    const base = {
      target: { ...DEFAULT_FIXTURE_TARGET, pid: 4242 },
      mode: 'live_post' as const,
      operation: 'cgevent_post_to_pid'
    }
    expect(evaluateBackgroundInputPolicy(base).allow).toBe(false)
    expect(
      evaluateBackgroundInputPolicy({ ...base, explicitUserInvocation: true }).allow
    ).toBe(false)
    expect(
      evaluateBackgroundInputPolicy({
        ...base,
        explicitUserInvocation: true,
        envAllowPost: true
      }).allow
    ).toBe(true)
  })

  it('refuses non-fixture targets', () => {
    const d = evaluateBackgroundInputPolicy({
      target: {
        kind: 'harness_fixture',
        appId: 'com.apple.Safari',
        appLabel: 'Safari',
        pid: 1,
        ownedByHarness: false as unknown as true
      },
      operation: 'cgevent_post_to_pid'
    })
    // ownedByHarness false fails isHarnessOwnedFixture
    expect(d.allow).toBe(false)
  })

  it('refuseSilentForegroundFallback never allows', () => {
    const d = refuseSilentForegroundFallback('test')
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.refused).toBe('silent_foreground_fallback')
  })
})
