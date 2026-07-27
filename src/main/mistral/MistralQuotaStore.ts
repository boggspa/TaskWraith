/**
 * Persistence for the Mistral seat's quota cycle.
 *
 * MistralQuotaEstimate.ts is a pure, clock-free model; this module is the half
 * that owns a file, a clock and a timer. It holds the live `MistralQuotaCycle`
 * in memory, folds each observed turn into it immediately, and lets the disk
 * copy lag behind by a debounce window.
 *
 * WHY DEBOUNCED AND ASYNC, NOT SYNCHRONOUS
 * ----------------------------------------
 * Writing this file synchronously on every turn would reproduce a documented
 * production failure in this codebase: an unbounded synchronous `writeJson` on
 * a hot path freezes the main process (see the persistence-freeze notes). The
 * quota cycle is small, but it is written on the busiest path there is — the end
 * of every Mistral turn, including every lane of a fan-out. So:
 *
 *   - accumulation is in MEMORY and O(1);
 *   - the disk write is `writeJsonAtomically` (async, temp-file + rename, the
 *     house primitive shared with the small main-owned chat patches);
 *   - writes are DEBOUNCED, so a burst of turns costs one write, and
 *     overlapping flushes are chained rather than racing.
 *
 * Losing the last few seconds of accumulation to a crash is acceptable: this is
 * an ADVISORY estimate of a budget the vendor does not publish, not an audit
 * ledger. Freezing the UI to protect a rounding error would not be.
 *
 * THE FILE'S EXISTENCE IS THE UI GATE
 * -----------------------------------
 * The sidebar meter is shown only when this store reports a cycle. No file means
 * the user has never run the seat, and a meter estimating a budget nobody is
 * spending would be noise. `persist()` is therefore a no-op until a cycle
 * actually exists — configuring a plan alone must not conjure the meter.
 *
 * No `electron` import: the path is injected (`configureMistralQuotaStore`) so
 * the whole module is unit-testable without mocking the app shell.
 */

import * as fs from 'fs'
import * as path from 'path'
import { writeJsonAtomically } from '../store/ThreadWorktreeBindingPersistence'
import {
  accumulate,
  applyAnchor,
  applyReport,
  clearAnchor,
  estimateQuota,
  recordLimitEvent,
  rolloverIfElapsed,
  startCycle,
  type MistralPlanId,
  type MistralQuotaAnchor,
  type MistralQuotaCycle,
  type MistralQuotaEstimate,
  type MistralQuotaReport
} from './MistralQuotaEstimate'

export const MISTRAL_QUOTA_SCHEMA_VERSION = 1

/**
 * Debounce window. Long enough that a fan-out's worth of lanes finishing
 * together costs one write; short enough that a quit a few seconds later still
 * catches the spend. `flushMistralQuotaStore()` exists for the quit path.
 */
export const MISTRAL_QUOTA_FLUSH_DELAY_MS = 4_000

/** On-disk shape. Versioned so a future estimator change can migrate or discard. */
interface PersistedMistralQuota {
  version: number
  plan: MistralPlanId
  cycle: MistralQuotaCycle
}

/** What the renderer's meter needs in one round trip. */
export interface MistralQuotaSnapshot {
  readonly estimate: MistralQuotaEstimate
  readonly plan: MistralPlanId
  /** Turns observed this cycle — context for how much the estimate has to go on. */
  readonly turns: number
  readonly totalTokens: number
}

/** One completed turn's contribution, as produced by `estimateMistralTokenUsage`. */
export interface MistralTurnCost {
  readonly costUsd: number
  readonly totalTokens: number
}

export interface MistralQuotaStoreOptions {
  /** Absolute path to the JSON file. Omitted ⇒ in-memory only (tests). */
  readonly storagePath?: string
  readonly now?: () => Date
  readonly flushDelayMs?: number
  readonly log?: (line: string) => void
}

/** Canonical location under the app's userData directory. */
export function mistralQuotaStorePath(userDataDir: string): string {
  return path.join(userDataDir, 'mistral', 'quota-cycle.json')
}

function isPlanId(value: unknown): value is MistralPlanId {
  return value === 'free' || value === 'pro' || value === 'team' || value === 'unknown'
}

