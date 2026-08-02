import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MISTRAL_QUOTA_SCHEMA_VERSION,
  MistralQuotaStore,
  configureMistralQuotaStore,
  currentMistralQuotaEstimate,
  mistralQuotaStorePath,
  recordMistralTurnCost,
  resetMistralQuotaStoreSingleton
} from './MistralQuotaStore'
import { startCycle } from './MistralQuotaEstimate'

const T0 = new Date('2026-07-01T00:00:00.000Z')
const FLUSH_MS = 4_000

let dir: string
let storagePath: string

function makeStore(options: { now?: () => Date } = {}): MistralQuotaStore {
  return new MistralQuotaStore({
    storagePath,
    now: options.now ?? (() => T0),
    flushDelayMs: FLUSH_MS
  })
}

/**
 * Fire the debounce timer and wait for the resulting write to actually land.
 * `advanceTimersByTimeAsync` runs the callback (which synchronously extends the
 * store's write chain) but cannot await real fs I/O; `flush()` on a clean store
 * awaits that chain, which makes the assertion deterministic.
 */
async function settleDebouncedWrite(store: MistralQuotaStore): Promise<void> {
  await vi.advanceTimersByTimeAsync(FLUSH_MS + 1)
  await store.flush()
}

function writeRaw(contents: string): void {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, contents, 'utf-8')
}

function readRaw(): any {
  return JSON.parse(fs.readFileSync(storagePath, 'utf-8'))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mistral-quota-'))
  storagePath = mistralQuotaStorePath(dir)
  resetMistralQuotaStoreSingleton()
})

