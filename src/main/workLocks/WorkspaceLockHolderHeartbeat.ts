import { createHash } from 'node:crypto'

/**
 * Holder heartbeat sidecar for the workspace-lock authority.
 *
 * A durable lease carries no expiry (its WAL frame is hash-chained and
 * validated with exact key lists, so a lease field or a WAL frame cannot be
 * added without fail-closing every older build on the shared root). Liveness
 * evidence therefore lives beside the journal, in one small file per holder
 * under `work-lock-authority/holders/`, written every
 * {@link WORKSPACE_LOCK_HEARTBEAT_INTERVAL_MS} without an fsync and removed
 * when the authority is disposed. Older builds never read the directory.
 *
 * The heartbeat is presumptive evidence only. A reclaimer may retire a lease
 * whose owner is still alive by exact birth identity only when the holder's
 * `beatSeq` has stopped advancing for {@link WORKSPACE_LOCK_HEARTBEAT_TTL_MS}
 * of wall time AND the reclaimer has observed that same `beatSeq` for
 * {@link WORKSPACE_LOCK_RECLAIM_GRACE_MS} on its own monotonic clock. A holder
 * with no heartbeat file at all — every build that predates this sidecar — is
 * never reclaimed by lapse; only conclusive death or PID reuse retires it.
 */
export const WORKSPACE_LOCK_HEARTBEAT_SCHEMA = 'taskwraith.workspace-lock.heartbeat.v1'
export const WORKSPACE_LOCK_RECLAIM_AUDIT_SCHEMA = 'taskwraith.workspace-lock.reclaim.v1'

/** Cadence every holder writes its sidecar at. */
export const WORKSPACE_LOCK_HEARTBEAT_INTERVAL_MS = 10_000
/** Wall age of a heartbeat after which the holder counts as lapsed. */
export const WORKSPACE_LOCK_HEARTBEAT_TTL_MS = 90_000
/** Reclaimer-observed monotonic time a lapsed holder must stay lapsed. */
export const WORKSPACE_LOCK_RECLAIM_GRACE_MS = 180_000
/** Cadence of the periodic reclaim-only recovery pass. */
export const WORKSPACE_LOCK_RECOVERY_SCAN_MS = 30_000
/**
 * A gap between two consecutive scans wider than this many scan intervals is
 * treated as a suspend or a stall of the reclaimer itself: every grace window
 * restarts, because the reclaimer cannot know how much of that gap the
 * holders were awake for. On macOS the monotonic clock (libuv's
 * `mach_continuous_time`) keeps advancing through sleep, so a wall-stale
 * heartbeat on wake would otherwise satisfy the grace before the holder had
 * one interval to beat again.
 */
export const WORKSPACE_LOCK_SCAN_SUSPEND_GAP_SCANS = 2
export const WORKSPACE_LOCK_SCAN_SUSPEND_GAP_MS =
  WORKSPACE_LOCK_SCAN_SUSPEND_GAP_SCANS * WORKSPACE_LOCK_RECOVERY_SCAN_MS
/**
 * Cadence of the sweep that removes the sidecars of holders that are
 * conclusively gone. A crashed holder cannot remove its own file.
 */
export const WORKSPACE_LOCK_HOLDER_SWEEP_MS = 10 * 60_000

const NUL = String.fromCharCode(0)
const CARRIAGE_RETURN = String.fromCharCode(13)

export interface WorkspaceLockHolderKey {
  instanceId: string
  pid: number
  processBirthIdentity: string
}

export interface WorkspaceLockHolderHeartbeat extends WorkspaceLockHolderKey {
  schema: typeof WORKSPACE_LOCK_HEARTBEAT_SCHEMA
  generation: number
  /** Monotonically increasing per holder incarnation; the liveness signal. */
  beatSeq: number
  /** Holder's own monotonic clock at the beat, for its own diagnostics only. */
  monotonicMs: number
  /** Wall-clock trigger; compared against the reclaimer's wall clock for TTL. */
  beatAt: string
}

export interface WorkspaceLockHolderLapseTimings {
  ttlMs: number
  graceMs: number
  suspendGapMs: number
}

