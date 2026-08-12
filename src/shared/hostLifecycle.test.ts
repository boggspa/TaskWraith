import { describe, expect, it } from 'vitest'

import {
  HOST_LIFECYCLE_ERROR_MAX_LENGTH,
  cloneHostLifecycleSnapshot,
  isHostLifecycleActionResult,
  isHostLifecycleSnapshot,
  isHostLifecycleStatusResult,
  type HostLifecycleSnapshot
} from './hostLifecycle'

function snapshot(overrides: Partial<HostLifecycleSnapshot> = {}): HostLifecycleSnapshot {
  return {
    revision: 3,
    phase: 'running',
    desired: 'running',
    reason: 'user-start',
    changedAt: '2026-08-12T12:00:00.000Z',
    ...overrides
  }
}

describe('hostLifecycle wire contract', () => {
  it('accepts every bounded lifecycle phase used by the controller', () => {
    for (const phase of ['starting', 'running', 'stopping', 'stopped', 'failed'] as const) {
      expect(isHostLifecycleSnapshot(snapshot({ phase }))).toBe(true)
    }
  })

  it('rejects malformed revisions, timestamps, enums and unbounded errors', () => {
    expect(isHostLifecycleSnapshot(snapshot({ revision: -1 }))).toBe(false)
    expect(isHostLifecycleSnapshot(snapshot({ changedAt: 'not-a-time' }))).toBe(false)
    expect(isHostLifecycleSnapshot({ ...snapshot(), phase: 'daemonized' })).toBe(false)
    expect(
      isHostLifecycleSnapshot(
        snapshot({ phase: 'failed', error: 'x'.repeat(HOST_LIFECYCLE_ERROR_MAX_LENGTH + 1) })
      )
    ).toBe(false)
  })

  it('validates status and action result envelopes without requiring a denied snapshot', () => {
    expect(isHostLifecycleStatusResult({ ok: true, snapshot: snapshot() })).toBe(true)
    expect(isHostLifecycleStatusResult({ ok: false, error: 'main window only' })).toBe(true)
    expect(isHostLifecycleActionResult({ ok: false, error: 'main window only' })).toBe(true)
    expect(
      isHostLifecycleActionResult({
        ok: false,
        error: 'x'.repeat(HOST_LIFECYCLE_ERROR_MAX_LENGTH + 1)
      })
    ).toBe(false)
    expect(
      isHostLifecycleActionResult({
        ok: false,
        error: 'start failed',
        snapshot: snapshot({ phase: 'failed', reason: 'start-failed', error: 'start failed' })
      })
    ).toBe(true)
    expect(isHostLifecycleActionResult({ ok: true })).toBe(false)
  })

  it('returns a detached copy for renderer and IPC consumers', () => {
    const source = snapshot()
    const copy = cloneHostLifecycleSnapshot(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
  })
})
