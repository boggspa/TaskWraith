import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'
import { fingerprintUpdateSnapshot, shouldApplyUpdateSnapshot } from './updateStatusRefresh'

function snapshot(overrides: Partial<UpdateStateSnapshot> = {}): UpdateStateSnapshot {
  return {
    status: 'not-available',
    enabled: true,
    channel: 'stable',
    ...overrides
  }
}

describe('fingerprintUpdateSnapshot', () => {
  it('ignores lastCheckedAt so a quiet poll matches the previous snapshot', () => {
    const prev = snapshot({ lastCheckedAt: '2026-09-01T12:00:00.000Z' })
    const polled = snapshot({ lastCheckedAt: '2026-09-01T12:15:00.000Z' })

    expect(fingerprintUpdateSnapshot(prev)).toBe(fingerprintUpdateSnapshot(polled))
    expect(shouldApplyUpdateSnapshot(prev, polled)).toBe(false)
  })

  it('detects a newly available update even when lastCheckedAt also moves', () => {
    const prev = snapshot({ lastCheckedAt: '2026-09-01T12:00:00.000Z' })
    const found = snapshot({
      status: 'available',
      latestVersion: '1.9.8',
      lastCheckedAt: '2026-09-01T12:15:00.000Z'
    })

    expect(shouldApplyUpdateSnapshot(prev, found)).toBe(true)
  })
})

describe('shouldApplyUpdateSnapshot', () => {
  it('does not apply a transient checking snapshot from a background poll', () => {
    const prev = snapshot({ lastCheckedAt: '2026-09-01T12:00:00.000Z' })
    const checking = snapshot({
      status: 'checking',
      lastCheckedAt: '2026-09-01T12:15:00.000Z'
    })

    expect(shouldApplyUpdateSnapshot(prev, checking)).toBe(false)
  })

  it('applies the first snapshot and a first idle → not-available result', () => {
    expect(shouldApplyUpdateSnapshot(null, snapshot({ status: 'idle' }))).toBe(true)
    expect(
      shouldApplyUpdateSnapshot(snapshot({ status: 'idle' }), snapshot({ status: 'not-available' }))
    ).toBe(true)
  })

  it('applies error, download progress, restart-pending, and identity-handoff changes', () => {
    const prev = snapshot()
    expect(
      shouldApplyUpdateSnapshot(
        prev,
        snapshot({ status: 'error', errorMessage: 'feed unavailable' })
      )
    ).toBe(true)
    expect(
      shouldApplyUpdateSnapshot(
        snapshot({ status: 'downloading', downloadProgress: percent(10) }),
        snapshot({ status: 'downloading', downloadProgress: percent(40) })
      )
    ).toBe(true)
    expect(
      shouldApplyUpdateSnapshot(
        snapshot({ status: 'downloaded', latestVersion: '1.9.8' }),
        snapshot({ status: 'downloaded', latestVersion: '1.9.8', restartPending: true })
      )
    ).toBe(true)
    expect(
      shouldApplyUpdateSnapshot(prev, snapshot({ identityHandoff: { phase: 'ready' } as never }))
    ).toBe(true)
  })

  it('lets an explicit user action publish lastCheckedAt even when status is unchanged', () => {
    const prev = snapshot({ lastCheckedAt: '2026-09-01T12:00:00.000Z' })
    const checked = snapshot({ lastCheckedAt: '2026-09-01T12:15:00.000Z' })

    expect(shouldApplyUpdateSnapshot(prev, checked, { force: true })).toBe(true)
  })

  it('lets an explicit user action surface the in-flight checking status', () => {
    const prev = snapshot()
    expect(shouldApplyUpdateSnapshot(prev, snapshot({ status: 'checking' }), { force: true })).toBe(
      true
    )
  })
})

describe('useUpdateStatus wiring', () => {
  it('applies the fingerprint guard before setState so a quiet poll cannot invalidate App', () => {
    const hookSource = readFileSync(new URL('../hooks/useUpdateStatus.ts', import.meta.url), 'utf8')

    expect(hookSource).toContain('shouldApplyUpdateSnapshot')
    expect(hookSource).not.toMatch(/onUpdateStatusChanged\(\(next\) => setSnapshot\(next\)\)/)
  })
})

function percent(value: number): NonNullable<UpdateStateSnapshot['downloadProgress']> {
  return {
    percent: value,
    bytesPerSecond: 0,
    delta: 0,
    transferred: value,
    total: 100
  }
}
