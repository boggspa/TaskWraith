import { describe, expect, it, vi } from 'vitest'
import { createHostCommitGate } from './HostCommitGate'
import type { HostProfileThread } from './HostProfileDomainStore'
import { createHostPerfInstrumentation } from './HostPerfSnapshot'
import { createHostPerfSnapshotFileWriter } from './HostPerfSnapshotFile'
import { HostPublicWindowFeeder } from './HostPublicWindowFeeder'
import { HostPublicWindowIndex } from './HostPublicWindowIndex'
import {
  createHostPublicWindowPerfSections,
  HOST_PERF_GATE_HOLDER_LIMIT,
  HOST_PERF_GATE_LABEL_LIMIT,
  type HostPublicWindowPerfSources
} from './HostPublicWindowPerf'

function services(): HostPublicWindowPerfSources & { feeder: HostPublicWindowFeeder } {
  const index = new HostPublicWindowIndex()
  const unexpectedPublish = vi.fn(() => {
    throw new Error('seed must not publish')
  })
  const feeder = new HostPublicWindowFeeder({
    index,
    publicationLock: async (work) => work(),
    deltas: {
      appendGroup: unexpectedPublish,
      awaitDurable: unexpectedPublish,
      getPosition: () => ({ generation: 1, cursor: 0 }),
      releaseGroup: unexpectedPublish
    },
    model: unexpectedPublish,
    now: () => 1_000,
    publishing: false
  })
  return { gate: createHostCommitGate(), feeder, index }
}

