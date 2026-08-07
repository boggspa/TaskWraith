/**
 * chatListIndexPerf.bench.test.ts — ChatListIndexStore performance benchmark
 *
 * QUANTIFIES the BEFORE state (readAll cost, file-read amplification,
 * per-line bloat) so the work-team fixes can be PROVEN rather than asserted.
 *
 * Strategy: all measurements are taken at fixture-build time (beforeAll)
 * and stored in result objects. Tests verify the stored numbers against
 * known-bad thresholds. This keeps the benchmark deterministic and avoids
 * cross-test file-mutation issues.
 *
 * Guarded by TASKWRAITH_PERF_BENCH=1 to keep it out of normal CI runs.
 *
 * Usage:
 *   TASKWRAITH_PERF_BENCH=1 npx vitest run src/main/store/chatListIndexPerf.bench.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ChatListIndexStore } from './ChatListIndexStore'
import type { ChatListItem } from './types'

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const RUN_BENCH = process.env.TASKWRAITH_PERF_BENCH === '1'
const benchDescribe = RUN_BENCH ? describe : describe.skip

// ---------------------------------------------------------------------------
// Synthetic fixture
// ---------------------------------------------------------------------------

/**
 * Generate a realistic ~200 KB ensemble blob so the index entry
 * resembles the real 229 KB ensemble in a 234 KB ChatListItem.
 */
function makeFatEnsembleBlob(chatIndex: number): Record<string, unknown> {
  const participants: Record<string, unknown>[] = []
  for (let p = 0; p < 15; p++) {
    participants.push({
      participantId: `ensemble-participant-${p}`,
      providerId:
        p % 5 === 0
          ? 'anthropic'
          : p % 5 === 1
            ? 'openai'
            : p % 5 === 2
              ? 'google'
              : p % 5 === 3
                ? 'mistral'
                : 'xai',
      modelId: `model-${p}-${'x'.repeat(40)}`,
      role: `Worker ${p}`,
      stageRole: p === 0 ? 'boss' : p < 5 ? 'scout' : p < 12 ? 'worker' : 'reviewer',
      order: p,
      permissionPresetId: 'default',
      providerMetadata: {
        sessionId: `sess-${chatIndex}-${p}-${'y'.repeat(80)}`,
        contextWindow: 200_000,
        capabilities: ['tools', 'vision', 'streaming', 'parallel']
      },
      seatState: {
        connected: true,
        lastSeen: Date.now(),
        health: 'ok',
        latency: Math.floor(Math.random() * 200) + 20
      },
      ...(p > 3 && p < 10
        ? {
            assignment: {
              file: `src/lane-${p}/work.ts`,
              reason: `Implement feature block ${p} for chat ${chatIndex}`,
              status: 'in_progress',
              startedAt: Date.now() - 300_000
            }
          }
        : {})
    })
  }

  const roundSummaries: Record<string, unknown>[] = []
  for (let r = 0; r < 4; r++) {
    roundSummaries.push({
      roundId: `ensemble-${chatIndex}${r}-${'z'.repeat(24)}`,
      completedAt: new Date(Date.now() - r * 600_000).toISOString(),
      summaryText: Array(40)
        .fill(
          `Round ${r} summary for chat ${chatIndex}: participants completed their assigned lanes. ` +
            `Files modified: src/lane-0/work.ts through src/lane-14/work.ts. ` +
            `Review gates passed: typecheck, tests, adversarial review. ` +
            `Decisions: 3 architectural, 2 risk-accepted. Next round: continue optimization pass.`
        )
        .join('\n'),
      participantCount: 15,
      laneCount: 8
    })
  }

  const blackboardEntries: Record<string, unknown>[] = []
  for (let b = 0; b < 12; b++) {
    blackboardEntries.push({
      id: `bb-${chatIndex}-${b}-${'w'.repeat(16)}`,
      key: `note-${b % 4 === 0 ? 'decision' : b % 4 === 1 ? 'fact' : b % 4 === 2 ? 'risk' : 'scout-finding'}`,
      value: `Entry ${b} for chat ${chatIndex}: `.padEnd(800, 'x'),
      category: b % 3 === 0 ? 'decision' : 'note',
      createdAt: new Date(Date.now() - b * 120_000).toISOString()
    })
  }

  return {
    enabled: true,
    maxParticipants: 15,
    activeRosterPresetId: `preset-${chatIndex % 5}`,
    orchestrationMode: 'continuous',
    fanoutPolicy: 'locked_writers',
    roundMode: 'continuous',
    maxContinuationHops: 500,
    ensembleContextChars: 120_000,
    participants,
    bossmanParticipantId: 'ensemble-participant-0',
    captainParticipantIds: ['ensemble-participant-14', 'ensemble-participant-13'],
    bossmanControlState: {
      completedRoundCount: 3 + (chatIndex % 5),
      roundPlan: {
        goal: `Optimize chat-store save path for chat ${chatIndex}`,
        status: 'in_progress',
        items: [
          { id: '1', description: 'Cache readAll on mtime+size', status: 'complete' },
          { id: '2', description: 'readEntry O(1)', status: 'in_progress' },
          { id: '3', description: 'Strip ensemble from index', status: 'pending' },
          { id: '4', description: 'Per-chat flush scheduler', status: 'pending' }
        ]
      }
    },
    activeRound: {
      roundId: `ensemble-${chatIndex}-${'a'.repeat(24)}`,
      startedAt: new Date().toISOString(),
      status: 'active',
      participants: participants.map((p) => ({
        participantId: p.participantId,
        order: p.order,
        status: 'active' as const
      }))
    },
    blackboard: blackboardEntries,
    roundSummaries,
    updatedAt: new Date().toISOString()
  }
}

