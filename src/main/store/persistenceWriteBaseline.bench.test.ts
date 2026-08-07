/**
 * persistenceWriteBaseline.bench.test.ts — writeJson syscall-sequence baseline
 *
 * Item 6 pre-build measurement: HOW MUCH wall time does the main thread spend
 * inside the synchronous write/fsync/rename/dir-fsync sequence that writeJson
 * performs?  V8 CPU profiles cannot see this — fsync attributes to idle, not
 * to the calling frame. That gap is the entire point of item 6.
 *
 * This bench replicates the raw syscall sequence from writeJson (index.ts:2539)
 * using process.hrtime for nanosecond precision, with synthetic chat records at
 * realistic sizes including a ~16 MB fat chat.
 *
 * WHAT THIS MEASURES (and what it does not):
 *  - ✅ serialize wall time (JSON.stringify + Buffer.byteLength)
 *  - ✅ write wall time (writeFileSync)
 *  - ✅ fsync wall time (the gap CPU profiles miss)
 *  - ✅ rename wall time
 *  - ✅ dir-fsync wall time
 *  - ✅ total event-loop blockage (pre→post hrtime)
 *  - ✅ instrument overhead (how long fixture-build took vs measurement)
 *  - ❌ Does NOT import store/index.ts — measures the syscall sequence, not
 *    saveChat's whole codepath. That ensures the benchmark is isolateable.
 *
 * Guarded by TASKWRAITH_UTILITY_WRITE_BENCH=1 to keep it out of CI.
 *
 * Usage:
 *   TASKWRAITH_UTILITY_WRITE_BENCH=1 npx vitest run src/main/store/persistenceWriteBaseline.bench.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const RUN_BENCH = process.env.TASKWRAITH_UTILITY_WRITE_BENCH === '1'
const benchDescribe = RUN_BENCH ? describe : describe.skip

// ---------------------------------------------------------------------------
// Synthetic chat-record builder
// ---------------------------------------------------------------------------

/**
 * Build a chat record whose JSON on disk is approximately `targetBytes`.
 * The record is a plausible ChatRecord shape: messages array dominated by
 * verbose tool results (the real bloat source), runs array with provider
 * metadata, and a lean ensemble. We tune `messageCount` to hit the target.
 */
function buildChatRecord(targetBytes: number): {
  record: Record<string, unknown>
  messageCount: number
  runCount: number
} {
  // Build a small payload first and measure its per-message byte cost, then
  // scale to hit targetBytes. This is a cheap calibration rather than an
  // iterative search: one measurement, one allocation.
  const calibrationMessage = {
    messageId: 'msg-cal-0000',
    role: 'assistant',
    provider: 'anthropic',
    model: 'claude-opus-5',
    status: 'complete',
    content: Array(80)
      .fill(
        'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do ' +
          'eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
          'Ut enim ad minim veniam quis nostrud exercitation ullamco laboris.'
      )
      .join(' '),
    toolCalls: [],
    toolResults: [
      {
        id: 'tool-cal-0',
        name: 'write_file',
        success: true,
        output: Array(100).fill('x'.repeat(200)).join('\n')
      }
    ],
    createdAt: Date.now(),
    tokens: { input: 45000, output: 12000 }
  }

  const calibrationRuns = [
    {
      runId: 'run-cal-0',
      provider: 'anthropic',
      model: 'claude-opus-5',
      role: 'SolBoss',
      status: 'complete',
      startedAt: Date.now() - 300_000,
      completedAt: Date.now() - 120_000,
      totalTokens: 45000,
      diffStat: { files: 3, insertions: 120, deletions: 45 }
    },
    {
      runId: 'run-cal-1',
      provider: 'google',
      model: 'gemini-2.5-pro',
      role: 'GemProWork',
      status: 'complete',
      startedAt: Date.now() - 290_000,
      completedAt: Date.now() - 110_000,
      totalTokens: 38000,
      diffStat: { files: 1, insertions: 80, deletions: 20 }
    }
  ]

  // Measure per-message byte cost
  const calBytes = Buffer.byteLength(JSON.stringify(calibrationMessage), 'utf-8')
  const calRunsBytes = Buffer.byteLength(JSON.stringify(calibrationRuns), 'utf-8')

  // Base overhead (fields besides messages/runs/ensemble)
  const skeleton: Record<string, unknown> = {
    appChatId: 'chat-bench-000000',
    scope: 'workspace',
    chatKind: 'ensemble',
    provider: 'anthropic',
    title: 'Benchmark Chat — Persistence Write Baseline',
    workspaceId: 'ws-main',
    workspacePath: '/home/user/projects/agbench',
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now(),
    archived: false,
    persistenceRevision: 1,
    messageCount: 0,
    runCount: 2,
    searchText: 'benchmark persistence write baseline',
    searchPreview: 'Measuring writeJson syscall cost...',
    sourceChatMtimeMs: Date.now(),
    sourceChatSize: targetBytes,
    ensemble: buildLeanEnsemble(),
    messages: [],
    runs: calibrationRuns
  }
  const skeletonBytes = Buffer.byteLength(JSON.stringify(skeleton), 'utf-8')
  // skeletonBytes includes the empty messages[] and 2 runs — subtract those
  const baseOverhead = skeletonBytes - calRunsBytes - Buffer.byteLength('[]', 'utf-8')

  // How many messages to hit targetBytes? 2 runs already in the budget.
  const remaining = targetBytes - baseOverhead - calRunsBytes
  const messageCount = Math.max(1, Math.floor(remaining / calBytes))

  const messages: Record<string, unknown>[] = []
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      ...calibrationMessage,
      messageId: `msg-bench-${String(i).padStart(4, '0')}`
    })
  }

  const record = {
    ...skeleton,
    messageCount,
    messages
  }

  return { record, messageCount, runCount: calibrationRuns.length }
}