describe('production public window perf sections', () => {
  it('samples the live gate wait/hold histograms across leases without resetting them', async () => {
    let now = 0
    const live = services()
    const gate = createHostCommitGate({ now: () => now })
    const sections = createHostPublicWindowPerfSections(() => ({ ...live, gate }))
    const observer = await gate.enter('observer', { label: 'legacy-window' })
    if (!observer.ok) throw new Error('observer refused')
    now = 5
    const waiting = gate.enter('committer', { label: 'persist' })
    expect(sections.commitGate()).toMatchObject({
      holding: 'observer',
      holders: ['legacy-window'],
      holderCount: 1,
      waiting: 1,
      maxWaiting: 1
    })
    now = 25
    observer.lease.release()
    const committer = await waiting
    if (!committer.ok) throw new Error('committer refused')
    now = 35
    committer.lease.release()
    const snapshot = sections.commitGate()
    expect(snapshot).toMatchObject({
      holding: null,
      waiting: 0,
      maxWaiting: 1,
      modes: {
        observer: { entered: 1, holdMs: { count: 1, totalMs: 25, maxMs: 25 } },
        committer: {
          entered: 1,
          waitMs: { count: 1, totalMs: 20, maxMs: 20 },
          holdMs: { count: 1, totalMs: 10, maxMs: 10 }
        }
      }
    })
    expect(sections.commitGate()).toEqual(snapshot)
    await live.feeder.close()
  })

  it('reports real feeder and index changes through the recorder integration', async () => {
    const live = services()
    const perf = createHostPerfInstrumentation()
    perf.registerSections(createHostPublicWindowPerfSections(() => live))
    expect(perf.snapshot().sections.publicWindowIndex).toEqual({
      threads: 0,
      keptRuns: 0,
      trimmedThreads: 0
    })
    const thread = {
      appChatId: 'chat-1',
      scope: 'global',
      title: 'Thread',
      provider: 'codex',
      archived: false,
      createdAt: 1,
      updatedAt: 1_000,
      persistenceRevision: 1,
      messages: [],
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          status: 'success',
          startedAt: new Date(100).toISOString(),
          endedAt: new Date(200).toISOString()
        }
      ]
    } as HostProfileThread
    live.feeder.mark('chat-1', 'record', thread)
    await live.feeder.idle()
    const snapshot = perf.snapshot()
    expect(snapshot.sections.publicWindowFeeder).toMatchObject({ eager: 1, suppressed: 1 })
    expect(snapshot.sections.publicWindowIndex).toEqual({
      threads: 1,
      keptRuns: 1,
      trimmedThreads: 0
    })
    live.feeder.mark('chat-1', 'deleted')
    await live.feeder.idle()
    expect(perf.snapshot().sections.publicWindowIndex).toMatchObject({ threads: 0, keptRuns: 0 })
    expect(snapshot.sections.publicWindowIndex).toMatchObject({ threads: 1, keptRuns: 1 })
    await live.feeder.close()
  })

  it('isolates sampler faults, including hostile exceptions and source lookup failures', async () => {
    const live = services()
    const hostile = {
      toString: () => {
        throw new Error('exception conversion must not run')
      }
    }
    const sections = createHostPublicWindowPerfSections(() => ({
      ...live,
      gate: {
        snapshot: () => {
          throw hostile
        }
      }
    }))
    expect(sections.commitGate()).toEqual({ error: 'snapshot_failed' })
    expect(sections.publicWindowFeeder()).toEqual(live.feeder.counters())
    expect(sections.publicWindowIndex()).toEqual(live.index.diagnostics())
    const broken = createHostPublicWindowPerfSections(() => {
      throw hostile
    })
    for (const sample of Object.values(broken)) {
      expect(sample()).toEqual({ error: 'snapshot_failed' })
    }
    const absent = createHostPublicWindowPerfSections(() => null)
    for (const sample of Object.values(absent)) expect(sample()).toEqual({ available: false })
    await live.feeder.close()
  })

  it('bounds holder output and preserves total pressure in the production snapshot file', async () => {
    const live = services()
    const gate = createHostCommitGate()
    const holders = await Promise.all(
      Array.from({ length: 2_000 }, () => gate.enter('observer', { label: 'x'.repeat(256) }))
    )
    const perf = createHostPerfInstrumentation()
    perf.registerSections(createHostPublicWindowPerfSections(() => ({ ...live, gate })))
    const section = perf.snapshot().sections.commitGate as {
      holderCount: number
      holders: string[]
      omittedHolders: number
    }
    expect(section.holderCount).toBe(2_000)
    expect(section.holders).toHaveLength(HOST_PERF_GATE_HOLDER_LIMIT)
    expect(section.holders.every((label) => label.length === HOST_PERF_GATE_LABEL_LIMIT)).toBe(true)
    expect(section.omittedHolders).toBe(2_000 - HOST_PERF_GATE_HOLDER_LIMIT)
    const files = new Map<string, string>()
    const writer = createHostPerfSnapshotFileWriter({
      instrumentation: perf,
      path: '/perf/host.json',
      intervalMs: 5_000,
      maxBytes: 256 * 1024,
      identity: { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 },
      fs: {
        writeFileSync: (path, data) => files.set(path, data),
        renameSync: (from, to) => files.set(to, files.get(from)!)
      }
    })
    expect(writer.writeOnce()).toBe(true)
    const output = files.get('/perf/host.json')!
    expect(Buffer.byteLength(output)).toBeLessThan(16 * 1024)
    expect(JSON.parse(output)).not.toHaveProperty('truncated')
    for (const holder of holders) if (holder.ok) holder.lease.release()
    await live.feeder.close()
  })

  it('rejects malformed numeric samples without emitting misleading JSON nulls', async () => {
    const live = services()
    const sections = createHostPublicWindowPerfSections(() => ({
      ...live,
      feeder: { counters: () => ({ ...live.feeder.counters(), eagerMs: NaN }) },
      index: { diagnostics: () => ({ threads: Infinity, keptRuns: 0, trimmedThreads: 0 }) }
    }))
    expect(sections.publicWindowFeeder()).toEqual({ error: 'snapshot_failed' })
    expect(sections.publicWindowIndex()).toEqual({ error: 'snapshot_failed' })
    expect(sections.commitGate()).toMatchObject({ waiting: 0 })
    await live.feeder.close()
  })
})