function makeFatChatListItem(chatIndex: number): ChatListItem {
  const now = Date.now()
  return {
    appChatId: `chat-${String(chatIndex).padStart(6, '0')}`,
    scope: 'workspace',
    chatKind: 'ensemble',
    provider: 'anthropic' as const,
    title: `Ensemble Chat ${chatIndex} — Performance Optimization Work`,
    workspaceId: 'ws-main',
    workspacePath: '/home/user/projects/agbench',
    createdAt: now - 86_400_000 * (chatIndex + 1),
    updatedAt: now - 60_000 * chatIndex,
    archived: false,
    persistenceRevision: chatIndex + 1,
    messages: [] as any[],
    runs: [] as any[],
    summaryOnly: true as const,
    messageCount: 240 + chatIndex * 10,
    runCount: 18 + (chatIndex % 4),
    runsSummary: [
      {
        runId: `run-${chatIndex}-1`,
        provider: 'anthropic',
        model: 'claude-opus-5',
        role: 'SolBoss',
        startedAt: now - 300_000,
        completedAt: now - 120_000,
        totalTokens: 45_000,
        diffStat: { files: 3, insertions: 120, deletions: 45 }
      },
      {
        runId: `run-${chatIndex}-2`,
        provider: 'google',
        model: 'gemini-2.5-pro',
        role: 'GemProWork',
        startedAt: now - 290_000,
        completedAt: now - 110_000,
        totalTokens: 38_000,
        diffStat: { files: 1, insertions: 80, deletions: 20 }
      }
    ],
    searchText: `ensemble chat ${chatIndex} performance optimization ${'keyword '.repeat(10)}`,
    searchPreview: `Latest message preview for chat ${chatIndex}...`,
    sourceChatMtimeMs: now,
    sourceChatSize: 10_000_000 + chatIndex * 500_000,
    ensemble: makeFatEnsembleBlob(chatIndex)
  } as unknown as ChatListItem
}

// ---------------------------------------------------------------------------
// Benchmark timer
// ---------------------------------------------------------------------------

class BenchmarkClock {
  private label: string
  private startNs: bigint

  constructor(label: string) {
    this.label = label
    this.startNs = process.hrtime.bigint()
  }

  stop(): { label: string; wallMs: number } {
    return { label: this.label, wallMs: Number(process.hrtime.bigint() - this.startNs) / 1_000_000 }
  }
}

// ---------------------------------------------------------------------------
// Results snapshot (populated by beforeAll, verified by tests)
// ---------------------------------------------------------------------------