function finiteAtLeastZero(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Structural decode. Anything that is not a complete, sane cycle is treated as
 * ABSENT rather than repaired: a half-decoded cycle would silently mis-band the
 * meter, and starting a fresh cycle is both honest and self-correcting.
 */
function decodeCycle(value: unknown): MistralQuotaCycle | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const cycleStartedAt = record.cycleStartedAt
  if (typeof cycleStartedAt !== 'string' || Number.isNaN(new Date(cycleStartedAt).getTime())) {
    return null
  }
  if (
    !finiteAtLeastZero(record.spentUsd) ||
    !finiteAtLeastZero(record.totalTokens) ||
    !finiteAtLeastZero(record.turns) ||
    typeof record.sawLimitEvent !== 'boolean'
  ) {
    return null
  }
  const learned = record.learnedCeilingUsd
  const allowance = record.knownAllowanceUsd
  return {
    cycleStartedAt,
    spentUsd: record.spentUsd,
    totalTokens: record.totalTokens,
    turns: record.turns,
    // A zero/negative stored ceiling is dropped here; estimateQuota also guards.
    ...(finiteAtLeastZero(learned) && learned > 0 ? { learnedCeilingUsd: learned } : {}),
    // Vendor knowledge that outlives the cycle. Decoded permissively: a missing
    // or malformed value just falls back to the seed, which is the pre-anchor
    // behaviour, so a partial record degrades rather than being discarded.
    ...(finiteAtLeastZero(allowance) && allowance > 0 ? { knownAllowanceUsd: allowance } : {}),
    ...(isIsoTimestamp(record.knownResetAt) ? { knownResetAt: record.knownResetAt } : {}),
    ...(decodeAnchor(record.anchor) ? { anchor: decodeAnchor(record.anchor)! } : {}),
    ...(decodeReport(record.report) ? { report: decodeReport(record.report)! } : {}),
    sawLimitEvent: record.sawLimitEvent
  }
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function decodeDeclared(value: unknown, amountKeys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.currency !== 'string' || !record.currency.trim()) return null
  for (const key of amountKeys) {
    if (!finiteAtLeastZero(record[key])) return null
  }
  return record
}

/**
 * A console reading is only usable if BOTH money figures and the watermark
 * survived. A half-decoded anchor would either lose the watermark (and so
 * double-count local spend on top of the reading) or lose the allowance (and so
 * band a real spend against a seed) — both worse than having no anchor at all.
 */
function decodeAnchor(value: unknown): MistralQuotaAnchor | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    !finiteAtLeastZero(record.allowanceUsd) ||
    !finiteAtLeastZero(record.spentUsd) ||
    !finiteAtLeastZero(record.localSpentUsdAtAnchor) ||
    !isIsoTimestamp(record.observedAt)
  ) {
    return null
  }
  const declared = decodeDeclared(record.declared, ['allowance', 'spent'])
  return {
    allowanceUsd: record.allowanceUsd,
    spentUsd: record.spentUsd,
    localSpentUsdAtAnchor: record.localSpentUsdAtAnchor,
    observedAt: record.observedAt,
    ...(isIsoTimestamp(record.cycleResetsAt) ? { cycleResetsAt: record.cycleResetsAt } : {}),
    ...(declared
      ? {
          declared: {
            allowance: declared.allowance as number,
            spent: declared.spent as number,
            currency: (declared.currency as string).trim()
          }
        }
      : {})
  }
}

function decodeReport(value: unknown): MistralQuotaReport | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!finiteAtLeastZero(record.spentUsd) || !isIsoTimestamp(record.fetchedAt)) return null
  const declared = decodeDeclared(record.declared, ['spent'])
  const allowance = record.allowanceUsd
  return {
    spentUsd: record.spentUsd,
    fetchedAt: record.fetchedAt,
    ...(finiteAtLeastZero(allowance) && allowance > 0 ? { allowanceUsd: allowance } : {}),
    ...(typeof record.periodStart === 'string' ? { periodStart: record.periodStart } : {}),
    ...(typeof record.periodEnd === 'string' ? { periodEnd: record.periodEnd } : {}),
    ...(declared
      ? {
          declared: {
            spent: declared.spent as number,
            currency: (declared.currency as string).trim()
          }
        }
      : {})
  }
}

export class MistralQuotaStore {
  private readonly storagePath?: string
  private readonly now: () => Date
  private readonly flushDelayMs: number
  private readonly log: (line: string) => void