export interface WorkspaceLockHolderLapseEvidence {
  beatSeq: number
  beatAt: string
  /** Wall age of the beat as seen by the reclaimer's clock. */
  ageMs: number
  /** Reclaimer monotonic time this exact beatSeq has been observed wall-stale. */
  graceObservedMs: number
}

export type WorkspaceLockHolderLapseVerdict =
  | { state: 'absent' }
  | { state: 'fresh'; beatSeq: number; beatAt: string; ageMs: number }
  | ({ state: 'stale' } & WorkspaceLockHolderLapseEvidence)
  | ({ state: 'lapsed' } & WorkspaceLockHolderLapseEvidence)

const HEARTBEAT_KEYS = [
  'schema',
  'instanceId',
  'generation',
  'pid',
  'processBirthIdentity',
  'beatSeq',
  'monotonicMs',
  'beatAt'
] as const

const SAFE_FILENAME_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/

export function workspaceLockHolderKey(key: WorkspaceLockHolderKey): string {
  return JSON.stringify([key.instanceId, key.pid, key.processBirthIdentity])
}

/**
 * `<instanceId>.<pid>.<birth16>.json`. The instance id is used verbatim when it
 * is already a safe single path segment (production ids are `tw-instance-<hex>`)
 * and hashed otherwise; the birth digest prefix keeps one file per incarnation.
 * Readers match on the decoded record, never on the filename.
 */
export function workspaceLockHolderHeartbeatFilename(key: WorkspaceLockHolderKey): string {
  const instance = SAFE_FILENAME_SEGMENT.test(key.instanceId)
    ? key.instanceId
    : `h-${createHash('sha256').update(key.instanceId, 'utf8').digest('hex').slice(0, 32)}`
  const birth = createHash('sha256').update(key.processBirthIdentity, 'utf8').digest('hex')
  return `${instance}.${key.pid}.${birth.slice(0, 16)}.json`
}

export function encodeWorkspaceLockHolderHeartbeat(record: WorkspaceLockHolderHeartbeat): string {
  const validated = decodeWorkspaceLockHolderHeartbeat(JSON.stringify(record))
  return `${JSON.stringify(validated)}\n`
}

/** Fail-closed decoder: any missing, extra, or mistyped field is a rejection. */
export function decodeWorkspaceLockHolderHeartbeat(raw: string): WorkspaceLockHolderHeartbeat {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Workspace-lock holder heartbeat is not valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace-lock holder heartbeat must be an object.')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = [...HEARTBEAT_KEYS].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Workspace-lock holder heartbeat has an unexpected key set.')
  }
  if (record.schema !== WORKSPACE_LOCK_HEARTBEAT_SCHEMA) {
    throw new Error('Workspace-lock holder heartbeat schema is unknown.')
  }
  if (!isOpaqueId(record.instanceId)) {
    throw new Error('Workspace-lock holder heartbeat instance id is invalid.')
  }
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 0) {
    throw new Error('Workspace-lock holder heartbeat generation is invalid.')
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new Error('Workspace-lock holder heartbeat pid is invalid.')
  }
  if (!isOpaqueId(record.processBirthIdentity)) {
    throw new Error('Workspace-lock holder heartbeat process-birth identity is invalid.')
  }
  if (!Number.isSafeInteger(record.beatSeq) || (record.beatSeq as number) < 1) {
    throw new Error('Workspace-lock holder heartbeat beat sequence is invalid.')
  }
  if (typeof record.monotonicMs !== 'number' || !Number.isFinite(record.monotonicMs)) {
    throw new Error('Workspace-lock holder heartbeat monotonic clock is invalid.')
  }
  if (
    typeof record.beatAt !== 'string' ||
    !Number.isFinite(Date.parse(record.beatAt)) ||
    new Date(record.beatAt).toISOString() !== record.beatAt
  ) {
    throw new Error('Workspace-lock holder heartbeat timestamp is not canonical ISO.')
  }
  return {
    schema: WORKSPACE_LOCK_HEARTBEAT_SCHEMA,
    instanceId: record.instanceId as string,
    generation: record.generation as number,
    pid: record.pid as number,
    processBirthIdentity: record.processBirthIdentity as string,
    beatSeq: record.beatSeq as number,
    monotonicMs: record.monotonicMs,
    beatAt: record.beatAt
  }
}