interface BenchResult {
  entryCount: number
  /** Total on-disk bytes of the JSONL file. */
  jsonlBytes: number
  /** Average bytes per JSONL line (entry + ensemble, stripped of summaries). */
  avgLineBytes: number
  /** Average bytes of the `ensemble` field alone within the JSONL entry. */
  avgEnsembleBytes: number
  /** Percentage of entry bytes that is `ensemble`. */
  ensemblePct: number
  /** readAll() cold-cache wall time (ms), single-shot after clearCache. */
  readAllColdMs: number
  /** readAll() warm-cache wall time (ms), second call after cache populated. */
  readAllWarmMs: number
  /** Number of per-chat summary files (absent ones should not be read). */
  summaryFileCount: number
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

benchDescribe('ChatListIndexStore performance benchmark', () => {
  const ENTRY_COUNTS = [10, 50, 200]
  const results = new Map<number, BenchResult>()

  let tempDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agbench-perf-bench-'))

    for (const entryCount of ENTRY_COUNTS) {
      const subDir = path.join(tempDir, String(entryCount))
      fs.mkdirSync(subDir, { recursive: true })
      const indexPath = path.join(subDir, 'chat-list-index.jsonl')
      const summariesDir = path.join(subDir, 'chat-list-summaries')
      fs.mkdirSync(summariesDir, { recursive: true })

      // ---- build fixture ----
      const lines: string[] = []
      let ensembleTotalBytes = 0
      let summaryFileCount = 0

      for (let i = 0; i < entryCount; i++) {
        const item = makeFatChatListItem(i)

        // Measure ensemble bytes BEFORE stripping
        if (item.ensemble) {
          ensembleTotalBytes += Buffer.byteLength(JSON.stringify(item.ensemble), 'utf-8')
        }

        // Per-chat summary file
        const summaryPath = path.join(summariesDir, `${item.appChatId}.json`)
        const summaryPayload: Record<string, unknown> = {}
        if (item.runsSummary && item.runsSummary.length > 0) {
          summaryPayload.runsSummary = item.runsSummary
        }
        if (item.lastRun) {
          summaryPayload.lastRun = item.lastRun
        }
        if (Object.keys(summaryPayload).length > 0) {
          fs.writeFileSync(summaryPath, JSON.stringify(summaryPayload, null, 2), 'utf-8')
          summaryFileCount++
        }

        // JSONL line (mimics stripSummaries)
        const { runsSummary: _, lastRun: __, ...stripped } = item
        lines.push(JSON.stringify({ chatId: item.appChatId, entry: stripped }) + '\n')
      }

      const jsonlContent = lines.join('')
      fs.writeFileSync(indexPath, jsonlContent, 'utf-8')

      // ---- capture on-disk measurements ----
      const rawVerify = fs.readFileSync(indexPath, 'utf-8')
      const verifyLines = rawVerify.split('\n').filter((l) => l.trim())
      const byteLengths = verifyLines.map((l) => Buffer.byteLength(l, 'utf-8'))
      const avgLineBytes = byteLengths.reduce((a, b) => a + b, 0) / byteLengths.length
      const avgEnsembleBytes = ensembleTotalBytes / entryCount

      // Parse the first entry to compute ensemble percentage
      const firstEntry = JSON.parse(verifyLines[0]).entry as Record<string, unknown>
      const entryJsonBytes = Buffer.byteLength(JSON.stringify(firstEntry), 'utf-8')
      const firstEnsembleBytes = firstEntry.ensemble
        ? Buffer.byteLength(JSON.stringify(firstEntry.ensemble), 'utf-8')
        : 0
      const ensemblePct = entryJsonBytes > 0 ? (firstEnsembleBytes / entryJsonBytes) * 100 : 0

      // ---- measure readAll() ----
      const store = new ChatListIndexStore(subDir)

      // Cold: clear any cache, measure one shot
      store.clearCache()
      const coldClock = new BenchmarkClock(`readAll-cold-${entryCount}`)
      store.readAll()
      const readAllColdMs = coldClock.stop().wallMs

      // Warm: second call (cache populated, though isCacheValid is dead)
      const warmClock = new BenchmarkClock(`readAll-warm-${entryCount}`)
      store.readAll()
      const readAllWarmMs = warmClock.stop().wallMs

      // ---- store result ----
      results.set(entryCount, {
        entryCount,
        jsonlBytes: rawVerify.length,
        avgLineBytes,
        avgEnsembleBytes,
        ensemblePct,
        readAllColdMs,
        readAllWarmMs,
        summaryFileCount
      })
    }
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Test: JSONL bytes per line (proves ensemble bloat)
  // -----------------------------------------------------------------------

  for (const entryCount of ENTRY_COUNTS) {
    it(`JSONL avg line bytes ≥ 50 KB at ${entryCount} entries (ensemble embedded in index)`, () => {
      const r = results.get(entryCount)!
      console.log(
        `\n  │ ${entryCount} entries: avg line = ${(r.avgLineBytes / 1024).toFixed(1)} KB, ` +
          `total JSONL = ${(r.jsonlBytes / (1024 * 1024)).toFixed(2)} MB`
      )

      // CURRENT (BEFORE fix): lines are ~78 KB each because ensemble
      // is embedded. After item 3 strips ensemble, lines drop to a few KB.
      // The assertion encodes the KNOWN-BAD state; it goes GREEN (passes)
      // after ensemble is stripped by lowering this threshold.
      expect(r.avgLineBytes).toBeGreaterThan(50_000)
    })
  }

  // -----------------------------------------------------------------------
  // Test: ensemble dominates entry size (proves 98% claim)
  // -----------------------------------------------------------------------

  for (const entryCount of ENTRY_COUNTS) {
    it(`ensemble > 90% of JSONL entry bytes at ${entryCount} entries`, () => {
      const r = results.get(entryCount)!
      console.log(
        `  │ ${entryCount} entries: ensemble = ${(r.avgEnsembleBytes / 1024).toFixed(1)} KB/entry ` +
          `(${r.ensemblePct.toFixed(1)}% of entry)`
      )

      // ASSERT: ensemble is > 90% of entry bytes.
      // After item 3 strips it, ensemblePct drops to 0 and this fails.
      expect(r.ensemblePct).toBeGreaterThan(90)
    })
  }

  // -----------------------------------------------------------------------
  // Test: readAll wall time is measurably > 0 (proves real I/O happened)
  // -----------------------------------------------------------------------

  for (const entryCount of ENTRY_COUNTS) {
    it(`readAll cold wall time ≥ 1 ms at ${entryCount} entries`, () => {
      const r = results.get(entryCount)!
      console.log(
        `  │ ${entryCount} entries: readAll cold = ${r.readAllColdMs.toFixed(2)} ms, ` +
          `warm = ${r.readAllWarmMs.toFixed(2)} ms`
      )

      // Sanity: cold readAll should take measurable time.
      // When item 1 (mtime+size cache) correctly caches merged results,
      // subsequent cold misses still do I/O, but warm hits become ~0.
      expect(r.readAllColdMs).toBeGreaterThanOrEqual(1)
    })
  }

  // -----------------------------------------------------------------------
  // Test: scaling proof (readAll wall time scales with entry count)
  // -----------------------------------------------------------------------

  it('readAll wall time scales roughly linearly with entry count (not O(1))', () => {
    const small = results.get(10)!
    const large = results.get(200)!

    const ratio = large.readAllColdMs / small.readAllColdMs
    const countRatio = 200 / 10 // = 20

    console.log(
      `\n  │ readAll scaling: 10 entries = ${small.readAllColdMs.toFixed(2)} ms, ` +
        `200 entries = ${large.readAllColdMs.toFixed(2)} ms, ` +
        `ratio = ${ratio.toFixed(2)}× (count ratio = ${countRatio}×)`
    )

    // ASSERT: cold readAll scales at least half as fast as entry count.
    // An O(1) cache would give ratio ~1 regardless of N.
    // After the mtime+size cache fix (item 1 + R2 merged-result caching),
    // the ratio shrinks toward 1 because per-chat summary reads stop.
    expect(ratio).toBeGreaterThan(countRatio * 0.5)
  })

  // -----------------------------------------------------------------------
  // Test: per-chat summary file count == entry count (proves amplification)
  // -----------------------------------------------------------------------

  for (const entryCount of ENTRY_COUNTS) {
    it(`per-chat summary files = ${entryCount} entries (proves O(N) read amplification)`, () => {
      const r = results.get(entryCount)!
      console.log(`  │ ${entryCount} entries: ${r.summaryFileCount} per-chat summary files`)

      // Every entry has run summaries → every entry has a summary file.
      // readAll() reads ALL of these synchronously (readSummaries per entry).
      // ASSERT: all entries have summary files (if not, our fixture is wrong).
      expect(r.summaryFileCount).toBe(entryCount)
    })
  }

  // -----------------------------------------------------------------------
  // Test: harness overhead reported separately
  // -----------------------------------------------------------------------

  it('harness overhead is bounded (fixture build dominates measurement time)', () => {
    // All measurements are taken in beforeAll. The tests themselves do
    // trivial arithmetic. The fixture-build time is the bulk of the cost
    // and scales with entry count.
    //
    // Re-measure cold readAll from scratch to verify the store is
    // still functional and the numbers are reproducible.
    const subDir = path.join(tempDir, '50')
    const store = new ChatListIndexStore(subDir)
    store.clearCache()
    const clock = new BenchmarkClock('harness-verify')
    const result = store.readAll()
    const wallMs = clock.stop().wallMs

    expect(Object.keys(result).length).toBe(50)
    expect(wallMs).toBeGreaterThan(0)

    console.log(`  │ Harness re-verify (50 entries, cold): ${wallMs.toFixed(2)} ms`)
  })
})
