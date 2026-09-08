import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'module'
import { afterAll, describe, expect, it } from 'vitest'
import { createHostPerfInstrumentation } from '../../../src/host-runtime/HostPerfSnapshot'
import { createHostPerfSnapshotFileWriter } from '../../../src/host-runtime/HostPerfSnapshotFile'

/**
 * End-to-end proof of the M1 A1.2 Host transport: the file the Host writer
 * produces is the file the collector reader accepts — identity, sequence
 * and freshness validated — and ONLY a valid fresh read replaces the
 * pre-transport `host_perf_transport_unspecified` marker. A configured but
 * broken transport must report its specific refusal, never impersonate an
 * unconfigured baseline: a paired G-X comparison that silently lost its
 * Host evidence would still validate, and that is exactly the unattributable
 * run this seam exists to prevent.
 *
 * Lives beside the collector so vitest's default discovery runs it; the
 * .cjs collector modules are loaded through createRequire.
 */
const require = createRequire(import.meta.url)
const {
  DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS,
  readHostPerfSnapshotFile,
  sampleHostSpans,
  applyCrossThreadToMetrics,
  validateCrossThreadBlock
} = require('./hostSpans.cjs')

const CELL = 'large/2/warm/codex_profiles_solo_ensemble_mesh/none'
const WRITE_AT = new Date('2026-09-08T16:00:00.000Z')
const FRESH_AT = new Date('2026-09-08T16:00:01.000Z')
const IDENTITY = { process: 'host' as const, instanceId: 'host-abc', generation: 2, pid: 777 }

const scratchDirs: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-perf-transport-'))
  scratchDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** Write one real snapshot file via the real writer and real node:fs. */
function writeRealSnapshot(): { path: string } {
  const instrumentation = createHostPerfInstrumentation()
  instrumentation.spans.record({
    chatId: 'chat-heavy',
    kind: 'host_queue_wait',
    resource: 'host_chain',
    startedAt: 5,
    durationMs: 120
  })
  const path = join(scratchDir(), 'host-snapshot.json')
  const writer = createHostPerfSnapshotFileWriter({
    instrumentation,
    path,
    intervalMs: 1000,
    maxBytes: 256 * 1024,
    identity: IDENTITY,
    now: () => WRITE_AT
  })
  expect(writer.writeOnce()).toBe(true)
  return { path }
}

