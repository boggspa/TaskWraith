import { describe, expect, it } from 'vitest'

import {
  HOST_COMMIT_GATE_BUCKET_BOUNDS_MS,
  createHostCommitGate,
  type HostCommitGate,
  type HostCommitGateEnterResult,
  type HostCommitGateLease,
  type HostCommitGateMode
} from './HostCommitGate'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function entered(result: HostCommitGateEnterResult | null): HostCommitGateLease {
  if (result === null) throw new Error('the request has not settled')
  if (!result.ok) throw new Error(`expected entry, got ${result.reason}`)
  return result.lease
}

/**
 * Drive a gate by name: `enter` records when each request settles in `log`
 * (with the clock, when one is given), and `release` releases by label.
 */
function driver(gate: HostCommitGate, clock?: () => number) {
  const log: string[] = []
  const leases = new Map<string, HostCommitGateLease>()
  return {
    log,
    enter(mode: HostCommitGateMode, label: string, signal?: AbortSignal) {
      void gate.enter(mode, { label, signal }).then((result) => {
        const at = clock ? `${clock()}:` : ''
        if (result.ok) {
          leases.set(label, result.lease)
          log.push(`${at}${label}`)
        } else {
          log.push(`${at}${label}:${result.reason}`)
        }
      })
    },
    release(label: string) {
      const lease = leases.get(label)
      if (!lease) throw new Error(`${label} never entered`)
      lease.release()
    }
  }
}

describe('HostCommitGate exclusion', () => {
  it('makes an observer wait for an in-flight commit, and a commit for an open observer window', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('committer', 'commit')
    await settle()
    drive.enter('observer', 'reconcile')
    await settle()
    expect(drive.log).toEqual(['commit'])
    expect(gate.snapshot()).toMatchObject({ holding: 'committer', holders: ['commit'], waiting: 1 })
    drive.release('commit')
    await settle()
    expect(drive.log).toEqual(['commit', 'reconcile'])

    drive.enter('committer', 'commit-2')
    await settle()
    expect(drive.log).toEqual(['commit', 'reconcile'])
    drive.release('reconcile')
    await settle()
    expect(drive.log).toEqual(['commit', 'reconcile', 'commit-2'])
    drive.release('commit-2')
    expect(gate.snapshot()).toMatchObject({ holding: null, holders: [], waiting: 0 })
  })

  it('shares each mode among its holders', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('observer', 'legacy-window')
    drive.enter('observer', 'snapshot-stamp')
    await settle()
    expect(gate.snapshot()).toMatchObject({
      holding: 'observer',
      holders: ['legacy-window', 'snapshot-stamp']
    })
    drive.release('legacy-window')
    drive.release('snapshot-stamp')
    drive.enter('committer', 'commit-a')
    drive.enter('committer', 'commit-b')
    await settle()
    expect(drive.log).toEqual(['legacy-window', 'snapshot-stamp', 'commit-a', 'commit-b'])
    expect(gate.snapshot()).toMatchObject({
      holding: 'committer',
      holders: ['commit-a', 'commit-b']
    })
  })

  it('lets generation reset in alone, after everything before it and before everything after', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('observer', 'o1')
    await settle()
    drive.enter('exclusive', 'reset')
    drive.enter('observer', 'o2')
    drive.enter('committer', 'c1')
    await settle()
    expect(drive.log).toEqual(['o1'])
    drive.release('o1')
    await settle()
    expect(drive.log).toEqual(['o1', 'reset'])
    expect(gate.snapshot()).toMatchObject({ holding: 'exclusive', holders: ['reset'], waiting: 2 })
    drive.release('reset')
    await settle()
    expect(drive.log).toEqual(['o1', 'reset', 'o2'])
    drive.release('o2')
    await settle()
    expect(drive.log).toEqual(['o1', 'reset', 'o2', 'c1'])

    // A second exclusive request waits for the first: exclusive never shares.
    drive.release('c1')
    drive.enter('exclusive', 'reset-1')
    drive.enter('exclusive', 'reset-2')
    await settle()
    expect(drive.log.slice(-1)).toEqual(['reset-1'])
    drive.release('reset-1')
    await settle()
    expect(drive.log.slice(-1)).toEqual(['reset-2'])
  })
})