afterEach(() => {
  vi.useRealTimers()
  resetMistralQuotaStoreSingleton()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('MistralQuotaStore — the gate', () => {
  it('reports NOTHING before the seat has ever been run', async () => {
    // This is the sidebar's gate. A user who never touches Mistral must never
    // see an estimate of a budget they are not spending.
    const store = makeStore()
    expect(await store.load()).toBeNull()
    expect(await store.currentEstimate()).toBeNull()
    expect(store.hasCycle()).toBe(false)
    expect(fs.existsSync(storagePath)).toBe(false)
  })

  it('does not conjure a file from a plan setting alone', async () => {
    const store = makeStore()
    await store.setPlan('pro')
    await store.flush()
    expect(fs.existsSync(storagePath)).toBe(false)
    expect(await store.currentEstimate()).toBeNull()
  })

  it('starts a cycle on the first observed turn', async () => {
    const store = makeStore()
    await store.recordTurnCost({ costUsd: 0.31, totalTokens: 202_146 })
    const snapshot = await store.currentEstimate()
    expect(snapshot?.turns).toBe(1)
    expect(snapshot?.totalTokens).toBe(202_146)
    expect(snapshot?.estimate.spentUsd).toBeCloseTo(0.31, 6)
    // Seeded, never presented as measured.
    expect(snapshot?.estimate.label).toContain('(estimated)')
  })
})

describe('MistralQuotaStore — debounced flush', () => {
  it('does NOT write on every turn — a burst costs one write', async () => {
    // The point of the debounce: this runs at the end of every turn, including
    // every fan-out lane. A synchronous per-turn write is the documented
    // main-process freeze.
    vi.useFakeTimers()
    const store = makeStore()
    for (let i = 0; i < 25; i++) {
      await store.recordTurnCost({ costUsd: 0.02, totalTokens: 1_000 })
    }
    // Nothing on disk yet, despite 25 turns having been accounted for.
    expect(fs.existsSync(storagePath)).toBe(false)
    expect((await store.currentEstimate())?.turns).toBe(25)

    await settleDebouncedWrite(store)
    expect(fs.existsSync(storagePath)).toBe(true)
    expect(readRaw().cycle.turns).toBe(25)
  })

  it('flushes on demand for the quit path', async () => {
    const store = makeStore()
    await store.recordTurnCost({ costUsd: 1.5, totalTokens: 10 })
    await store.flush()
    const persisted = readRaw()
    expect(persisted.version).toBe(MISTRAL_QUOTA_SCHEMA_VERSION)
    expect(persisted.cycle.spentUsd).toBeCloseTo(1.5, 6)
    expect(persisted.plan).toBe('unknown')
  })

  it('re-arms after a flush so later turns are not stranded in memory', async () => {
    vi.useFakeTimers()
    const store = makeStore()
    await store.recordTurnCost({ costUsd: 1, totalTokens: 10 })
    await settleDebouncedWrite(store)
    expect(readRaw().cycle.spentUsd).toBeCloseTo(1, 6)

    await store.recordTurnCost({ costUsd: 2, totalTokens: 10 })
    await settleDebouncedWrite(store)
    expect(readRaw().cycle.spentUsd).toBeCloseTo(3, 6)
  })

  it('persists a limit event so the learned ceiling survives a restart', async () => {
    const first = makeStore()
    await first.recordTurnCost({ costUsd: 9.4, totalTokens: 1_000 })
    await first.recordLimitEvent()
    await first.flush()

    const second = makeStore()
    const snapshot = await second.currentEstimate()
    expect(snapshot?.estimate.confidence).toBe('learned')
    expect(snapshot?.estimate.estimatedCeilingUsd).toBeCloseTo(9.4, 6)
    // A learned reading drops the hedge — it is a measurement now.
    expect(snapshot?.estimate.label).not.toContain('(estimated)')
  })

  it('round-trips the plan once a cycle exists', async () => {
    const first = makeStore()
    await first.recordTurnCost({ costUsd: 0.5, totalTokens: 10 })
    await first.setPlan('team')
    await first.flush()

    const second = makeStore()
    const snapshot = await second.currentEstimate()
    expect(snapshot?.plan).toBe('team')
    expect(snapshot?.estimate.estimatedCeilingUsd).toBeCloseTo(27.8, 6)
  })

  it('round-trips an Admin reading watermark and keeps accumulating after it', async () => {
    const first = makeStore()
    await first.recordTurnCost({ costUsd: 0.25, totalTokens: 10 })
    await first.setReport({
      spentUsd: 3,
      allowanceUsd: 30,
      fetchedAt: T0.toISOString()
    })
    await first.recordTurnCost({ costUsd: 0.5, totalTokens: 20 })
    await first.flush()

    const second = makeStore()
    const snapshot = await second.currentEstimate()
    expect(snapshot?.estimate.spentUsd).toBeCloseTo(3.5, 6)
    expect(snapshot?.estimate.locallyEstimatedSinceReadingUsd).toBeCloseTo(0.5, 6)
    expect(snapshot?.estimate.vendorReported).toBe(false)
    expect(snapshot?.totalTokens).toBe(30)
  })
})

describe('MistralQuotaStore — rollover on load', () => {
  it('rolls a stale cycle over rather than reporting last month’s burn', async () => {
    const first = makeStore()
    await first.recordTurnCost({ costUsd: 20, totalTokens: 500_000 })
    await first.flush()

    const later = new Date('2026-08-02T00:00:00.000Z')
    const second = makeStore({ now: () => later })
    const snapshot = await second.currentEstimate()
    expect(snapshot?.estimate.spentUsd).toBe(0)
    expect(snapshot?.turns).toBe(0)
    // …and the untouched cycle taught it the seed was too low.
    expect(snapshot?.estimate.estimatedCeilingUsd).toBeCloseTo(25, 6)
  })

  it('persists the rollover so the stale numbers cannot come back', async () => {
    const first = makeStore()
    await first.recordTurnCost({ costUsd: 20, totalTokens: 500_000 })
    await first.flush()

    vi.useFakeTimers()
    const later = new Date('2026-08-02T00:00:00.000Z')
    const second = makeStore({ now: () => later })
    await second.load()
    await settleDebouncedWrite(second)
    expect(readRaw().cycle.spentUsd).toBe(0)
    expect(readRaw().cycle.learnedCeilingUsd).toBeCloseTo(25, 6)
  })

  it('leaves a cycle inside its month alone', async () => {
    const first = makeStore()
    await first.recordTurnCost({ costUsd: 3, totalTokens: 10 })
    await first.flush()

    const second = makeStore({ now: () => new Date('2026-07-20T00:00:00.000Z') })
    expect((await second.currentEstimate())?.estimate.spentUsd).toBeCloseTo(3, 6)
  })
})

describe('MistralQuotaStore — corrupt-file tolerance', () => {
  it('treats unparseable JSON as absent instead of throwing', async () => {
    writeRaw('{ this is not json')
    const store = makeStore()
    expect(await store.load()).toBeNull()
    expect(await store.currentEstimate()).toBeNull()
  })

  it('discards an unknown schema version', async () => {
    writeRaw(JSON.stringify({ version: 99, plan: 'pro', cycle: startCycle(T0) }))
    expect(await makeStore().currentEstimate()).toBeNull()
  })

  it('discards a half-written cycle rather than metering from it', async () => {
    // A partial cycle would mis-band silently; starting fresh is honest and
    // self-correcting.
    writeRaw(
      JSON.stringify({
        version: MISTRAL_QUOTA_SCHEMA_VERSION,
        plan: 'pro',
        cycle: { cycleStartedAt: T0.toISOString(), spentUsd: 4 }
      })
    )
    expect(await makeStore().currentEstimate()).toBeNull()
  })

  it('discards a cycle whose timestamp is not a date', async () => {
    writeRaw(
      JSON.stringify({
        version: MISTRAL_QUOTA_SCHEMA_VERSION,
        plan: 'pro',
        cycle: { ...startCycle(T0), cycleStartedAt: 'not-a-date' }
      })
    )
    expect(await makeStore().currentEstimate()).toBeNull()
  })

  it('ignores a nonsensical persisted plan and falls back to unknown', async () => {
    writeRaw(
      JSON.stringify({
        version: MISTRAL_QUOTA_SCHEMA_VERSION,
        plan: 'enterprise-platinum',
        cycle: { ...startCycle(T0), spentUsd: 3 }
      })
    )
    const snapshot = await makeStore().currentEstimate()
    expect(snapshot?.plan).toBe('unknown')
    expect(snapshot?.estimate.estimatedCeilingUsd).toBeCloseTo(9.25, 6)
  })

  it('drops a zero/negative stored ceiling rather than banding everything exceeded', async () => {
    writeRaw(
      JSON.stringify({
        version: MISTRAL_QUOTA_SCHEMA_VERSION,
        plan: 'pro',
        cycle: { ...startCycle(T0), spentUsd: 7, learnedCeilingUsd: 0 }
      })
    )
    const snapshot = await makeStore().currentEstimate()
    expect(snapshot?.estimate.estimatedCeilingUsd).toBeCloseTo(27.8, 6)
    expect(snapshot?.estimate.band).toBe('moderate')
  })

  it('recovers by overwriting the corrupt file on the next turn', async () => {
    writeRaw('{ this is not json')
    const store = makeStore()
    await store.recordTurnCost({ costUsd: 0.75, totalTokens: 100 })
    await store.flush()
    expect(readRaw().cycle.spentUsd).toBeCloseTo(0.75, 6)
  })
})

describe('MistralQuotaStore — process singleton', () => {
  it('no-ops safely before it is configured', async () => {
    await expect(recordMistralTurnCost({ costUsd: 1, totalTokens: 1 })).resolves.toBeUndefined()
    expect(await currentMistralQuotaEstimate()).toBeNull()
  })

  it('serves the same instance to the run lane and the IPC handler', async () => {
    configureMistralQuotaStore({ storagePath, now: () => T0, flushDelayMs: FLUSH_MS })
    await recordMistralTurnCost({ costUsd: 2.5, totalTokens: 42 })
    const snapshot = await currentMistralQuotaEstimate()
    expect(snapshot?.estimate.spentUsd).toBeCloseTo(2.5, 6)
    expect(snapshot?.totalTokens).toBe(42)
  })
})
