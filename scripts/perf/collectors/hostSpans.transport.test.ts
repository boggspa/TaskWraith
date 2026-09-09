import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
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
  DEFAULT_HOST_SNAPSHOT_MAX_BYTES,
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

/** Same real-writer proof with a caller-chosen identity (e.g. a boot epoch). */
function writeRealSnapshotWithIdentity(identity: typeof IDENTITY & { bootEpoch?: string }): {
  path: string
} {
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
    identity,
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
      requiredChatIds: ['chat-heavy'],
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
    applyCrossThreadToMetrics(
      metrics,
      CELL,
      { host: hostPerf.workSpans },
      { requireHostAttribution: true }
    )
    const stored = (metrics as any).crossThread.cells[CELL].processes.host.hostSnapshot
    expect(stored).toMatchObject({
      identity: IDENTITY,
      expectedIdentity: { instanceId: 'host-abc', generation: 2, pid: 777 },
      identityVerified: true,
      sequence: 1,
      sequenceMonotonicity: 'not_checked',
      capturedAt: WRITE_AT.toISOString(),
      readAt: FRESH_AT.toISOString(),
      ageMs: 1000,
      maxAgeMs: DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS,
      truncated: false,
      attribution: { status: 'available', requiredChatIds: ['chat-heavy'], missingChatIds: [] }
    })
    expect(stored).toEqual(hostPerf.workSpans.hostSnapshot)
    hostPerf.workSpans.hostSnapshot.identity.pid = 1
    expect(stored.identity.pid).toBe(777)
    expect(validateCrossThreadBlock((metrics as { crossThread: unknown }).crossThread)).toEqual([])
  })

  it.each([
    ['extras only', 1, 3000, false],
    ['attribution too', 16, 1800, true]
  ] as const)(
    'preserves coverage through real writer/file/reader/fold when dropping %s',
    (_label, population, maxBytes, dropsAttribution) => {
      const instrumentation = createHostPerfInstrumentation({
        sections: { bulky: () => 'x'.repeat(10_000) }
      })
      for (let index = 0; index < population; index++) {
        instrumentation.spans.record({
          chatId: 'chat-' + index,
          kind: 'host_queue_wait',
          resource: 'host_chain',
          startedAt: 1,
          durationMs: index + 1
        })
      }
      const path = join(scratchDir(), 'bounded.json')
      const writer = createHostPerfSnapshotFileWriter({
        instrumentation,
        path,
        intervalMs: 1000,
        maxBytes,
        identity: IDENTITY,
        now: () => WRITE_AT
      })
      expect(writer.writeOnce()).toBe(true)
      const artifact = JSON.parse(fs.readFileSync(path, 'utf8'))
      expect(artifact.snapshot.sections.bulky).toBeUndefined()
      expect(artifact.truncation).toEqual({ extraSections: true, byChat: dropsAttribution })
      expect(artifact.snapshot.sections.workSpans.byChat === undefined).toBe(dropsAttribution)
      expect(fs.statSync(path).size).toBeLessThanOrEqual(maxBytes)
      const read = readHostPerfSnapshotFile({
        hostPerfSnapshotPath: path,
        expectedIdentity: IDENTITY,
        requiredChatIds: ['chat-0'],
        now: () => FRESH_AT
      })
      expect(read.unsupported).toBeUndefined()
      const metrics: any = {}
      applyCrossThreadToMetrics(metrics, CELL, { host: read.workSpans })
      const meta = metrics.crossThread.cells[CELL].processes.host.hostSnapshot
      expect(meta.identity).toEqual(IDENTITY)
      expect(meta.sequence).toBe(1)
      expect(meta.ageMs).toBe(1000)
      expect(meta.truncated).toBe(true)
      expect(meta.truncation.byChat).toBe(dropsAttribution)
      expect(meta.attribution.status).toBe(dropsAttribution ? 'censored' : 'available')
      expect(meta.attribution.sourceCoverage.recorded).toBe(population)
      expect(validateCrossThreadBlock(metrics.crossThread)).toEqual([])
      if (dropsAttribution) {
        expect(meta.attribution.reason).toBe('transport_attribution_truncated')
        expect(meta.attribution.missingChatIds).toEqual(['chat-0'])
        expect(() =>
          applyCrossThreadToMetrics(
            {},
            CELL,
            { host: read.workSpans },
            { requireHostAttribution: true }
          )
        ).toThrow(/pinned identity/)
        meta.attribution.status = 'available'
        expect(validateCrossThreadBlock(metrics.crossThread).join(';')).toContain(
          'attribution_coverage'
        )
      } else {
        expect(() =>
          applyCrossThreadToMetrics(
            {},
            CELL,
            { host: read.workSpans },
            { requireHostAttribution: true }
          )
        ).not.toThrow()
      }
    }
  )

  it('keeps optional/partial identity diagnostic-compatible but requires actual pins and population for attribution', () => {
    const { path } = writeRealSnapshot()
    const unpinned = readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => FRESH_AT })
    expect(unpinned.unsupported).toBeUndefined()
    expect(unpinned.workSpans.hostSnapshot.identityVerified).toBe(false)
    expect(unpinned.workSpans.hostSnapshot.attribution.status).toBe('unsupported')
    const partial = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: path,
      expectedIdentity: { generation: 2 },
      requiredChatIds: ['chat-heavy'],
      now: () => FRESH_AT
    })
    expect(partial.unsupported).toBeUndefined()
    expect(partial.workSpans.hostSnapshot.attribution.reason).toBe('expected_identity_required')
    const missing = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: path,
      expectedIdentity: IDENTITY,
      requiredChatIds: ['chat-light'],
      now: () => FRESH_AT
    })
    expect(missing.workSpans.hostSnapshot.attribution).toMatchObject({
      status: 'censored',
      reason: 'designated_population_missing',
      missingChatIds: ['chat-light']
    })
    const legacy = { ...unpinned.workSpans }
    delete legacy.hostSnapshot
    const metrics: any = {}
    applyCrossThreadToMetrics(metrics, CELL, { host: legacy })
    expect(validateCrossThreadBlock(metrics.crossThread)).toEqual([])
    expect(() =>
      applyCrossThreadToMetrics({}, CELL, { host: legacy }, { requireHostAttribution: true })
    ).toThrow(/pinned identity/)
    const zero = {
      ...missing.workSpans,
      byChat: {
        'chat-light': {
          host_queue_wait: {
            count: 0,
            totalMs: 0,
            p50Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
            maxMs: 0
          }
        }
      }
    }
    zero.hostSnapshot.attribution.status = 'available'
    expect(() =>
      applyCrossThreadToMetrics({}, CELL, { host: zero }, { requireHostAttribution: true })
    ).toThrow()
  })

  it('validates carried metadata instead of trusting claimed availability, identity or freshness', () => {
    const { path } = writeRealSnapshot()
    const read = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: path,
      expectedIdentity: IDENTITY,
      requiredChatIds: ['chat-heavy'],
      now: () => FRESH_AT
    })
    for (const mutate of [
      (meta: any) => {
        meta.identityVerified = false
      },
      (meta: any) => {
        meta.expectedIdentity.pid++
      },
      (meta: any) => {
        meta.ageMs = 0
      },
      (meta: any) => {
        meta.sequenceMonotonicity = 'proven'
      },
      (meta: any) => {
        meta.bytesRead = meta.maxBytes + 1
      },
      (meta: any) => {
        meta.eventLoopLag = {}
      },
      (meta: any) => {
        // A well-formed epoch the pin never vouched for: strict pinning and
        // attribution coverage must both recompute against the claimed values.
        meta.identity.bootEpoch = 'deadbeef'.repeat(8)
      }
    ]) {
      const section = JSON.parse(JSON.stringify(read.workSpans))
      mutate(section.hostSnapshot)
      const metrics: any = {}
      applyCrossThreadToMetrics(metrics, CELL, { host: section })
      expect(validateCrossThreadBlock(metrics.crossThread).length).toBeGreaterThan(0)
    }
  })

  it('rejects oversized input before reading, and permits only an explicit larger finite cap', () => {
    const { path } = writeRealSnapshot()
    fs.appendFileSync(path, ' '.repeat(DEFAULT_HOST_SNAPSHOT_MAX_BYTES + 1))
    let reads = 0
    const io = {
      ...fs,
      readSync: (...args: Parameters<typeof fs.readSync>) => {
        reads++
        return fs.readSync(...args)
      }
    }
    expect(
      readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => FRESH_AT, fs: io })
    ).toEqual({ unsupported: 'host_perf_snapshot_oversized' })
    expect(reads).toBe(0)
    const accepted = readHostPerfSnapshotFile({
      hostPerfSnapshotPath: path,
      now: () => FRESH_AT,
      maxBytes: fs.statSync(path).size
    })
    expect(accepted.unsupported).toBeUndefined()
    expect(accepted.workSpans.hostSnapshot.bytesRead).toBe(fs.statSync(path).size)
    for (const maxBytes of [0, NaN, Infinity, '1000']) {
      expect(readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, maxBytes })).toEqual({
        unsupported: 'host_perf_snapshot_invalid: maxBytes'
      })
    }
  })

  it('rejects nonregular paths and never falls back to an injected unlimited readFileSync', () => {
    const { path } = writeRealSnapshot()
    const directory = scratchDir()
    const link = join(directory, 'link.json')
    fs.symlinkSync(path, link)
    for (const hostPerfSnapshotPath of [directory, link]) {
      expect(readHostPerfSnapshotFile({ hostPerfSnapshotPath, now: () => FRESH_AT })).toEqual({
        unsupported: 'host_perf_snapshot_nonregular'
      })
    }
    let calls = 0
    expect(
      readHostPerfSnapshotFile({
        hostPerfSnapshotPath: path,
        fs: {
          readFileSync: () => {
            calls++
            return fs.readFileSync(path, 'utf8')
          }
        }
      })
    ).toEqual({ unsupported: 'host_perf_snapshot_unreadable: fs_contract' })
    expect(calls).toBe(0)
  })

  it.each(['before open', 'during read'] as const)(
    'detects atomic path replacement %s and closes its descriptor',
    (when) => {
      const { path } = writeRealSnapshot()
      const replacement = path + '.replacement'
      fs.copyFileSync(path, replacement)
      let replaced = false
      let closed = 0
      const replace = () => {
        if (!replaced) {
          replaced = true
          fs.renameSync(replacement, path)
        }
      }
      const io = {
        ...fs,
        openSync: (file: string, flags: number) => {
          if (when === 'before open') replace()
          return fs.openSync(file, flags)
        },
        readSync: (
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number
        ) => {
          const count = fs.readSync(fd, buffer, offset, length, position)
          if (when === 'during read') replace()
          return count
        },
        closeSync: (fd: number) => {
          closed++
          fs.closeSync(fd)
        }
      }
      expect(
        readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, fs: io, now: () => FRESH_AT })
      ).toEqual({ unsupported: 'host_perf_snapshot_replaced' })
      expect(replaced).toBe(true)
      expect(closed).toBe(1)
    }
  )

  it.each([false, true])(
    'bounds descriptor growth with cap+1 and distinguishes below-cap growth (oversize=%s)',
    (oversize) => {
      const { path } = writeRealSnapshot()
      const size = fs.statSync(path).size
      let appended = false
      let readBytes = 0
      let closed = 0
      const requests: number[] = []
      const cap = size + (oversize ? 0 : 64)
      const io = {
        ...fs,
        readSync: (
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number
        ) => {
          requests.push(length)
          if (!appended) {
            appended = true
            fs.appendFileSync(path, '  ')
          }
          const count = fs.readSync(fd, buffer, offset, length, position)
          readBytes += count
          return count
        },
        closeSync: (fd: number) => {
          closed++
          fs.closeSync(fd)
        }
      }
      expect(
        readHostPerfSnapshotFile({
          hostPerfSnapshotPath: path,
          fs: io,
          now: () => FRESH_AT,
          maxBytes: cap
        })
      ).toEqual({
        unsupported: oversize ? 'host_perf_snapshot_oversized' : 'host_perf_snapshot_changed: grew'
      })
      expect(readBytes).toBeLessThanOrEqual(cap + 1)
      expect(requests.every((size) => size <= 64 * 1024)).toBe(true)
      expect(closed).toBe(1)
    }
  )

  it.each([false, true])(
    'detects growth between the final descriptor and pathname checks (oversize=%s)',
    (oversize) => {
      const { path } = writeRealSnapshot()
      const size = fs.statSync(path).size
      let checks = 0
      let closed = 0
      const io = {
        ...fs,
        lstatSync: (file: string) => {
          if (++checks === 2) fs.appendFileSync(file, '  ')
          return fs.lstatSync(file)
        },
        closeSync: (fd: number) => {
          closed++
          fs.closeSync(fd)
        }
      }
      const result = readHostPerfSnapshotFile({
        hostPerfSnapshotPath: path,
        fs: io,
        now: () => FRESH_AT,
        maxBytes: size + (oversize ? 0 : 64)
      })
      expect(result.unsupported).toBe(
        oversize ? 'host_perf_snapshot_oversized' : 'host_perf_snapshot_changed: grew'
      )
      expect(closed).toBe(1)
    }
  )

  it('classifies short reads and read errors and closes every opened descriptor', () => {
    const { path } = writeRealSnapshot()
    for (const failure of ['short', 'error']) {
      let closed = 0
      const io = {
        ...fs,
        readSync: () => {
          if (failure === 'error') throw Object.assign(new Error('read failed'), { code: 'EIO' })
          return 0
        },
        closeSync: (fd: number) => {
          closed++
          fs.closeSync(fd)
        }
      }
      expect(
        readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, fs: io, now: () => FRESH_AT })
      ).toEqual({
        unsupported:
          failure === 'short'
            ? 'host_perf_snapshot_changed: modified_or_short_read'
            : 'host_perf_snapshot_unreadable: EIO'
      })
      expect(closed).toBe(1)
    }
  })

  it('contains throwing/invalid/conversion clocks at read and sample entry points and then recovers', async () => {
    const { path } = writeRealSnapshot()
    const broken = new Date(FRESH_AT)
    broken.toISOString = () => {
      throw new Error('conversion failed')
    }
    const invalidReading = new Date(FRESH_AT)
    invalidReading.getTime = () => NaN
    for (const now of [
      () => {
        throw new Error('clock failed')
      },
      () => new Date(NaN),
      () => broken,
      () => invalidReading
    ]) {
      expect(readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now })).toEqual({
        unsupported: 'host_perf_snapshot_clock_unavailable'
      })
      const sampled = await sampleHostSpans(null, { hostPerfSnapshotPath: path, now })
      expect(sampled.hostPerf).toEqual({ unsupported: 'host_perf_snapshot_clock_unavailable' })
    }
    const recovered = readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => FRESH_AT })
    expect(recovered.unsupported).toBeUndefined()
    const prior = { untouched: true }
    expect(() =>
      applyCrossThreadToMetrics(
        prior,
        CELL,
        { host: recovered.workSpans },
        { now: () => new Date(NaN) }
      )
    ).toThrow('cross_thread_clock_unavailable')
    expect(prior).toEqual({ untouched: true })
  })

  it('marks malformed or unobserved lag unsupported while preserving valid work-span evidence', () => {
    const { path } = writeRealSnapshot()
    const artifact = JSON.parse(fs.readFileSync(path, 'utf8'))
    const lag = {
      observedForMs: 1000,
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3,
      maxMs: 4,
      meanMs: 2,
      sampling: true
    }
    for (const invalid of [
      undefined,
      null,
      {},
      { ...lag, p95Ms: 'slow' },
      { ...lag, maxMs: Infinity },
      { ...lag, meanMs: -1 },
      { ...lag, sampling: 'yes' },
      { ...lag, observedForMs: 0 },
      { ...lag, sampling: false },
      { ...lag, p99Ms: 5 },
      ...['observedForMs', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'meanMs'].flatMap((field) =>
        [undefined, null, 'bad', -1].map((value) => ({ ...lag, [field]: value }))
      )
    ]) {
      artifact.snapshot.eventLoopLag = invalid
      fs.writeFileSync(path, JSON.stringify(artifact))
      const read = readHostPerfSnapshotFile({
        hostPerfSnapshotPath: path,
        expectedIdentity: IDENTITY,
        requiredChatIds: ['chat-heavy'],
        now: () => FRESH_AT
      })
      expect(read.unsupported).toBeUndefined()
      expect(read.eventLoopLag.unsupported).toMatch(/^host_perf_lag_/)
      const metrics: any = {}
      applyCrossThreadToMetrics(metrics, CELL, { host: read.workSpans })
      expect(metrics.crossThread.cells[CELL].processes.host.hostSnapshot.eventLoopLag).toEqual(
        read.eventLoopLag
      )
      expect(validateCrossThreadBlock(metrics.crossThread)).toEqual([])
    }
    artifact.snapshot.eventLoopLag = lag
    fs.writeFileSync(path, JSON.stringify(artifact))
    expect(
      readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => FRESH_AT }).eventLoopLag
    ).toEqual(lag)
    // JSON numeric overflow remains a NUMBER (unlike stringify(Infinity), which
    // turns into null). This pins the finite check independently of typeof.
    fs.writeFileSync(path, JSON.stringify(artifact).replace('"maxMs":4', '"maxMs":1e309'))
    expect(
      readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => FRESH_AT }).eventLoopLag
    ).toEqual({ unsupported: 'host_perf_lag_invalid: maxMs' })
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

  describe('boot epoch pinning (additive)', () => {
    const BOOT_EPOCH = '0123456789abcdef'.repeat(4)

    it('verifies a pinned bootEpoch end-to-end and carries it through metadata', () => {
      const { path } = writeRealSnapshotWithIdentity({ ...IDENTITY, bootEpoch: BOOT_EPOCH })
      const read = readHostPerfSnapshotFile({
        hostPerfSnapshotPath: path,
        expectedIdentity: { ...IDENTITY, bootEpoch: BOOT_EPOCH },
        requiredChatIds: ['chat-heavy'],
        now: () => FRESH_AT
      })
      expect(read.unsupported).toBeUndefined()
      expect(read.identity).toEqual({ ...IDENTITY, bootEpoch: BOOT_EPOCH })
      const meta = read.workSpans.hostSnapshot
      expect(meta.identity.bootEpoch).toBe(BOOT_EPOCH)
      expect(meta.expectedIdentity.bootEpoch).toBe(BOOT_EPOCH)
      expect(meta.identityVerified).toBe(true)
      expect(meta.attribution).toMatchObject({ status: 'available', reason: null })
      // The epoch-carrying block is full Host evidence under the strict fold.
      const metrics: any = {}
      applyCrossThreadToMetrics(
        metrics,
        CELL,
        { host: read.workSpans },
        { requireHostAttribution: true }
      )
      expect(validateCrossThreadBlock(metrics.crossThread)).toEqual([])
    })

    it('degrades an epoch the pin does not carry: legacy diagnostics valid, strict attribution unsupported', () => {
      const { path } = writeRealSnapshotWithIdentity({ ...IDENTITY, bootEpoch: BOOT_EPOCH })
      const read = readHostPerfSnapshotFile({
        hostPerfSnapshotPath: path,
        expectedIdentity: IDENTITY,
        requiredChatIds: ['chat-heavy'],
        now: () => FRESH_AT
      })
      expect(read.unsupported).toBeUndefined()
      expect(read.eventLoopLag).toBeDefined()
      expect(read.workSpans.byChat['chat-heavy'].host_queue_wait.totalMs).toBe(120)
      const meta = read.workSpans.hostSnapshot
      expect(meta.identity.bootEpoch).toBe(BOOT_EPOCH)
      expect(meta.identityVerified).toBe(false)
      expect(meta.attribution).toMatchObject({
        status: 'unsupported',
        reason: 'boot_epoch_unpinned'
      })
      expect(() =>
        applyCrossThreadToMetrics(
          {},
          CELL,
          { host: read.workSpans },
          { requireHostAttribution: true }
        )
      ).toThrow(/pinned identity/)
      // Without the strict flag the block still validates as legacy diagnostics.
      const metrics: any = {}
      applyCrossThreadToMetrics(metrics, CELL, { host: read.workSpans })
      expect(validateCrossThreadBlock(metrics.crossThread)).toEqual([])
    })

    it('refuses a pinned bootEpoch the file lacks or carries differently', () => {
      const { path: legacyPath } = writeRealSnapshot()
      expect(
        readHostPerfSnapshotFile({
          hostPerfSnapshotPath: legacyPath,
          expectedIdentity: { ...IDENTITY, bootEpoch: BOOT_EPOCH },
          now: () => FRESH_AT
        })
      ).toEqual({ unsupported: 'host_perf_snapshot_identity_mismatch' })
      const { path: otherPath } = writeRealSnapshotWithIdentity({
        ...IDENTITY,
        bootEpoch: 'f'.repeat(64)
      })
      expect(
        readHostPerfSnapshotFile({
          hostPerfSnapshotPath: otherPath,
          expectedIdentity: { ...IDENTITY, bootEpoch: BOOT_EPOCH },
          now: () => FRESH_AT
        })
      ).toEqual({ unsupported: 'host_perf_snapshot_identity_mismatch' })
    })

    it('fails closed on a malformed bootEpoch inside the file identity', () => {
      const { path } = writeRealSnapshotWithIdentity({ ...IDENTITY, bootEpoch: BOOT_EPOCH })
      for (const bootEpoch of [
        '0123456789ABCDEF'.repeat(4), // uppercase hex
        BOOT_EPOCH.slice(0, 63), // 63 characters
        BOOT_EPOCH + '0', // 65 characters
        'g' + '0'.repeat(63), // non-hex
        42,
        null
      ]) {
        // The real writer refuses malformed epochs, so tamper the artifact.
        const artifact = JSON.parse(fs.readFileSync(path, 'utf8'))
        artifact.identity.bootEpoch = bootEpoch
        fs.writeFileSync(path, JSON.stringify(artifact))
        expect(
          readHostPerfSnapshotFile({
            hostPerfSnapshotPath: path,
            expectedIdentity: IDENTITY,
            now: () => FRESH_AT
          })
        ).toEqual({ unsupported: 'host_perf_snapshot_invalid: identity' })
      }
    })
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
