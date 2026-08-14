import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  DAILY_USAGE_BACKFILL_LOOKBACK_DAYS,
  recordCompletedScanInDailyRollup,
  resetDailyUsageRollupPipelineForTests,
  runDailyUsageBackfillIfNeeded,
  settleDailyUsageRollupWritesForTests,
  type DailyUsageRollupPipelineDeps
} from './DailyUsageBackfill'
import { loadDailyUsageRollup, persistDailyUsageRollup } from './DailyUsageRollupStore'
import type { DailyUsageDays } from '../shared/dailyUsageRollup'
import type { ExternalScanCompletion } from './ExternalProviderActivity'

const MS_PER_DAY = 86_400_000

let dir = ''
let deps: DailyUsageRollupPipelineDeps
let runBackfill: Mock<DailyUsageRollupPipelineDeps['runBackfill']>

beforeEach(async () => {
  resetDailyUsageRollupPipelineForTests()
  dir = await fs.mkdtemp(join(tmpdir(), 'daily-usage-backfill-'))
  runBackfill = vi.fn(async () => ({}) as DailyUsageDays)
  deps = {
    dailyRollupPath: join(dir, 'daily-usage-rollup.json'),
    backfillFileCachePath: join(dir, 'daily-usage-backfill-cache.jsonl'),
    backfillCursorCachePath: join(dir, 'daily-usage-backfill-cursor-cache.json'),
    runBackfill
  }
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function completion(overrides: Partial<ExternalScanCompletion> = {}): ExternalScanCompletion {
  return {
    records: [],
    scannedAt: Date.now(),
    lookbackDays: 90,
    ...overrides
  }
}

describe('recordCompletedScanInDailyRollup', () => {
  it('folds a completed scan into a fresh rollup', async () => {
    const scannedAt = new Date(2026, 5, 10, 18, 0, 0, 0).getTime()
    await recordCompletedScanInDailyRollup(
      completion({
        scannedAt,
        records: [
          { provider: 'codex', timestamp: scannedAt - 3_600_000, totalTokens: 500 }
        ] as never
      }),
      deps
    )
    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.days['2026-06-10'].codex.tokens).toBe(500)
  })

  it('KEEPS days the scan window could not reach', async () => {
    const scannedAt = new Date(2026, 5, 10, 18, 0, 0, 0).getTime()
    await persistDailyUsageRollup(deps.dailyRollupPath, {
      updatedAt: 1,
      days: { '2026-01-05': { codex: { tokens: 4242, runs: 3 } } },
      backfill: null
    })
    await recordCompletedScanInDailyRollup(completion({ scannedAt, lookbackDays: 90 }), deps)
    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.days['2026-01-05'].codex.tokens).toBe(4242)
  })

  it('does not double-count when the same scan folds twice', async () => {
    const scannedAt = new Date(2026, 5, 10, 18, 0, 0, 0).getTime()
    const scan = completion({
      scannedAt,
      records: [{ provider: 'codex', timestamp: scannedAt - 3_600_000, totalTokens: 500 }] as never
    })
    await recordCompletedScanInDailyRollup(scan, deps)
    await recordCompletedScanInDailyRollup(scan, deps)
    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.days['2026-06-10'].codex.tokens).toBe(500)
  })

  it('serialises concurrent folds so neither loses the other days', async () => {
    // Without the write chain both read the same empty base and the later
    // write drops the earlier one's day.
    const scannedAt = new Date(2026, 5, 10, 18, 0, 0, 0).getTime()
    await Promise.all([
      recordCompletedScanInDailyRollup(
        completion({
          scannedAt,
          records: [{ provider: 'codex', timestamp: scannedAt, totalTokens: 100 }] as never
        }),
        deps
      ),
      recordCompletedScanInDailyRollup(
        completion({
          scannedAt: scannedAt - MS_PER_DAY,
          records: [
            { provider: 'claude', timestamp: scannedAt - MS_PER_DAY, totalTokens: 200 }
          ] as never
        }),
        deps
      )
    ])
    await settleDailyUsageRollupWritesForTests()
    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.days['2026-06-10'].codex.tokens).toBe(100)
    expect(rollup!.days['2026-06-09'].claude.tokens).toBe(200)
  })
})