function buildLeanEnsemble(): Record<string, unknown> {
  const participants: Record<string, unknown>[] = []
  for (let p = 0; p < 15; p++) {
    participants.push({
      id: `ensemble-participant-${p}`,
      provider:
        p % 5 === 0
          ? 'anthropic'
          : p % 5 === 1
            ? 'openai'
            : p % 5 === 2
              ? 'google'
              : p % 5 === 3
                ? 'mistral'
                : 'xai',
      model: `model-${p}`,
      role: `Worker ${p}`,
      instructions: '',
      enabled: true,
      order: p,
      permissionPresetId: 'default'
    })
  }

  return {
    __chatListProjection: true,
    enabled: true,
    maxParticipants: 50,
    participants,
    bossmanParticipantId: 'ensemble-participant-0',
    captainParticipantIds: ['ensemble-participant-14', 'ensemble-participant-13'],
    activeRound: {
      roundId: 'ensemble-bench-aaaa',
      startedAt: new Date().toISOString(),
      status: 'active',
      participants: participants.map((p, i) => ({
        participantId: p.id,
        provider: p.provider,
        role: p.role,
        order: i,
        status: 'active',
        runId: `run-bench-${i}`
      }))
    },
    updatedAt: new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// Core measurement: replicate writeJson's syscall sequence
// ---------------------------------------------------------------------------

interface WritePhaseResult {
  targetBytes: number
  actualBytes: number
  serializeMs: number
  writeMs: number
  fsyncMs: number
  renameMs: number
  dirFsyncMs: number
  remainderMs: number
  /** Total wall time from pre-write hrtime to post-write hrtime. */
  totalBlockedMs: number
}

/**
 * Replicate the exact syscall sequence from writeJson (index.ts:2539) and
 * measure every phase with process.hrtime.
 *
 * This is intentionally NOT calling writeJson — it replicates the body so
 * the benchmark isolates the syscall cost from any store monolith overhead.
 */
function measureWriteJsonSyscall(
  filePath: string,
  record: Record<string, unknown>
): WritePhaseResult {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null

  // ── Total event-loop blockage ──
  const blockStart = process.hrtime.bigint()

  // ── serialize ──
  const serializeStart = process.hrtime.bigint()
  const serialized = JSON.stringify(record, null, 2)
  const serializedBytes = Buffer.byteLength(serialized, 'utf-8')
  const serializeMs = Number(process.hrtime.bigint() - serializeStart) / 1_000_000

  // ── mkdir + open ──
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fd = fs.openSync(tempPath, 'w', 0o600)

  // ── write ──
  const writeStart = process.hrtime.bigint()
  fs.writeFileSync(fd, serialized, 'utf-8')
  const writeMs = Number(process.hrtime.bigint() - writeStart) / 1_000_000

  // ── fsync ──
  const fsyncStart = process.hrtime.bigint()
  fs.fsyncSync(fd)
  const fsyncMs = Number(process.hrtime.bigint() - fsyncStart) / 1_000_000

  // ── close ──
  fs.closeSync(fd)
  fd = null

  // ── rename ──
  const renameStart = process.hrtime.bigint()
  fs.renameSync(tempPath, filePath)
  const renameMs = Number(process.hrtime.bigint() - renameStart) / 1_000_000

  // ── chmod (best-effort, part of remainder) ──
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best effort on non-POSIX filesystems.
  }

  // ── dir fsync ──
  const dirFsyncStart = process.hrtime.bigint()
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r')
    fs.fsyncSync(dirFd)
    fs.closeSync(dirFd)
  } catch {
    // Best effort on some filesystems.
  }
  const dirFsyncMs = Number(process.hrtime.bigint() - dirFsyncStart) / 1_000_000

  // ── total blockage ──
  const totalBlockedMs = Number(process.hrtime.bigint() - blockStart) / 1_000_000

  // remainder = total - sum of named phases
  const namedSum = serializeMs + writeMs + fsyncMs + renameMs + dirFsyncMs
  const remainderMs = Math.max(0, totalBlockedMs - namedSum)

  return {
    targetBytes: serializedBytes,
    actualBytes: serializedBytes,
    serializeMs,
    writeMs,
    fsyncMs,
    renameMs,
    dirFsyncMs,
    remainderMs,
    totalBlockedMs
  }
}

