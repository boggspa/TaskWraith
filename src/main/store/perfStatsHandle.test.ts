/**
 * T9a — containment tests for the harness-gated perf sampling handle.
 *
 * The security property that matters is NEGATIVE: with the harness flag unset
 * — every production build and every normal launch — nothing is installed and
 * the global does not exist. A test that only proved the happy path would let
 * a future refactor make the handle unconditional without anything going red.
 */

import { describe, expect, it } from 'vitest'
import {
  PERF_STATS_GLOBAL,
  installPerfStatsHandle,
  isPerfStatsHandleEnabled,
  uninstallPerfStatsHandle
} from './perfStatsHandle'

const payload = () => ({ sampledAt: 1, coalescing: { a: 1 }, probes: { b: 2 } })

describe('perf stats handle gating', () => {
  it('installs NOTHING when the harness flag is unset (production default)', () => {
    const target: Record<string, unknown> = {}
    const installed = installPerfStatsHandle(payload, { env: {}, target })

    expect(installed).toBe(false)
    expect(PERF_STATS_GLOBAL in target).toBe(false)
    expect(Object.keys(target)).toEqual([])
  })

  it('installs nothing for a non-affirmative flag value', () => {
    for (const value of ['0', 'false', '', 'yes', 'PERF']) {
      const target: Record<string, unknown> = {}
      expect(installPerfStatsHandle(payload, { env: { PERF_PRELOAD_PROBE: value }, target })).toBe(
        false
      )
      expect(PERF_STATS_GLOBAL in target).toBe(false)
    }
  })

  it('installs a read-only function when the harness flag is set', () => {
    const target: Record<string, unknown> = {}
    const installed = installPerfStatsHandle(payload, {
      env: { PERF_PRELOAD_PROBE: '1' },
      target
    })

    expect(installed).toBe(true)
    expect(typeof target[PERF_STATS_GLOBAL]).toBe('function')
    expect((target[PERF_STATS_GLOBAL] as () => unknown)()).toEqual(payload())
  })

  it('accepts the "true" spelling as well as "1"', () => {
    const target: Record<string, unknown> = {}
    expect(installPerfStatsHandle(payload, { env: { PERF_PRELOAD_PROBE: 'true' }, target })).toBe(
      true
    )
  })

  it('returns a FRESH snapshot per call so a sampler cannot retain store internals', () => {
    const target: Record<string, unknown> = {}
    let counter = 0
    installPerfStatsHandle(() => ({ sampledAt: ++counter, coalescing: {}, probes: {} }), {
      env: { PERF_PRELOAD_PROBE: '1' },
      target
    })
    const read = target[PERF_STATS_GLOBAL] as () => { sampledAt: number }

    const first = read()
    const second = read()
    expect(first.sampledAt).toBe(1)
    expect(second.sampledAt).toBe(2)
    expect(first).not.toBe(second)
  })

  it('is idempotent — reinstalling replaces rather than stacking a stale closure', () => {
    const target: Record<string, unknown> = {}
    const env = { PERF_PRELOAD_PROBE: '1' }
    installPerfStatsHandle(() => ({ sampledAt: 1, coalescing: 'old', probes: {} }), { env, target })
    installPerfStatsHandle(() => ({ sampledAt: 2, coalescing: 'new', probes: {} }), { env, target })

    const read = target[PERF_STATS_GLOBAL] as () => { coalescing: string }
    expect(read().coalescing).toBe('new')
    expect(Object.keys(target)).toHaveLength(1)
  })

  it('can be revoked', () => {
    const target: Record<string, unknown> = {}
    installPerfStatsHandle(payload, { env: { PERF_PRELOAD_PROBE: '1' }, target })
    expect(PERF_STATS_GLOBAL in target).toBe(true)

    uninstallPerfStatsHandle({ target })
    expect(PERF_STATS_GLOBAL in target).toBe(false)
  })

  it('reports the gate state directly', () => {
    expect(isPerfStatsHandleEnabled({})).toBe(false)
    expect(isPerfStatsHandleEnabled({ PERF_PRELOAD_PROBE: '1' })).toBe(true)
    expect(isPerfStatsHandleEnabled({ PERF_PRELOAD_PROBE: '0' })).toBe(false)
  })
})