describe('HostCommitGate order', () => {
  it('serves requests in arrival order, a compatible run at a time', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('observer', 'o1')
    drive.enter('observer', 'o2')
    await settle()
    drive.enter('committer', 'c1')
    // Compatible with the observers holding, but c1 is waiting ahead of it.
    drive.enter('observer', 'o3')
    // Compatible with c1 once it holds, but o3 is ahead of it.
    drive.enter('committer', 'c2')
    await settle()
    expect(drive.log).toEqual(['o1', 'o2'])
    drive.release('o1')
    await settle()
    expect(drive.log).toEqual(['o1', 'o2'])
    drive.release('o2')
    await settle()
    expect(drive.log).toEqual(['o1', 'o2', 'c1'])
    drive.release('c1')
    await settle()
    expect(drive.log).toEqual(['o1', 'o2', 'c1', 'o3'])
    drive.release('o3')
    await settle()
    expect(drive.log).toEqual(['o1', 'o2', 'c1', 'o3', 'c2'])
  })

  it('admits a whole compatible run at once when the gate frees', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('committer', 'commit')
    await settle()
    drive.enter('observer', 'o1')
    drive.enter('observer', 'o2')
    drive.enter('observer', 'o3')
    drive.enter('committer', 'next-commit')
    await settle()
    drive.release('commit')
    await settle()
    expect(drive.log).toEqual(['commit', 'o1', 'o2', 'o3'])
    expect(gate.snapshot()).toMatchObject({ holders: ['o1', 'o2', 'o3'], waiting: 1 })
  })

  it('never lets observers arriving every second starve a waiting committer', async () => {
    // Each observer holds 1.5 s and one arrives every second, so observers
    // alone would overlap forever.
    let clock = 0
    const gate = createHostCommitGate({ now: () => clock })
    const drive = driver(gate, () => clock)
    const timeline: Array<[number, () => void]> = [
      [0, () => drive.enter('observer', 'o1')],
      [1_000, () => drive.enter('observer', 'o2')],
      [1_500, () => drive.release('o1')],
      [2_000, () => drive.enter('observer', 'o3')],
      [2_100, () => drive.enter('committer', 'commit')],
      [2_500, () => drive.release('o2')],
      [3_000, () => drive.enter('observer', 'o4')],
      [3_500, () => drive.release('o3')],
      [3_700, () => drive.release('commit')],
      [4_000, () => drive.enter('observer', 'o5')]
    ]
    for (const [at, act] of timeline) {
      clock = at
      act()
      await settle()
    }
    // The commit enters once the observers there before it leave; o4, which
    // arrived while it waited, follows it.
    expect(drive.log).toEqual(['0:o1', '1000:o2', '2000:o3', '3500:commit', '3700:o4', '4000:o5'])
    expect(gate.snapshot().modes.committer.waitMs).toMatchObject({ count: 1, maxMs: 1_400 })
  })

  it('never lets a stream of commits starve a waiting observer', async () => {
    let clock = 0
    const gate = createHostCommitGate({ now: () => clock })
    const drive = driver(gate, () => clock)
    const timeline: Array<[number, () => void]> = [
      [0, () => drive.enter('committer', 'c1')],
      [100, () => drive.enter('committer', 'c2')],
      [150, () => drive.release('c1')],
      [200, () => drive.enter('observer', 'reconcile')],
      [300, () => drive.enter('committer', 'c3')],
      [350, () => drive.release('c2')],
      [500, () => drive.release('reconcile')]
    ]
    for (const [at, act] of timeline) {
      clock = at
      act()
      await settle()
    }
    expect(drive.log).toEqual(['0:c1', '100:c2', '350:reconcile', '500:c3'])
  })
})

describe('HostCommitGate leaving and closing', () => {
  it('lets a waiting request leave, and admits what it was holding back', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('observer', 'o1')
    await settle()
    const controller = new AbortController()
    drive.enter('committer', 'commit', controller.signal)
    drive.enter('observer', 'o2')
    await settle()
    expect(drive.log).toEqual(['o1'])
    controller.abort()
    await settle()
    // With the commit gone, o2 is compatible with the observer holding.
    expect(drive.log).toEqual(['o1', 'commit:aborted', 'o2'])
    expect(gate.snapshot()).toMatchObject({ holders: ['o1', 'o2'], waiting: 0 })

    const done = new AbortController()
    done.abort()
    await expect(gate.enter('committer', { label: 'late', signal: done.signal })).resolves.toEqual({
      ok: false,
      reason: 'aborted'
    })
    expect(gate.snapshot().modes.committer.aborted).toBe(2)
  })

  it('stops listening to a request’s signal once it enters', async () => {
    const gate = createHostCommitGate()
    const listeners = new Set<unknown>()
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: unknown) => listeners.add(listener),
      removeEventListener: (_type: string, listener: unknown) => listeners.delete(listener)
    } as unknown as AbortSignal
    const holder = entered(await gate.enter('observer', { label: 'observer' }))
    const waiting = gate.enter('committer', { label: 'commit', signal })
    expect(listeners.size).toBe(1)
    holder.release()
    const lease = entered(await waiting)
    expect(listeners.size).toBe(0)
    lease.release()
  })

  it('ignores a second release, which never lets another mode in beside a holder', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('observer', 'o1')
    drive.enter('observer', 'o2')
    await settle()
    drive.enter('committer', 'commit')
    drive.release('o1')
    drive.release('o1')
    await settle()
    expect(drive.log).toEqual(['o1', 'o2'])
    expect(gate.snapshot()).toMatchObject({ holding: 'observer', holders: ['o2'], waiting: 1 })
    // Nor is its hold counted twice.
    expect(gate.snapshot().modes.observer.holdMs.count).toBe(1)
  })

  it('refuses queued and new requests once closed, and lets holders finish', async () => {
    const gate = createHostCommitGate()
    const drive = driver(gate)
    drive.enter('committer', 'commit')
    await settle()
    drive.enter('observer', 'queued')
    gate.close()
    await settle()
    expect(drive.log).toEqual(['commit', 'queued:closed'])
    expect(gate.closed).toBe(true)
    await expect(gate.enter('committer', { label: 'new' })).resolves.toEqual({
      ok: false,
      reason: 'closed'
    })
    drive.release('commit')
    expect(gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
    expect(gate.snapshot().modes.observer.closed).toBe(1)
    expect(gate.snapshot().modes.committer.closed).toBe(1)
    gate.close()
  })
})

