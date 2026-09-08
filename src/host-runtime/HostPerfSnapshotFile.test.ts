import { describe, expect, it } from 'vitest'
import { createHostPerfInstrumentation } from './HostPerfSnapshot'
import {
  createHostPerfSnapshotFileWriter,
  type HostPerfSnapshotFileFs,
  type HostPerfSnapshotFileIdentity,
  type HostPerfSnapshotFileWriterOptions
} from './HostPerfSnapshotFile'

const IDENTITY: HostPerfSnapshotFileIdentity = {
  process: 'host',
  instanceId: 'host-instance-1',
  generation: 3,
  pid: 4242
}

const FIXED_AT = new Date('2026-09-08T16:00:00.000Z')

/** In-memory fs recording exact operation order. */
function fakeFs(): HostPerfSnapshotFileFs & {
  files: Map<string, string>
  ops: string[]
} {
  const files = new Map<string, string>()
  const ops: string[] = []
  return {
    files,
    ops,
    writeFileSync: (path, data) => {
      ops.push(`write:${path}`)
      files.set(path, data)
    },
    renameSync: (from, to) => {
      ops.push(`rename:${from}->${to}`)
      const data = files.get(from)
      if (data === undefined) throw new Error(`rename source missing: ${from}`)
      files.delete(from)
      files.set(to, data)
    }
  }
}

function writer(overrides: Partial<HostPerfSnapshotFileWriterOptions> = {}) {
  const instrumentation = createHostPerfInstrumentation()
  const fs = fakeFs()
  const created = createHostPerfSnapshotFileWriter({
    instrumentation,
    path: '/perf/host-snapshot.json',
    intervalMs: 1000,
    maxBytes: 64 * 1024,
    identity: IDENTITY,
    now: () => FIXED_AT,
    fs,
    ...overrides
  })
  return { created, instrumentation, fs }
}

