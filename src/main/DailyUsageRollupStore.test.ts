import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_DAILY_USAGE_BACKFILL_ATTEMPTS,
  loadDailyUsageRollup,
  persistDailyUsageRollup,
  shouldRunDailyUsageBackfill,
  type DailyUsageRollupFile
} from './DailyUsageRollupStore'
import { DAILY_USAGE_ROLLUP_MAX_DAYS, dailyUsageDayKeyRange } from '../shared/dailyUsageRollup'

let dir = ''
let rollupPath = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'daily-usage-rollup-'))
  rollupPath = join(dir, 'daily-usage-rollup.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function file(overrides: Partial<DailyUsageRollupFile> = {}): DailyUsageRollupFile {
  return {
    updatedAt: Date.now(),
    days: { '2026-06-10': { codex: { tokens: 100, runs: 2 } } },
    backfill: null,
    ...overrides
  }
}

describe('persist / load round trip', () => {
  it('round-trips days and the backfill watermark', async () => {
    const watermark = {
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_100_000,
      lookbackDays: 400,
      attempts: 1
    }
    await persistDailyUsageRollup(rollupPath, file({ backfill: watermark }))
    const loaded = await loadDailyUsageRollup(rollupPath)
    expect(loaded?.days['2026-06-10'].codex).toEqual({ tokens: 100, runs: 2 })
    expect(loaded?.backfill).toEqual(watermark)
  })

  it.runIf(process.platform !== 'win32')('writes with owner-only permissions', async () => {
    await persistDailyUsageRollup(rollupPath, file())
    const stat = await fs.stat(rollupPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('leaves no temp file behind', async () => {
    await persistDailyUsageRollup(rollupPath, file())
    const entries = await fs.readdir(dir)
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('returns null when the file is absent', async () => {
    expect(await loadDailyUsageRollup(join(dir, 'missing.json'))).toBeNull()
  })

  it('returns null on a version mismatch rather than guessing', async () => {
    await fs.writeFile(rollupPath, JSON.stringify({ version: 99, updatedAt: 1, days: {} }))
    expect(await loadDailyUsageRollup(rollupPath)).toBeNull()
  })

  it('returns null on unparseable JSON', async () => {
    await fs.writeFile(rollupPath, '{ not json')
    expect(await loadDailyUsageRollup(rollupPath)).toBeNull()
  })

  it('clamps a future updatedAt', async () => {
    await persistDailyUsageRollup(rollupPath, file({ updatedAt: Date.now() + 86_400_000 }))
    const loaded = await loadDailyUsageRollup(rollupPath)
    expect(loaded!.updatedAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('damaged file handling', () => {
  it('drops only the malformed days and KEEPS the rest', async () => {
    // The deliberate deviation from ExternalUsageSnapshot: these days are not
    // recomputable, so one bad key must not discard a year of history.
    await fs.writeFile(
      rollupPath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        days: {
          '2026-06-10': { codex: { tokens: 100, runs: 2 } },
          'not-a-day': { codex: { tokens: 5, runs: 1 } },
          '2026-02-31': { codex: { tokens: 5, runs: 1 } },
          '2026-06-11': { codex: { tokens: 'nonsense', runs: 1 } },
          '2026-06-12': { claude: { tokens: 7, runs: 1 } }
        }
      })
    )
    const loaded = await loadDailyUsageRollup(rollupPath)
    expect(Object.keys(loaded!.days).sort()).toEqual(['2026-06-10', '2026-06-12'])
    expect(loaded!.days['2026-06-12'].claude.tokens).toBe(7)
  })

  it('drops a negative total without taking its day down', async () => {
    await fs.writeFile(
      rollupPath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        days: {
          '2026-06-10': { codex: { tokens: -5, runs: 1 }, claude: { tokens: 9, runs: 1 } }
        }
      })
    )
    const loaded = await loadDailyUsageRollup(rollupPath)
    expect(loaded!.days['2026-06-10'].codex).toBeUndefined()
    expect(loaded!.days['2026-06-10'].claude.tokens).toBe(9)
  })

  it('ignores a days object with a pathological key count', async () => {
    const days: Record<string, unknown> = {}
    for (let index = 0; index < 4_001; index += 1)
      days[`key-${index}`] = { codex: { tokens: 1, runs: 1 } }
    await fs.writeFile(rollupPath, JSON.stringify({ version: 1, updatedAt: Date.now(), days }))
    const loaded = await loadDailyUsageRollup(rollupPath)
    expect(loaded!.days).toEqual({})
  })
})

describe('retention on write', () => {
  it('prunes to the ceiling so a caller cannot grow the file without bound', async () => {
    const now = Date.now()
    const days: DailyUsageRollupFile['days'] = {}
    for (const key of dailyUsageDayKeyRange(now, DAILY_USAGE_ROLLUP_MAX_DAYS + 50)) {
      days[key] = { codex: { tokens: 1, runs: 1 } }
    }
    await persistDailyUsageRollup(rollupPath, file({ days }), now)
    const loaded = await loadDailyUsageRollup(rollupPath)
    expect(Object.keys(loaded!.days).length).toBe(DAILY_USAGE_ROLLUP_MAX_DAYS)
  })
})

describe('shouldRunDailyUsageBackfill', () => {
  it('runs on a first launch with no file', () => {
    expect(shouldRunDailyUsageBackfill(null, 400)).toBe(true)
  })

  it('runs when a rollup exists but has never been backfilled', () => {
    expect(shouldRunDailyUsageBackfill(file(), 400)).toBe(true)
  })

  it('does NOT run again once completed at the same depth', () => {
    const done = file({
      backfill: { startedAt: 1, completedAt: 2, lookbackDays: 400, attempts: 1 }
    })
    expect(shouldRunDailyUsageBackfill(done, 400)).toBe(false)
  })

  it('runs again when a deeper window is requested', () => {
    const done = file({
      backfill: { startedAt: 1, completedAt: 2, lookbackDays: 120, attempts: 1 }
    })
    expect(shouldRunDailyUsageBackfill(done, 400)).toBe(true)
  })

  it('retries an attempt that never completed', () => {
    const crashed = file({
      backfill: { startedAt: 1, completedAt: 0, lookbackDays: 400, attempts: 1 }
    })
    expect(shouldRunDailyUsageBackfill(crashed, 400)).toBe(true)
  })

  it('STOPS retrying after the attempt ceiling, completed or not', () => {
    // The guard against a wide corpus walk repeating on every launch.
    const exhausted = file({
      backfill: {
        startedAt: 1,
        completedAt: 0,
        lookbackDays: 400,
        attempts: MAX_DAILY_USAGE_BACKFILL_ATTEMPTS
      }
    })
    expect(shouldRunDailyUsageBackfill(exhausted, 400)).toBe(false)
  })

  it('keeps counting attempts across a reload so a crash loop terminates', async () => {
    let current = file({
      backfill: { startedAt: 1, completedAt: 0, lookbackDays: 400, attempts: 0 }
    })
    for (let round = 0; round < MAX_DAILY_USAGE_BACKFILL_ATTEMPTS; round += 1) {
      const loaded = await loadDailyUsageRollup(rollupPath)
      expect(shouldRunDailyUsageBackfill(loaded ?? current, 400)).toBe(true)
      // Stamp the attempt BEFORE the (here, always-crashing) walk.
      current = {
        ...current,
        backfill: {
          startedAt: Date.now(),
          completedAt: 0,
          lookbackDays: 400,
          attempts: (loaded?.backfill?.attempts ?? 0) + 1
        }
      }
      await persistDailyUsageRollup(rollupPath, current)
    }
    const finalFile = await loadDailyUsageRollup(rollupPath)
    expect(finalFile!.backfill!.attempts).toBe(MAX_DAILY_USAGE_BACKFILL_ATTEMPTS)
    expect(shouldRunDailyUsageBackfill(finalFile, 400)).toBe(false)
  })

  it('treats a watermark with attempts:0 as never attempted', () => {
    // A hand-edited or truncated watermark must not read as a completed pass.
    const zeroed = file({
      backfill: { startedAt: 0, completedAt: 0, lookbackDays: 400, attempts: 0 }
    })
    expect(shouldRunDailyUsageBackfill(zeroed, 400)).toBe(true)
  })
})
