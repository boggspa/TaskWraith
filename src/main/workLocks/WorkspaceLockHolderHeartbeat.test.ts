import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  decodeWorkspaceLockHolderHeartbeat,
  encodeWorkspaceLockHolderHeartbeat,
  WORKSPACE_LOCK_HEARTBEAT_SCHEMA,
  WorkspaceLockHolderLapseTracker,
  workspaceLockHolderHeartbeatFilename,
  workspaceLockHolderKey,
  type WorkspaceLockHolderHeartbeat
} from './WorkspaceLockHolderHeartbeat'

const holder = { instanceId: 'tw-instance-abc123', pid: 4242, processBirthIdentity: 'birth-4242' }

function beat(overrides: Partial<WorkspaceLockHolderHeartbeat> = {}): WorkspaceLockHolderHeartbeat {
  return {
    schema: WORKSPACE_LOCK_HEARTBEAT_SCHEMA,
    ...holder,
    generation: 7,
    beatSeq: 1,
    monotonicMs: 1_000,
    beatAt: '2026-09-23T10:00:00.000Z',
    ...overrides
  }
}

function tracker(
  monotonic: { now: number },
  timings = { ttlMs: 90_000, graceMs: 180_000, suspendGapMs: 10 * 60_000 }
) {
  return new WorkspaceLockHolderLapseTracker(timings, () => monotonic.now)
}

function wallPlus(base: string, ms: number): string {
  return new Date(Date.parse(base) + ms).toISOString()
}