describe('Host perf snapshot file transport (writer → collector reader)', () => {
  it('stays host_perf_transport_unspecified when nothing configures a path', () => {
    expect(readHostPerfSnapshotFile()).toEqual({
      unsupported: 'host_perf_transport_unspecified'
    })
    expect(readHostPerfSnapshotFile({ env: {} })).toEqual({
      unsupported: 'host_perf_transport_unspecified'
    })
  })

  it('accepts a fresh matching write end-to-end and survives crossThread folding', () => {
    const { path } = writeRealSnapshot()
    const hostPerf = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: path,
      expectedIdentity: { instanceId: 'host-abc', generation: 2, pid: 777 },
      now: () => FRESH_AT
    })

    expect(hostPerf.unsupported).toBeUndefined()
    expect(hostPerf.identity).toEqual(IDENTITY)
    expect(hostPerf.sequence).toBe(1)
    expect(hostPerf.capturedAt).toBe('2026-09-08T16:00:00.000Z')
    expect(hostPerf.eventLoopLag).toBeDefined()
    // The cargo is a fully validated 'host' work-span section, attribution intact.
    expect(hostPerf.workSpans.process).toBe('host')
    expect(hostPerf.workSpans.byKind.host_queue_wait.count).toBe(1)
    expect(hostPerf.workSpans.byChat['chat-heavy'].host_queue_wait.totalMs).toBe(120)

    // And the block the harness stores actually validates as Host evidence.
    const metrics: Record<string, unknown> = {}
    applyCrossThreadToMetrics(metrics, CELL, { host: hostPerf.workSpans })
    expect(validateCrossThreadBlock((metrics as { crossThread: unknown }).crossThread)).toEqual([])
  })

  it('reads the path from TASKWRAITH_PERF_HOST_SNAPSHOT_PATH when no option names one', () => {
    const { path } = writeRealSnapshot()
    const hostPerf = readHostPerfSnapshotFile({
      env: { TASKWRAITH_PERF_HOST_SNAPSHOT_PATH: path },
      now: () => FRESH_AT
    })
    expect(hostPerf.unsupported).toBeUndefined()
    expect(hostPerf.sequence).toBe(1)
  })

  it('refuses stale evidence in both directions of clock disagreement', () => {
    const { path } = writeRealSnapshot()
    const past = new Date(WRITE_AT.getTime() + DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS + 1)
    expect(readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => past })).toEqual({
      unsupported: 'host_perf_snapshot_stale'
    })
    // A future-dated artifact is as untrustworthy as an old one.
    const future = new Date(WRITE_AT.getTime() - DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS - 1)
    expect(readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => future })).toEqual({
      unsupported: 'host_perf_snapshot_stale'
    })
    // maxAgeMs is an option: the same artifact is fresh under a wider bound.
    const wide = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: path,
      now: () => past,
      maxAgeMs: DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS * 10
    })
    expect(wide.unsupported).toBeUndefined()
  })

  it('refuses evidence from the wrong Host instance', () => {
    const { path } = writeRealSnapshot()
    for (const expectedIdentity of [
      { instanceId: 'other-host' },
      { generation: 3 },
      { pid: 778 }
    ]) {
      expect(
        readHostPerfSnapshotFile({
          hostPerfSnapshotPath: path,
          expectedIdentity,
          now: () => FRESH_AT
        })
      ).toEqual({ unsupported: 'host_perf_snapshot_identity_mismatch' })
    }
  })

  it('fails closed on unreadable or malformed artifacts with specific reasons', () => {
    const dir = scratchDir()
    const missing = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: join(dir, 'never-written.json'),
      now: () => FRESH_AT
    })
    expect(missing.unsupported).toMatch(/^host_perf_snapshot_unreadable: /)

    const garbled = join(dir, 'garbled.json')
    writeFileSync(garbled, 'not json at all')
    expect(
      readHostPerfSnapshotFile({ hostPerfSnapshotPath: garbled, now: () => FRESH_AT })
    ).toEqual({ unsupported: 'host_perf_snapshot_invalid: parse_error' })

    const wrongIdentity = join(dir, 'wrong-identity.json')
    writeFileSync(
      wrongIdentity,
      JSON.stringify({
        identity: { process: 'main', instanceId: 'x', generation: 0, pid: 1 },
        sequence: 1,
        capturedAt: WRITE_AT.toISOString(),
        snapshot: { sections: {} }
      })
    )
    expect(
      readHostPerfSnapshotFile({ hostPerfSnapshotPath: wrongIdentity, now: () => FRESH_AT })
    ).toEqual({ unsupported: 'host_perf_snapshot_invalid: identity' })

    const badSection = join(dir, 'bad-section.json')
    writeFileSync(
      badSection,
      JSON.stringify({
        identity: IDENTITY,
        sequence: 7,
        capturedAt: WRITE_AT.toISOString(),
        snapshot: { sections: { workSpans: { process: 'host' } } }
      })
    )
    const bad = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: badSection,
      now: () => FRESH_AT
    })
    expect(bad.unsupported).toMatch(/^host_perf_snapshot_invalid: /)
    expect(bad.unsupported).not.toBe('host_perf_transport_unspecified')

    const badSequence = join(dir, 'bad-sequence.json')
    writeFileSync(
      badSequence,
      JSON.stringify({
        identity: IDENTITY,
        sequence: 0,
        capturedAt: WRITE_AT.toISOString(),
        snapshot: { sections: {} }
      })
    )
    expect(
      readHostPerfSnapshotFile({ hostPerfSnapshotPath: badSequence, now: () => FRESH_AT })
    ).toEqual({ unsupported: 'host_perf_snapshot_invalid: sequence' })
  })

  it('threads the Host read through sampleHostSpans independently of the renderer session', async () => {
    const { path } = writeRealSnapshot()
    // No renderer session: main sampling is unsupported, Host evidence still lands.
    const sampled = await sampleHostSpans(null, {
      hostPerfSnapshotPath: path,
      now: () => FRESH_AT
    })
    expect(sampled.workSpans).toEqual({ unsupported: 'renderer_runtime_session_required' })
    expect(sampled.hostPerf.unsupported).toBeUndefined()
    expect(sampled.hostPerf.workSpans.process).toBe('host')

    // Unconfigured sampleHostSpans is byte-identical to the pre-transport shape.
    const unconfigured = await sampleHostSpans(null, { env: {} })
    expect(unconfigured.hostPerf).toEqual({ unsupported: 'host_perf_transport_unspecified' })
  })
})