describe('HostCommitGate counters', () => {
  it('counts entries, waits, holds and the deepest queue per mode', async () => {
    let clock = 10
    const gate = createHostCommitGate({ now: () => clock })
    const drive = driver(gate)
    drive.enter('committer', 'commit')
    await settle()
    drive.enter('observer', 'o1')
    drive.enter('observer', 'o2')
    drive.enter('exclusive', 'reset')
    await settle()
    clock = 25
    drive.release('commit')
    await settle()
    clock = 1_025
    drive.release('o1')
    clock = 40_025
    drive.release('o2')
    await settle()
    clock = 40_026
    drive.release('reset')

    const { modes, maxWaiting } = gate.snapshot()
    expect(maxWaiting).toBe(3)
    const bucket = (ms: number): number[] => {
      const buckets = new Array<number>(HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.length + 1).fill(0)
      let index = HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.findIndex((bound) => ms <= bound)
      if (index < 0) index = HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.length
      buckets[index] += 1
      return buckets
    }
    const sum = (...lists: number[][]): number[] =>
      lists[0].map((_value, index) => lists.reduce((total, list) => total + list[index], 0))

    expect(modes.committer).toEqual({
      entered: 1,
      aborted: 0,
      closed: 0,
      waitMs: { count: 1, totalMs: 0, maxMs: 0, buckets: bucket(0) },
      holdMs: { count: 1, totalMs: 15, maxMs: 15, buckets: bucket(15) }
    })
    expect(modes.observer).toEqual({
      entered: 2,
      aborted: 0,
      closed: 0,
      waitMs: { count: 2, totalMs: 30, maxMs: 15, buckets: sum(bucket(15), bucket(15)) },
      holdMs: {
        count: 2,
        totalMs: 1_000 + 40_000,
        maxMs: 40_000,
        buckets: sum(bucket(1_000), bucket(40_000))
      }
    })
    expect(modes.exclusive).toMatchObject({
      entered: 1,
      waitMs: { count: 1, totalMs: 40_015, maxMs: 40_015 },
      holdMs: { count: 1, totalMs: 1, maxMs: 1, buckets: bucket(1) }
    })
    // Bounds are inclusive; past the last one a sample lands in the overflow.
    expect(bucket(1)[0]).toBe(1)
    expect(bucket(1.5)[1]).toBe(1)
    expect(bucket(30_000)[HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.length - 1]).toBe(1)
    expect(bucket(40_000)[HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.length]).toBe(1)
  })

  it('drops a timing when the clock fails, and nothing else', async () => {
    for (const now of [
      () => {
        throw new Error('clock down')
      },
      () => Number.NaN,
      () => -1
    ]) {
      const gate = createHostCommitGate({ now })
      const lease = entered(await gate.enter('committer', { label: 'commit' }))
      lease.release()
      expect(gate.snapshot().modes.committer).toMatchObject({
        entered: 1,
        waitMs: { count: 0, totalMs: 0 },
        holdMs: { count: 0, totalMs: 0 }
      })
    }
  })

  it('snapshots copies that later activity does not change', async () => {
    const gate = createHostCommitGate({ now: () => 0 })
    const before = gate.snapshot()
    entered(await gate.enter('observer', { label: 'o' })).release()
    expect(before.modes.observer.entered).toBe(0)
    expect(before.modes.observer.waitMs.buckets.every((count) => count === 0)).toBe(true)
    expect(gate.snapshot().modes.observer.entered).toBe(1)
  })
})

describe('HostCommitGate inputs', () => {
  it('validates the mode and the holder label', async () => {
    const gate = createHostCommitGate()
    for (const mode of ['reader', '', undefined, 'Observer']) {
      await expect(async () =>
        gate.enter(mode as HostCommitGateMode, { label: 'x' })
      ).rejects.toThrow(TypeError)
    }
    for (const label of [
      '',
      undefined,
      'l'.repeat(257),
      `l${String.fromCharCode(0)}`,
      `l${String.fromCharCode(0x1f)}`,
      `l${String.fromCharCode(0x7f)}`
    ]) {
      await expect(async () => gate.enter('observer', { label: label as string })).rejects.toThrow(
        TypeError
      )
    }
    await expect(async () => gate.enter('observer', undefined as never)).rejects.toThrow(TypeError)
    entered(await gate.enter('observer', { label: 'l'.repeat(256) })).release()
    expect(gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
  })
})