describe('runDailyUsageBackfillIfNeeded', () => {
  it('runs once and records the watermark', async () => {
    const ran = await runDailyUsageBackfillIfNeeded(deps)
    expect(ran).toBe(true)
    expect(runBackfill).toHaveBeenCalledTimes(1)
    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.backfill!.completedAt).toBeGreaterThan(0)
    expect(rollup!.backfill!.lookbackDays).toBe(DAILY_USAGE_BACKFILL_LOOKBACK_DAYS)
    expect(rollup!.backfill!.attempts).toBe(1)
  })

  it('NEVER walks the shared 90-day caches — only the scratch paths', async () => {
    // The anti-thrash guard. The per-file cache is pruned to the current pass's
    // window, so a wide pass sharing it would delete the narrow pass's entries
    // and the two would re-parse the corpus against each other forever.
    await runDailyUsageBackfillIfNeeded(deps)
    const options = runBackfill.mock.calls[0][0]
    expect(options.externalFileCachePath).toBe(deps.backfillFileCachePath)
    expect(options.cursorCachePath).toBe(deps.backfillCursorCachePath)
    expect(options.lookbackDays).toBe(DAILY_USAGE_BACKFILL_LOOKBACK_DAYS)
  })

  it('does not run a second time in a later process once completed', async () => {
    await runDailyUsageBackfillIfNeeded(deps)
    resetDailyUsageRollupPipelineForTests() // simulate an app restart
    const ran = await runDailyUsageBackfillIfNeeded(deps)
    expect(ran).toBe(false)
    expect(runBackfill).toHaveBeenCalledTimes(1)
  })

  it('runs at most once per process even when called concurrently', async () => {
    await Promise.all([
      runDailyUsageBackfillIfNeeded(deps),
      runDailyUsageBackfillIfNeeded(deps),
      runDailyUsageBackfillIfNeeded(deps)
    ])
    expect(runBackfill).toHaveBeenCalledTimes(1)
  })

  it('folds the backfill days in without disturbing existing days', async () => {
    const startedAt = new Date(2026, 5, 10, 12, 0, 0, 0).getTime()
    runBackfill.mockResolvedValue({
      '2026-01-05': { codex: { tokens: 4242, runs: 3 } }
    } as DailyUsageDays)
    await persistDailyUsageRollup(deps.dailyRollupPath, {
      updatedAt: 1,
      days: { '2026-06-10': { claude: { tokens: 77, runs: 1 } } },
      backfill: null
    })
    deps.now = () => startedAt
    await runDailyUsageBackfillIfNeeded(deps)
    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.days['2026-01-05'].codex.tokens).toBe(4242)
    expect(rollup!.days['2026-06-10'].claude.tokens).toBe(77)
  })

  it('deletes its scratch caches on success', async () => {
    await fs.writeFile(deps.backfillFileCachePath, 'cache')
    await fs.writeFile(deps.backfillCursorCachePath, '{}')
    await runDailyUsageBackfillIfNeeded(deps)
    await expect(fs.stat(deps.backfillFileCachePath)).rejects.toThrow()
    await expect(fs.stat(deps.backfillCursorCachePath)).rejects.toThrow()
  })

  it('deletes its scratch caches after a failure too', async () => {
    await fs.writeFile(deps.backfillFileCachePath, 'cache')
    runBackfill.mockRejectedValue(new Error('worker died'))
    await runDailyUsageBackfillIfNeeded(deps)
    await expect(fs.stat(deps.backfillFileCachePath)).rejects.toThrow()
  })

  it('resolves false and never throws when the walk fails', async () => {
    runBackfill.mockRejectedValue(new Error('worker died'))
    const onError = vi.fn()
    await expect(runDailyUsageBackfillIfNeeded({ ...deps, onError })).resolves.toBe(false)
    expect(onError).toHaveBeenCalled()
  })

  it('BURNS an attempt when the walk crashes, so a crash loop terminates', async () => {
    // The freeze guard: without the pre-walk stamp, a reliably-dying backfill
    // re-walks the whole corpus on every launch.
    runBackfill.mockRejectedValue(new Error('worker died'))
    for (let launch = 0; launch < 3; launch += 1) {
      resetDailyUsageRollupPipelineForTests()
      await runDailyUsageBackfillIfNeeded({ ...deps, onError: () => {} })
    }
    expect(runBackfill).toHaveBeenCalledTimes(3)

    resetDailyUsageRollupPipelineForTests()
    const ran = await runDailyUsageBackfillIfNeeded({ ...deps, onError: () => {} })
    expect(ran).toBe(false)
    expect(runBackfill).toHaveBeenCalledTimes(3)

    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.backfill!.attempts).toBe(3)
    expect(rollup!.backfill!.completedAt).toBe(0)
  })

  it('leaves already-folded days intact when the walk fails', async () => {
    await persistDailyUsageRollup(deps.dailyRollupPath, {
      updatedAt: 1,
      days: { '2026-06-10': { codex: { tokens: 500, runs: 2 } } },
      backfill: null
    })
    runBackfill.mockRejectedValue(new Error('worker died'))
    await runDailyUsageBackfillIfNeeded({ ...deps, onError: () => {} })
    const rollup = await loadDailyUsageRollup(deps.dailyRollupPath)
    expect(rollup!.days['2026-06-10'].codex.tokens).toBe(500)
  })
})