describe('WorkspaceLockHolderHeartbeat', () => {
  it('names the sidecar <instanceId>.<pid>.<birth16>.json and hashes an unsafe instance id', () => {
    const birth16 = createHash('sha256').update('birth-4242', 'utf8').digest('hex').slice(0, 16)
    expect(workspaceLockHolderHeartbeatFilename(holder)).toBe(
      `tw-instance-abc123.4242.${birth16}.json`
    )
    const unsafe = workspaceLockHolderHeartbeatFilename({ ...holder, instanceId: 'a/b c' })
    expect(unsafe).toMatch(/^h-[0-9a-f]{32}\.4242\.[0-9a-f]{16}\.json$/)
    expect(unsafe).not.toContain('/')
    expect(workspaceLockHolderKey(holder)).toBe(workspaceLockHolderKey(beat({ beatSeq: 99 })))
  })

  it('round-trips a record as one JSONL line and rejects every deviation fail-closed', () => {
    const line = encodeWorkspaceLockHolderHeartbeat(beat())
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual(beat())
    expect(Object.keys(JSON.parse(line))).toEqual([
      'schema',
      'instanceId',
      'generation',
      'pid',
      'processBirthIdentity',
      'beatSeq',
      'monotonicMs',
      'beatAt'
    ])
    expect(decodeWorkspaceLockHolderHeartbeat(line)).toEqual(beat())

    const rejects = (record: unknown, pattern: RegExp): void => {
      expect(() => decodeWorkspaceLockHolderHeartbeat(JSON.stringify(record))).toThrow(pattern)
    }
    rejects({ ...beat(), extra: 1 }, /unexpected key set/)
    rejects({ ...beat(), beatAt: undefined }, /unexpected key set/)
    rejects({ ...beat(), schema: 'taskwraith.workspace-lock.heartbeat.v2' }, /schema is unknown/)
    rejects({ ...beat(), beatSeq: 0 }, /beat sequence/)
    rejects({ ...beat(), pid: 0 }, /pid/)
    rejects({ ...beat(), monotonicMs: Number.NaN }, /monotonic clock/)
    rejects({ ...beat(), beatAt: '2026-09-23T10:00:00Z' }, /canonical ISO/)
    rejects({ ...beat(), instanceId: '' }, /instance id/)
    expect(() => decodeWorkspaceLockHolderHeartbeat('{')).toThrow(/not valid JSON/)
    expect(() => decodeWorkspaceLockHolderHeartbeat('[]')).toThrow(/must be an object/)
  })

  it('reports absent, fresh, stale, and lapsed against the reclaimer clocks only', () => {
    const monotonic = { now: 5_000 }
    const lapse = tracker(monotonic)
    const key = workspaceLockHolderKey(holder)
    const beatAt = '2026-09-23T10:00:00.000Z'

    expect(lapse.observe({ nowIso: beatAt, heartbeats: [], holders: [holder] }).get(key)).toEqual({
      state: 'absent'
    })
    expect(
      lapse
        .observe({
          nowIso: wallPlus(beatAt, 89_999),
          heartbeats: [beat({ beatAt })],
          holders: [holder]
        })
        .get(key)
    ).toMatchObject({ state: 'fresh', beatSeq: 1, ageMs: 89_999 })

    // Wall-stale by far more than TTL + grace, but the reclaimer has only just
    // noticed: the grace starts now on ITS monotonic clock.
    const wallLate = wallPlus(beatAt, 10 * 60_000)
    expect(
      lapse
        .observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
        .get(key)
    ).toMatchObject({ state: 'stale', beatSeq: 1, ageMs: 600_000, graceObservedMs: 0 })
    monotonic.now += 179_999
    expect(
      lapse
        .observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
        .get(key)
    ).toMatchObject({ state: 'stale', graceObservedMs: 179_999 })
    monotonic.now += 1
    expect(
      lapse
        .observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
        .get(key)
    ).toMatchObject({ state: 'lapsed', graceObservedMs: 180_000 })
  })

  it('restarts the grace when beatSeq advances and forgets holders it no longer sees', () => {
    const monotonic = { now: 0 }
    const lapse = tracker(monotonic)
    const key = workspaceLockHolderKey(holder)
    const beatAt = '2026-09-23T10:00:00.000Z'
    const wallLate = wallPlus(beatAt, 10 * 60_000)

    lapse.observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
    monotonic.now += 170_000
    expect(
      lapse
        .observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
        .get(key)
    ).toMatchObject({ state: 'stale', graceObservedMs: 170_000 })

    // The holder beat again (still wall-stale by the reclaimer's clock, which
    // is exactly the clock-skew case): a new beatSeq restarts the window.
    monotonic.now += 1
    expect(
      lapse
        .observe({
          nowIso: wallLate,
          heartbeats: [beat({ beatAt, beatSeq: 2 })],
          holders: [holder]
        })
        .get(key)
    ).toMatchObject({ state: 'stale', beatSeq: 2, graceObservedMs: 0 })
    monotonic.now += 179_999
    expect(
      lapse
        .observe({
          nowIso: wallLate,
          heartbeats: [beat({ beatAt, beatSeq: 2 })],
          holders: [holder]
        })
        .get(key)
    ).toMatchObject({ state: 'stale', graceObservedMs: 179_999 })

    // A holder that disappears from the lease set is forgotten; when it comes
    // back the window starts again rather than resuming a stale count.
    lapse.observe({ nowIso: wallLate, heartbeats: [beat({ beatAt, beatSeq: 2 })], holders: [] })
    monotonic.now += 1
    expect(
      lapse
        .observe({
          nowIso: wallLate,
          heartbeats: [beat({ beatAt, beatSeq: 2 })],
          holders: [holder]
        })
        .get(key)
    ).toMatchObject({ state: 'stale', graceObservedMs: 0 })
  })

  it('treats a scan gap wider than the suspend gap as a suspend and restarts every window', () => {
    const monotonic = { now: 0 }
    const lapse = tracker(monotonic, { ttlMs: 90_000, graceMs: 180_000, suspendGapMs: 60_000 })
    const key = workspaceLockHolderKey(holder)
    const beatAt = '2026-09-23T10:00:00.000Z'
    const wallLate = wallPlus(beatAt, 10 * 60_000)
    const scanAfter = (ms: number) => {
      monotonic.now += ms
      return lapse
        .observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
        .get(key)
    }

    scanAfter(0)
    for (let scan = 1; scan <= 5; scan += 1) {
      expect(scanAfter(30_000)).toMatchObject({ state: 'stale', graceObservedMs: scan * 30_000 })
    }
    expect(lapse.suspendGapCount()).toBe(0)

    // macOS: the monotonic clock kept running through a 10-minute sleep. Without
    // the gap rule this observation would read as 750 s of grace and reclaim a
    // holder that has not yet had one interval to beat.
    expect(scanAfter(10 * 60_000)).toMatchObject({ state: 'stale', graceObservedMs: 0 })
    expect(lapse.suspendGapCount()).toBe(1)
    for (let scan = 1; scan < 6; scan += 1) {
      expect(scanAfter(30_000)).toMatchObject({ state: 'stale', graceObservedMs: scan * 30_000 })
    }
    expect(scanAfter(30_000)).toMatchObject({ state: 'lapsed', graceObservedMs: 180_000 })
    expect(lapse.suspendGapCount()).toBe(1)
  })

  it('starts fresh after reset, so an idle stretch is never counted as a suspend', () => {
    const monotonic = { now: 0 }
    const lapse = tracker(monotonic, { ttlMs: 90_000, graceMs: 180_000, suspendGapMs: 60_000 })
    const key = workspaceLockHolderKey(holder)
    const beatAt = '2026-09-23T10:00:00.000Z'
    const wallLate = wallPlus(beatAt, 10 * 60_000)

    lapse.observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
    monotonic.now += 30_000
    expect(
      lapse
        .observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
        .get(key)
    ).toMatchObject({ state: 'stale', graceObservedMs: 30_000 })

    lapse.reset()
    monotonic.now += 60 * 60_000
    expect(
      lapse
        .observe({ nowIso: wallLate, heartbeats: [beat({ beatAt })], holders: [holder] })
        .get(key)
    ).toMatchObject({ state: 'stale', graceObservedMs: 0 })
    expect(lapse.suspendGapCount()).toBe(0)
  })
})