  /** null = no cycle has ever been started (the meter stays hidden). */
  private cycle: MistralQuotaCycle | null = null
  private plan: MistralPlanId = 'unknown'
  private loaded = false
  private loading: Promise<void> | null = null

  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Serializes writes so two flushes can never interleave temp-file renames. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: MistralQuotaStoreOptions = {}) {
    this.storagePath = options.storagePath
    this.now = options.now ?? (() => new Date())
    this.flushDelayMs = Math.max(0, options.flushDelayMs ?? MISTRAL_QUOTA_FLUSH_DELAY_MS)
    this.log = options.log ?? (() => {})
  }

  /**
   * Read the persisted cycle, rolling it over if a month has elapsed so a stale
   * file reports THIS month's burn (zero) rather than last month's. Returns null
   * when the seat has never been run.
   */
  async load(): Promise<MistralQuotaCycle | null> {
    await this.ensureLoaded()
    return this.cycle
  }

  /** Fold a completed turn in. Starts the cycle on first use. */
  async recordTurnCost(turn: MistralTurnCost): Promise<void> {
    await this.ensureLoaded()
    const base = this.cycle ?? startCycle(this.now())
    this.cycle = accumulate(base, turn)
    this.markDirty()
  }

  /**
   * Record a stop believed to be the MONTHLY budget wall. The caller owns that
   * judgement — Vibe raises the same error for the per-minute throttle (see
   * MistralRateLimitPatience), and the estimator's credibility floor is only a
   * second line of defence.
   */
  async recordLimitEvent(): Promise<void> {
    await this.ensureLoaded()
    const base = this.cycle ?? startCycle(this.now())
    this.cycle = recordLimitEvent(base)
    this.markDirty()
  }

  /**
   * Which plan the user believes they are on. Persisted only once a cycle
   * exists — see the note on the UI gate at the top of this file.
   */
  async setPlan(plan: MistralPlanId): Promise<void> {
    await this.ensureLoaded()
    if (!isPlanId(plan) || plan === this.plan) return
    this.plan = plan
    if (this.cycle) this.markDirty()
  }

  /**
   * Record a console reading.
   *
   * Unlike `setPlan`, this DOES start a cycle if none exists: a user who has
   * gone to the trouble of reading their console has told us something real, and
   * refusing to store it until they happen to run a turn would throw it away.
   * The UI gate is unaffected — an anchored cycle is a cycle.
   */
  async setAnchor(reading: {
    allowanceUsd: number
    spentUsd: number
    observedAt?: string
    cycleResetsAt?: string
    declared?: MistralQuotaAnchor['declared']
  }): Promise<void> {
    await this.ensureLoaded()
    const base = this.cycle ?? startCycle(this.now())
    this.cycle = applyAnchor(base, {
      allowanceUsd: reading.allowanceUsd,
      spentUsd: reading.spentUsd,
      observedAt: reading.observedAt ?? this.now().toISOString(),
      ...(reading.cycleResetsAt ? { cycleResetsAt: reading.cycleResetsAt } : {}),
      ...(reading.declared ? { declared: reading.declared } : {})
    })
    this.markDirty()
  }

  /** Drop the console reading, returning the meter to local accumulation. */
  async clearAnchor(): Promise<void> {
    await this.ensureLoaded()
    if (!this.cycle?.anchor) return
    this.cycle = clearAnchor(this.cycle)
    this.markDirty()
  }

  /**
   * Record an Admin API answer. No-op without a cycle: unlike an anchor, a
   * report is a background fetch rather than a deliberate user action, so it
   * must not conjure a meter for a seat that has never been run.
   */
  async setReport(report: MistralQuotaReport): Promise<void> {
    await this.ensureLoaded()
    if (!this.cycle) return
    this.cycle = applyReport(this.cycle, report)
    this.markDirty()
  }

  /** The meter reading, or null when there is nothing real to show yet. */
  async currentEstimate(): Promise<MistralQuotaSnapshot | null> {
    await this.ensureLoaded()
    const cycle = this.cycle
    if (!cycle) return null
    const now = this.now()
    return {
      estimate: estimateQuota(cycle, this.plan, now),
      plan: this.plan,
      turns: cycle.turns,
      totalTokens: cycle.totalTokens
    }
  }

  /** Write any pending change now (quit path, tests). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty) {
      await this.writeChain
      return
    }
    this.dirty = false
    const payload = this.serialize()
    if (!payload) {
      await this.writeChain
      return
    }
    this.writeChain = this.writeChain.then(async () => {
      try {
        await writeJsonAtomically(payload.filePath, payload.data)
      } catch (error) {
        // A failed write must never take a turn down with it. The in-memory
        // cycle survives, and re-arming the debounce retries the WHOLE snapshot
        // (this file is always written entire, so a retry loses nothing).
        this.markDirty()
        this.log(
          `[MistralQuotaStore] persist failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
    await this.writeChain
  }

  /** True once a cycle exists — i.e. the seat has actually been run. */
  hasCycle(): boolean {
    return this.cycle !== null
  }

  private serialize(): { filePath: string; data: PersistedMistralQuota } | null {
    if (!this.storagePath || !this.cycle) return null
    return {
      filePath: this.storagePath,
      data: { version: MISTRAL_QUOTA_SCHEMA_VERSION, plan: this.plan, cycle: this.cycle }
    }
  }

  private markDirty(): void {
    this.dirty = true
    if (!this.storagePath || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.flushDelayMs)
    // Never hold the process open for a meter estimate.
    this.flushTimer.unref?.()
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loading) {
      this.loading = this.readFromDisk().finally(() => {
        this.loaded = true
        this.loading = null
      })
    }
    return this.loading
  }

  private async readFromDisk(): Promise<void> {
    if (!this.storagePath) return
    let raw: string
    try {
      raw = await fs.promises.readFile(this.storagePath, 'utf-8')
    } catch {
      // Absent file is the normal first-run state, not an error.
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.log(`[MistralQuotaStore] discarded unparseable quota file at ${this.storagePath}`)
      return
    }
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    if (!record || record.version !== MISTRAL_QUOTA_SCHEMA_VERSION) {
      this.log(`[MistralQuotaStore] discarded malformed/unknown-version quota file`)
      return
    }
    const cycle = decodeCycle(record.cycle)
    if (!cycle) {
      this.log('[MistralQuotaStore] discarded an incomplete quota cycle; starting fresh')
      return
    }
    if (isPlanId(record.plan)) this.plan = record.plan
    // Roll over on LOAD so an app opened after a month away reports this
    // month's burn, not last month's — and so the untouched-cycle ceiling
    // calibration actually happens for a user who never hits a wall.
    const rolled = rolloverIfElapsed(cycle, this.now())
    this.cycle = rolled
    if (rolled !== cycle) this.markDirty()
  }
}

