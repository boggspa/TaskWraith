import { describe, expect, it } from 'vitest'

import {
  HOST_LEASE_REASON_KINDS,
  HOST_LIFECYCLE_ACTIONS,
  HOST_LIFECYCLE_ERROR_MAX_LENGTH,
  HOST_LIFECYCLE_REASONS,
  cloneHostLifecycleSnapshot,
  isHostLifecycleAction,
  isHostLifecycleActionResult,
  isHostLifecycleHostIdentity,
  isHostLifecycleInspectResult,
  isHostLifecycleLeaseProjection,
  isHostLifecycleSnapshot,
  isHostLifecycleStatusResult,
  type HostLifecycleHostIdentity,
  type HostLifecycleSnapshot
} from './hostLifecycle'
import type { HostStatusProjection } from './hostProtocol'

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

const HOST: HostLifecycleHostIdentity = {
  pid: 4242,
  hostId: 'host-install-1',
  startedAt: '2026-09-23T10:00:00.000Z',
  payloadVersion: `sha256:${'a'.repeat(64)}`
}

function status(overrides: Partial<HostStatusProjection> = {}): HostStatusProjection {
  return {
    pid: 4242,
    startedAt: '2026-09-23T10:00:00.000Z',
    uptimeMs: 1_000,
    hostId: 'host-install-1',
    profilePath: '/profiles/a',
    persist: false,
    lifetime: { phase: 'held', holders: 1, implicitHolders: 0, declined: 2 },
    liveWork: { runs: 0 },
    clients: [
      {
        clientClass: 'desktop',
        clientId: 'taskwraith-desktop-lease',
        connectedForMs: 900,
        lease: 'explicit',
        capabilities: ['bootstrap', 'health']
      }
    ],
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

  it('names the bounded restart policy in its reasons and adds restart to the actions', () => {
    for (const reason of ['user-restart', 'poison-restart', 'lease-reacquire'] as const) {
      expect(HOST_LIFECYCLE_REASONS).toContain(reason)
      expect(isHostLifecycleSnapshot(snapshot({ reason }))).toBe(true)
    }
    expect(HOST_LIFECYCLE_ACTIONS).toEqual(['start', 'stop', 'restart'])
    expect(isHostLifecycleAction('restart')).toBe(true)
    expect(isHostLifecycleAction('kill')).toBe(false)
    expect(isHostLifecycleAction(undefined)).toBe(false)
  })

  it('carries the Host identity block strictly and clones it detached', () => {
    const withHost = snapshot({ host: HOST })
    expect(isHostLifecycleSnapshot(withHost)).toBe(true)
    expect(
      isHostLifecycleSnapshot(snapshot({ host: { ...HOST, birthIdentity: 'f'.repeat(64) } }))
    ).toBe(true)
    expect(isHostLifecycleSnapshot(snapshot({ host: { ...HOST, pid: 0 } }))).toBe(false)
    expect(isHostLifecycleSnapshot(snapshot({ host: { ...HOST, hostId: '' } }))).toBe(false)
    expect(isHostLifecycleSnapshot(snapshot({ host: { ...HOST, startedAt: 'soon' } }))).toBe(false)
    expect(
      isHostLifecycleSnapshot(snapshot({ host: { ...HOST, payloadVersion: 'md5:abc' } }))
    ).toBe(false)
    expect(
      isHostLifecycleSnapshot(snapshot({ host: { ...HOST, birthIdentity: 'Tue Sep 22 14:43:18' } }))
    ).toBe(false)
    // An unknown key (a token, a path, anything unplanned) never crosses IPC.
    expect(
      isHostLifecycleHostIdentity({ ...HOST, tokenPath: '/profiles/a/taskwraith-host-v2.token' })
    ).toBe(false)

    const copy = cloneHostLifecycleSnapshot(withHost)
    expect(copy).toEqual(withHost)
    expect(copy.host).not.toBe(withHost.host)
    // Absent stays absent: the pre-S2 wire shape is unchanged.
    expect('host' in cloneHostLifecycleSnapshot(snapshot())).toBe(false)
  })

  it('validates the inspect envelope with the protocol status decoder', () => {
    const lease = { mode: 'lease' as const, held: true, reasons: ['app' as const] }
    expect(
      isHostLifecycleInspectResult({ ok: true, snapshot: snapshot(), host: status(), lease })
    ).toBe(true)
    expect(
      isHostLifecycleInspectResult({ ok: true, snapshot: snapshot(), host: null, lease: null })
    ).toBe(true)
    expect(isHostLifecycleInspectResult({ ok: false, error: 'main window only' })).toBe(true)
    // Both keys are required, as null when unknown.
    expect(isHostLifecycleInspectResult({ ok: true, snapshot: snapshot(), lease })).toBe(false)
    expect(isHostLifecycleInspectResult({ ok: true, snapshot: snapshot(), host: null })).toBe(false)
    expect(
      isHostLifecycleInspectResult({
        ok: true,
        snapshot: snapshot(),
        host: { ...status(), pid: 0 },
        lease
      })
    ).toBe(false)
    expect(
      isHostLifecycleInspectResult({
        ok: true,
        snapshot: { ...snapshot(), reason: 'daemonized' },
        host: null,
        lease: null
      })
    ).toBe(false)
  })

  it('bounds the lease projection to known reason kinds, never device keys', () => {
    expect(HOST_LEASE_REASON_KINDS).toEqual(['app', 'window', 'work', 'pin'])
    expect(isHostLifecycleLeaseProjection({ mode: 'legacy', held: false, reasons: [] })).toBe(true)
    expect(isHostLifecycleLeaseProjection({ mode: 'lease', held: true, reasons: ['pin'] })).toBe(
      true
    )
    expect(
      isHostLifecycleLeaseProjection({ mode: 'lease', held: true, reasons: ['pin:device-key-1'] })
    ).toBe(false)
    expect(isHostLifecycleLeaseProjection({ mode: 'daemon', held: true, reasons: [] })).toBe(false)
    expect(isHostLifecycleLeaseProjection({ mode: 'lease', held: 'yes', reasons: [] })).toBe(false)
  })
})