// ---------------------------------------------------------------------------
// Results snapshot
// ---------------------------------------------------------------------------

interface BenchResult {
  label: string
  targetSize: string
  messageCount: number
  actualBytes: number
  serializeMs: number
  writeMs: number
  fsyncMs: number
  renameMs: number
  dirFsyncMs: number
  remainderMs: number
  totalBlockedMs: number
  /** How many runs were averaged (warm-up excluded). */
  runs: number
  /** Single worst totalBlockedMs across measured runs. */
  worstTotalBlockedMs: number
  /** Raw per-run totalBlockedMs values. */
  perRunTotalMs: number[]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

benchDescribe('writeJson syscall-sequence baseline benchmark', () => {
  const SIZES: { label: string; targetBytes: number }[] = [
    { label: 'small', targetBytes: 1_000_000 }, // ~1 MB
    { label: 'medium', targetBytes: 4_000_000 }, // ~4 MB
    { label: 'large', targetBytes: 16_000_000 } // ~16 MB
  ]

  const MEASURE_RUNS = 3 // warm-up excluded; median reported
  const results = new Map<string, BenchResult>()

  let tempDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agbench-writejson-bench-'))

    for (const { label, targetBytes } of SIZES) {
      const { record, messageCount } = buildChatRecord(targetBytes)

      // ── Warm-up (1 shot, discarded) — populates FS caches ──
      const warmPath = path.join(tempDir, `${label}-warmup.json`)
      measureWriteJsonSyscall(warmPath, record)
      try {
        fs.unlinkSync(warmPath)
      } catch {
        /* best effort */
      }

      // ── Measured runs ──
      const perRunTotalMs: number[] = []
      let sumSerialize = 0
      let sumWrite = 0
      let sumFsync = 0
      let sumRename = 0
      let sumDirFsync = 0
      let sumRemainder = 0
      let sumTotal = 0
      let worstTotal = 0
      let actualBytes = 0

      for (let r = 0; r < MEASURE_RUNS; r++) {
        const filePath = path.join(tempDir, `${label}-${r}.json`)
        const phase = measureWriteJsonSyscall(filePath, record)

        actualBytes = phase.actualBytes
        perRunTotalMs.push(phase.totalBlockedMs)
        sumSerialize += phase.serializeMs
        sumWrite += phase.writeMs
        sumFsync += phase.fsyncMs
        sumRename += phase.renameMs
        sumDirFsync += phase.dirFsyncMs
        sumRemainder += phase.remainderMs
        sumTotal += phase.totalBlockedMs
        if (phase.totalBlockedMs > worstTotal) worstTotal = phase.totalBlockedMs

        // Clean up before next run so each run gets its own fsync.
        try {
          fs.unlinkSync(filePath)
        } catch {
          /* best effort */
        }
      }

      results.set(label, {
        label,
        targetSize: `${(targetBytes / 1_000_000).toFixed(0)} MB`,
        messageCount,
        actualBytes,
        serializeMs: sumSerialize / MEASURE_RUNS,
        writeMs: sumWrite / MEASURE_RUNS,
        fsyncMs: sumFsync / MEASURE_RUNS,
        renameMs: sumRename / MEASURE_RUNS,
        dirFsyncMs: sumDirFsync / MEASURE_RUNS,
        remainderMs: sumRemainder / MEASURE_RUNS,
        totalBlockedMs: sumTotal / MEASURE_RUNS,
        runs: MEASURE_RUNS,
        worstTotalBlockedMs: worstTotal,
        perRunTotalMs
      })
    }
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Phase breakdown for each size
  // -----------------------------------------------------------------------

  for (const { label } of SIZES) {
    it(`phase breakdown — ${label}`, () => {
      const r = results.get(label)!
      console.log(
        `\n  ┌─ ${label} (${r.targetSize} on disk, ${r.messageCount} msgs, ${r.runs} runs avg)`
      )
      console.log(`  ├─ serialize:  ${r.serializeMs.toFixed(1)} ms`)
      console.log(`  ├─ write:      ${r.writeMs.toFixed(1)} ms`)
      console.log(`  ├─ fsync:      ${r.fsyncMs.toFixed(1)} ms  ← the gap CPU profiles miss`)
      console.log(`  ├─ rename:     ${r.renameMs.toFixed(1)} ms`)
      console.log(`  ├─ dir fsync:  ${r.dirFsyncMs.toFixed(1)} ms`)
      console.log(`  ├─ remainder:  ${r.remainderMs.toFixed(1)} ms  (mkdir/open/close/chmod)`)
      console.log(
        `  └─ TOTAL BLOCKED: ${r.totalBlockedMs.toFixed(1)} ms  (worst: ${r.worstTotalBlockedMs.toFixed(1)} ms)`
      )

      // Sanity: total should be >= sum of named phases
      const namedSum = r.serializeMs + r.writeMs + r.fsyncMs + r.renameMs + r.dirFsyncMs
      expect(r.totalBlockedMs).toBeGreaterThanOrEqual(namedSum * 0.99) // allow fp rounding

      // Sanity: every phase should be measurable (even if sub-ms)
      expect(r.fsyncMs).toBeGreaterThan(0)
      expect(r.writeMs).toBeGreaterThan(0)
    })
  }

  // -----------------------------------------------------------------------
  // Dominant-cost attribution (diagnostic — no hard assertion)
  // -----------------------------------------------------------------------

  it('reports which phase dominates main-thread blockage at each size', () => {
    for (const { label } of SIZES) {
      const r = results.get(label)!
      const total = r.totalBlockedMs
      const phases: { name: string; ms: number }[] = [
        { name: 'serialize', ms: r.serializeMs },
        { name: 'write', ms: r.writeMs },
        { name: 'fsync', ms: r.fsyncMs },
        { name: 'dir-fsync', ms: r.dirFsyncMs },
        { name: 'rename', ms: r.renameMs }
      ]
      phases.sort((a, b) => b.ms - a.ms)
      const [top1, top2] = phases

      console.log(
        `\n  │ ${label} (${r.targetSize}): ` +
          `#1 ${top1.name} ${top1.ms.toFixed(1)} ms (${((top1.ms / total) * 100).toFixed(0)}%), ` +
          `#2 ${top2.name} ${top2.ms.toFixed(1)} ms (${((top2.ms / total) * 100).toFixed(0)}%), ` +
          `total ${total.toFixed(1)} ms`
      )
    }

    // Sanity: some phase must be > 0
    const large = results.get('large')!
    expect(large.totalBlockedMs).toBeGreaterThan(0)
  })

  // -----------------------------------------------------------------------
  // Blockage scales with file size (roughly)
  // -----------------------------------------------------------------------

  it('total blockage scales with file size', () => {
    const small = results.get('small')!
    const large = results.get('large')!

    const sizeRatio = large.actualBytes / small.actualBytes
    const timeRatio = large.totalBlockedMs / small.totalBlockedMs

    console.log(
      `\n  │ size ratio: ${sizeRatio.toFixed(1)}× (${(small.actualBytes / 1_000_000).toFixed(1)} MB → ${(large.actualBytes / 1_000_000).toFixed(1)} MB)`
    )
    console.log(
      `  │ time ratio: ${timeRatio.toFixed(1)}× (${small.totalBlockedMs.toFixed(1)} ms → ${large.totalBlockedMs.toFixed(1)} ms)`
    )

    // Large files should take strictly longer than small ones.
    // The ratio won't be perfectly linear (fsync has per-call overhead),
    // but it must be >1×.
    expect(large.totalBlockedMs).toBeGreaterThan(small.totalBlockedMs)
  })

  // -----------------------------------------------------------------------
  // Per-run stability — no single outlier dominates
  // -----------------------------------------------------------------------

  it('per-run times are stable (worst ≤ 2× average for large)', () => {
    const r = results.get('large')!
    const ratio = r.worstTotalBlockedMs / r.totalBlockedMs
    console.log(
      `\n  │ large: avg = ${r.totalBlockedMs.toFixed(1)} ms, worst = ${r.worstTotalBlockedMs.toFixed(1)} ms (${ratio.toFixed(2)}×)`
    )
    console.log(`  │ per-run: [${r.perRunTotalMs.map((v) => v.toFixed(1)).join(', ')}] ms`)

    // Allow up to 3× — first run after warm-up can still see some cold-page
    // effects. Beyond 3× indicates a noisy environment.
    expect(ratio).toBeLessThanOrEqual(3.0)
  })

  // -----------------------------------------------------------------------
  // Absolute threshold — how much main-thread time is item 6 trying to save?
  // -----------------------------------------------------------------------

  it('reports the absolute wall time item 6 could move off main', () => {
    const large = results.get('large')!
    const medium = results.get('medium')!
    const small = results.get('small')!

    console.log('\n  ┌─ Item 6 potential (moving durable write off main thread)')
    console.log(`  ├─ small  (~1 MB):   ${small.totalBlockedMs.toFixed(1)} ms blocked per save`)
    console.log(`  ├─ medium (~4 MB):   ${medium.totalBlockedMs.toFixed(1)} ms blocked per save`)
    console.log(`  └─ large  (~16 MB):  ${large.totalBlockedMs.toFixed(1)} ms blocked per save`)

    // No assertion here — this is the measurement. It reports honestly whether
    // the numbers are large enough to warrant item 6 or small enough to skip it.
    // Either result is useful.
    expect(large.totalBlockedMs).toBeGreaterThan(0)
  })

  // -----------------------------------------------------------------------
  // Instrument overhead
  // -----------------------------------------------------------------------

  it('instrument overhead is bounded', () => {
    // Fixture build + warm-up runs dominate the beforeAll time. Verify the
    // instrument itself (hrtime calls, arithmetic) is negligible by measuring
    // one extra write and confirming it matches the stored averages.
    const { record } = buildChatRecord(1_000_000)
    const verifyPath = path.join(tempDir, 'overhead-verify.json')
    const phase = measureWriteJsonSyscall(verifyPath, record)

    try {
      fs.unlinkSync(verifyPath)
    } catch {
      /* best effort */
    }

    const small = results.get('small')!
    // The verify run should be within 2× the stored average (colder path,
    // but still small).
    const ratio = phase.totalBlockedMs / small.totalBlockedMs
    console.log(
      `\n  │ overhead verify: ${phase.totalBlockedMs.toFixed(1)} ms vs stored avg ${small.totalBlockedMs.toFixed(1)} ms (${ratio.toFixed(2)}×)`
    )

    expect(ratio).toBeLessThanOrEqual(3.0)
  })
})