// ── process-wide singleton ───────────────────────────────────────────────────
// The run lane and the IPC handler both need the same instance. Configured once
// at startup with the userData path; every accessor tolerates being called
// before that (returning nothing) rather than throwing on a cold path.

let singleton: MistralQuotaStore | null = null

export function configureMistralQuotaStore(options: MistralQuotaStoreOptions): MistralQuotaStore {
  singleton = new MistralQuotaStore(options)
  return singleton
}

export function mistralQuotaStore(): MistralQuotaStore | null {
  return singleton
}

export async function loadMistralQuotaCycle(): Promise<MistralQuotaCycle | null> {
  return (await singleton?.load()) ?? null
}

export async function recordMistralTurnCost(turn: MistralTurnCost): Promise<void> {
  await singleton?.recordTurnCost(turn)
}

export async function recordMistralLimitEvent(): Promise<void> {
  await singleton?.recordLimitEvent()
}

export async function currentMistralQuotaEstimate(): Promise<MistralQuotaSnapshot | null> {
  return (await singleton?.currentEstimate()) ?? null
}

export async function setMistralPlan(plan: MistralPlanId): Promise<void> {
  await singleton?.setPlan(plan)
}

export async function setMistralQuotaAnchor(
  reading: Parameters<MistralQuotaStore['setAnchor']>[0]
): Promise<void> {
  await singleton?.setAnchor(reading)
}

export async function clearMistralQuotaAnchor(): Promise<void> {
  await singleton?.clearAnchor()
}

export async function setMistralQuotaReport(report: MistralQuotaReport): Promise<void> {
  await singleton?.setReport(report)
}

export async function flushMistralQuotaStore(): Promise<void> {
  await singleton?.flush()
}

/** Test-only: drop the singleton so each spec starts from a clean process. */
export function resetMistralQuotaStoreSingleton(): void {
  singleton = null
}