describe('createHostPerfSnapshotFileWriter', () => {
  it('writes an atomic identity/sequence/capturedAt envelope via tmp + rename', () => {
    const { created, fs } = writer()
    expect(created.writeOnce()).toBe(true)

    expect(fs.ops).toEqual([
      'write:/perf/host-snapshot.json.4242.tmp',
      'rename:/perf/host-snapshot.json.4242.tmp->/perf/host-snapshot.json'
    ])
    expect(fs.files.has('/perf/host-snapshot.json.4242.tmp')).toBe(false)

    const payload = JSON.parse(fs.files.get('/perf/host-snapshot.json')!)
    expect(payload.identity).toEqual(IDENTITY)
    expect(payload.sequence).toBe(1)
    expect(payload.capturedAt).toBe('2026-09-08T16:00:00.000Z')
    expect(payload.truncated).toBeUndefined()
    // The cargo is the real HostPerfSnapshot: lag block + workSpans section.
    expect(payload.snapshot.eventLoopLag).toBeDefined()
    expect(payload.snapshot.sections.workSpans.process).toBe('host')

    expect(created.writeOnce()).toBe(true)
    expect(JSON.parse(fs.files.get('/perf/host-snapshot.json')!).sequence).toBe(2)
    expect(created.stats()).toMatchObject({ writes: 2, sequence: 2, writeFailures: 0 })
  })

  it('captures passively: resetLagWindow is always false', () => {
    const seen: unknown[] = []
    const { created } = writer({
      instrumentation: {
        snapshot: (options) => {
          seen.push(options)
          return createHostPerfInstrumentation().snapshot()
        }
      }
    })
    created.writeOnce()
    expect(seen).toEqual([{ resetLagWindow: false }])
  })

  it('does no capture or filesystem work at construction', () => {
    let snapshots = 0
    const fs = fakeFs()
    createHostPerfSnapshotFileWriter({
      instrumentation: {
        snapshot: () => {
          snapshots += 1
          return createHostPerfInstrumentation().snapshot()
        }
      },
      path: '/perf/host-snapshot.json',
      intervalMs: 1000,
      maxBytes: 1024,
      identity: IDENTITY,
      fs
    })
    expect(snapshots).toBe(0)
    expect(fs.ops).toEqual([])
  })

  it('rejects invalid configuration at construction', () => {
    const base = () => writer()
    expect(base).not.toThrow()
    expect(() => writer({ intervalMs: 0 })).toThrow(/intervalMs/)
    expect(() => writer({ intervalMs: 1.5 })).toThrow(/intervalMs/)
    expect(() => writer({ maxBytes: -1 })).toThrow(/maxBytes/)
    expect(() => writer({ path: '' })).toThrow(/path/)
    expect(() => writer({ identity: { ...IDENTITY, process: 'main' as never } })).toThrow(/process/)
    expect(() => writer({ identity: { ...IDENTITY, instanceId: '' } })).toThrow(/instanceId/)
    expect(() => writer({ identity: { ...IDENTITY, pid: 0 } })).toThrow(/pid/)
    expect(() =>
      createHostPerfSnapshotFileWriter({
        instrumentation: {} as never,
        path: '/x',
        intervalMs: 1,
        maxBytes: 1,
        identity: IDENTITY
      })
    ).toThrow(/snapshot/)
  })

  it('drops extra sections first and keeps byChat when that candidate fits', () => {
    const instrumentation = createHostPerfInstrumentation({
      sections: { bulky: () => 'x'.repeat(4000) }
    })
    // Populate per-chat attribution so there is retained-derived data to drop.
    instrumentation.spans.record({
      chatId: 'chat-a',
      kind: 'host_queue_wait',
      resource: 'host_chain',
      startedAt: 1,
      durationMs: 10
    })
    const fs = fakeFs()
    const created = createHostPerfSnapshotFileWriter({
      instrumentation,
      path: '/perf/host-snapshot.json',
      intervalMs: 1000,
      maxBytes: 2600,
      identity: IDENTITY,
      now: () => FIXED_AT,
      fs
    })

    expect(created.writeOnce()).toBe(true)
    const payload = JSON.parse(fs.files.get('/perf/host-snapshot.json')!)
    expect(payload.truncated).toBe(true)
    expect(payload.snapshot.sections.bulky).toBeUndefined()
    expect(payload.snapshot.sections.workSpans.byChat['chat-a']).toBeDefined()
    expect(payload.truncation).toEqual({ extraSections: true, byChat: false })
    // Aggregates and exact counters are the last thing standing.
    expect(payload.snapshot.sections.workSpans.byKind.host_queue_wait.count).toBe(1)
    expect(payload.snapshot.sections.workSpans.exact).toBeDefined()
    expect(
      Buffer.byteLength(fs.files.get('/perf/host-snapshot.json')!, 'utf8')
    ).toBeLessThanOrEqual(2600)
    expect(created.stats()).toMatchObject({ writes: 1, truncatedWrites: 1, writeFailures: 0 })
  })

  it('fails closed when even the degraded payload is over budget, keeping the last good file', () => {
    const { created, fs } = writer()
    expect(created.writeOnce()).toBe(true)
    const good = fs.files.get('/perf/host-snapshot.json')

    const tiny = createHostPerfSnapshotFileWriter({
      instrumentation: createHostPerfInstrumentation(),
      path: '/perf/host-snapshot.json',
      intervalMs: 1000,
      maxBytes: 10,
      identity: IDENTITY,
      now: () => FIXED_AT,
      fs
    })
    expect(tiny.writeOnce()).toBe(false)
    expect(fs.files.get('/perf/host-snapshot.json')).toBe(good)
    expect(tiny.stats()).toMatchObject({ writes: 0, writeFailures: 1, sequence: 0 })
  })

  it('contains snapshot, serialization and filesystem failures as counted writeFailures', () => {
    // Throwing snapshot provider: no fs activity at all.
    const throwing = fakeFs()
    const broken = createHostPerfSnapshotFileWriter({
      instrumentation: {
        snapshot: () => {
          throw new Error('instrumentation exploded')
        }
      },
      path: '/perf/host-snapshot.json',
      intervalMs: 1000,
      maxBytes: 1024,
      identity: IDENTITY,
      fs: throwing
    })
    expect(broken.writeOnce()).toBe(false)
    expect(throwing.ops).toEqual([])
    expect(broken.stats()).toMatchObject({ writeFailures: 1, writes: 0 })

    // Circular section: serialization poisoned, counted, no fs activity.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const circularFs = fakeFs()
    const poisoned = createHostPerfSnapshotFileWriter({
      instrumentation: createHostPerfInstrumentation({ sections: { evil: () => circular } }),
      path: '/perf/host-snapshot.json',
      intervalMs: 1000,
      maxBytes: 64 * 1024,
      identity: IDENTITY,
      fs: circularFs
    })
    expect(poisoned.writeOnce()).toBe(false)
    expect(circularFs.ops).toEqual([])
    expect(poisoned.stats()).toMatchObject({ writeFailures: 1 })

    // Failing filesystem: counted, no rename after the failed write.
    const failingOps: string[] = []
    const failing: HostPerfSnapshotFileFs = {
      writeFileSync: (path) => {
        failingOps.push(`write:${path}`)
        throw new Error('disk full')
      },
      renameSync: (from, to) => {
        failingOps.push(`rename:${from}->${to}`)
      }
    }
    const diskless = createHostPerfSnapshotFileWriter({
      instrumentation: createHostPerfInstrumentation(),
      path: '/perf/host-snapshot.json',
      intervalMs: 1000,
      maxBytes: 64 * 1024,
      identity: IDENTITY,
      fs: failing
    })
    expect(diskless.writeOnce()).toBe(false)
    expect(failingOps).toEqual(['write:/perf/host-snapshot.json.4242.tmp'])
    expect(diskless.stats()).toMatchObject({ writeFailures: 1, writes: 0, sequence: 0 })
  })

  it('contains clock and conversion failures on direct writes and timer ticks, then recovers', () => {
    let clock = () => new Date(FIXED_AT)
    let tick: (() => void) | undefined
    const fixture = writer({
      now: () => clock(),
      timers: {
        setInterval: (callback) => {
          tick = callback
          return { unref: () => {} }
        },
        clearInterval: () => {}
      }
    })
    expect(fixture.created.writeOnce()).toBe(true)
    const good = fixture.fs.files.get('/perf/host-snapshot.json')
    fixture.created.start()
    const brokenConversion = new Date(FIXED_AT)
    brokenConversion.toISOString = () => {
      throw new Error('conversion failed')
    }
    const invalidReading = new Date(FIXED_AT)
    invalidReading.getTime = () => NaN
    const failures = [
      () => {
        throw new Error('clock failed')
      },
      () => new Date(NaN),
      () => brokenConversion,
      () => invalidReading
    ]
    for (const failure of failures) {
      clock = failure
      expect(fixture.created.writeOnce()).toBe(false)
      expect(() => tick!()).not.toThrow()
      expect(fixture.fs.files.get('/perf/host-snapshot.json')).toBe(good)
      expect(fixture.created.stats().sequence).toBe(1)
    }
    expect(fixture.created.stats().writeFailures).toBe(8)
    clock = () => new Date(FIXED_AT)
    expect(() => tick!()).not.toThrow()
    expect(fixture.created.stats()).toMatchObject({ sequence: 2, writes: 2, writeFailures: 8 })
    fixture.created.stop()
  })

  it('start arms one unref-ed interval, ticks write, and stop/start are idempotent', () => {
    const registered: Array<{ callback: () => void; ms: number }> = []
    const cleared: unknown[] = []
    let unrefs = 0
    const handleFor = (entry: { callback: () => void; ms: number }) => ({
      entry,
      unref: () => {
        unrefs += 1
      }
    })
    const { created, fs } = writer({
      timers: {
        setInterval: (callback, ms) => {
          const entry = { callback, ms }
          registered.push(entry)
          return handleFor(entry)
        },
        clearInterval: (handle) => {
          cleared.push(handle)
        }
      }
    })

    created.start()
    created.start()
    expect(registered).toHaveLength(1)
    expect(registered[0].ms).toBe(1000)
    expect(unrefs).toBe(1)
    expect(created.stats().running).toBe(true)

    registered[0].callback()
    expect(fs.files.has('/perf/host-snapshot.json')).toBe(true)
    expect(created.stats()).toMatchObject({ writes: 1, sequence: 1 })

    const final = created.stop()
    expect(final.running).toBe(false)
    expect(cleared).toHaveLength(1)
    expect(created.stop().running).toBe(false)
    expect(cleared).toHaveLength(1)

    created.start()
    expect(registered).toHaveLength(2)
    created.stop()
  })
})