interface LapseEntry {
  beatSeq: number
  /** Reclaimer monotonic clock at the first observation of this beatSeq as wall-stale. */
  firstStaleMonotonicMs: number | null
}

/**
 * Per-reclaimer lapse bookkeeping. Wall time decides whether a heartbeat is
 * stale; the reclaimer's own monotonic clock decides whether that staleness
 * has been observed for the grace window. Neither the holder's clock nor the
 * file's timestamp can shorten the grace, and a gap between scans wider than
 * `suspendGapMs` restarts every window.
 */
export class WorkspaceLockHolderLapseTracker {
  private readonly entries = new Map<string, LapseEntry>()
  private lastObservedMonotonicMs: number | null = null
  private suspendGapsObserved = 0

  constructor(
    private readonly timings: WorkspaceLockHolderLapseTimings,
    private readonly monotonicNowMs: () => number
  ) {
    for (const [label, value] of Object.entries(timings)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Workspace-lock lapse timing ${label} must be a non-negative number.`)
      }
    }
  }

  /** Number of scan gaps that reset every grace window, for diagnostics. */
  suspendGapCount(): number {
    return this.suspendGapsObserved
  }

  /**
   * Forgets every observation, including when the last scan ran. Called when
   * no lease is eligible, so the first scan after an idle stretch starts fresh
   * instead of reading the idle time as a suspend of the reclaimer.
   */
  reset(): void {
    this.entries.clear()
    this.lastObservedMonotonicMs = null
  }

  observe(input: {
    nowIso: string
    heartbeats: readonly WorkspaceLockHolderHeartbeat[]
    holders: readonly WorkspaceLockHolderKey[]
  }): Map<string, WorkspaceLockHolderLapseVerdict> {
    const now = this.monotonicNowMs()
    if (
      this.lastObservedMonotonicMs !== null &&
      now - this.lastObservedMonotonicMs > this.timings.suspendGapMs
    ) {
      this.suspendGapsObserved += 1
      for (const entry of this.entries.values()) entry.firstStaleMonotonicMs = null
    }
    this.lastObservedMonotonicMs = now
    const wallNow = Date.parse(input.nowIso)
    const byKey = new Map<string, WorkspaceLockHolderHeartbeat>()
    for (const heartbeat of input.heartbeats)
      byKey.set(workspaceLockHolderKey(heartbeat), heartbeat)

    const verdicts = new Map<string, WorkspaceLockHolderLapseVerdict>()
    const seen = new Set<string>()
    for (const holder of input.holders) {
      const key = workspaceLockHolderKey(holder)
      if (seen.has(key)) continue
      seen.add(key)
      const heartbeat = byKey.get(key)
      if (!heartbeat) {
        this.entries.delete(key)
        verdicts.set(key, { state: 'absent' })
        continue
      }
      const ageMs = wallNow - Date.parse(heartbeat.beatAt)
      let entry = this.entries.get(key)
      if (!entry || entry.beatSeq !== heartbeat.beatSeq) {
        entry = { beatSeq: heartbeat.beatSeq, firstStaleMonotonicMs: null }
        this.entries.set(key, entry)
      }
      if (!Number.isFinite(ageMs) || ageMs < this.timings.ttlMs) {
        entry.firstStaleMonotonicMs = null
        verdicts.set(key, {
          state: 'fresh',
          beatSeq: heartbeat.beatSeq,
          beatAt: heartbeat.beatAt,
          ageMs: Number.isFinite(ageMs) ? ageMs : 0
        })
        continue
      }
      if (entry.firstStaleMonotonicMs === null) entry.firstStaleMonotonicMs = now
      const graceObservedMs = now - entry.firstStaleMonotonicMs
      const evidence: WorkspaceLockHolderLapseEvidence = {
        beatSeq: heartbeat.beatSeq,
        beatAt: heartbeat.beatAt,
        ageMs,
        graceObservedMs
      }
      verdicts.set(
        key,
        graceObservedMs >= this.timings.graceMs
          ? { state: 'lapsed', ...evidence }
          : { state: 'stale', ...evidence }
      )
    }
    for (const key of [...this.entries.keys()]) {
      if (!seen.has(key)) this.entries.delete(key)
    }
    return verdicts
  }
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !(value.includes(NUL) || value.includes(CARRIAGE_RETURN) || value.includes('\n'))
  )
}
