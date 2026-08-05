/**
 * T3a persistence probes — wall-time and byte attribution for `writeJson`.
 *
 * WHY THIS EXISTS (measured, not assumed):
 * The T2 authoritative baseline (run `perf-t2-30seat-42-9977a712b741`, commit
 * 06778017e) captured a 49 MB main-process V8 CPU profile over a 9,835.7 s
 * 30-seat replay. Analysis of that profile showed:
 *
 *   - main-process busy CPU was 173 s of 9,836 s = 1.8% (98.2% idle);
 *   - `JSON.stringify` did not appear in the main profile at all;
 *   - `fsync` accounted for 0.2 s of *CPU*;
 *   - busy% *declined* across the run (2.30% -> 1.59%) while throughput fell
 *     ~5x (6.9 -> 1.41 evt/s), i.e. per-event cost rose while aggregate CPU
 *     fell, because the system self-throttles.
 *
 * A V8 sampling profiler measures CPU on the JS thread. It cannot see wall
 * time blocked inside a synchronous kernel syscall: `write`, `fsync` and
 * `rename` attribute to idle/program rather than to the calling frame. So the
 * gap between "1.8% main CPU" and "5x throughput decay" is un-attributed wall
 * time that no CPU profile can resolve.
 *
 * These probes close that gap. They are the instrument that lets a post-fix
 * comparison run report a real `metricsCollected: true` instead of the honest
 * `false` T2 had to report.
 *
 * DESIGN CONSTRAINTS:
 *  - Disabled by default. Enabled only by `PERF_PRELOAD_PROBE=1`. When
 *    disabled, `beginPersistenceWrite` returns `null` and callers do no work
 *    beyond a single null check, so production keeps its current cost.
 *  - Bounded memory. Samples are aggregated into a small fixed set of target
 *    classes; individual samples are never retained, so a 455-turn soak cannot
 *    grow this module's footprint.
 *  - No paths retained. A full path can carry a workspace name or a chat id,
 *    so paths are classified into a stable bounded vocabulary and the raw path
 *    is discarded. Nothing here is a new exfiltration surface.
 *  - Measurement only. This module never changes what is written, when it is
 *    written, or the durability barriers around it.
 */

/** Stable, bounded vocabulary of persistence targets. */
export type PersistenceTargetClass =
  | 'chat'
  // T4a: the dual-write journal is a SEPARATE class on purpose. Legacy and
  // journal bytes must not be summed into one number, or the comparison run
  // cannot tell whether the journal is paying for itself.
  | 'chat-journal'
  | 'chat-list-index'
  | 'session-checkpoints'
  | 'session-checkpoints-archive'
  | 'settings'
  | 'run-queue'
  | 'approval-ledger'
  | 'workspaces'
  | 'scheduled-tasks'
  | 'workflows'
  | 'other'

/** One completed `writeJson` call, in milliseconds and bytes. */
export interface PersistenceWriteSample {
  target: PersistenceTargetClass
  bytes: number
  serializeMs: number
  writeMs: number
  fsyncMs: number
  renameMs: number
  totalMs: number
}

/** Rolled-up totals for one target class. */
export interface PersistenceTargetStats {
  target: PersistenceTargetClass
  writes: number
  bytes: number
  serializeMs: number
  writeMs: number
  fsyncMs: number
  renameMs: number
  totalMs: number
  maxTotalMs: number
  maxBytes: number
}

export interface PersistenceProbeSnapshot {
  enabled: boolean
  writes: number
  bytes: number
  serializeMs: number
  writeMs: number
  fsyncMs: number
  renameMs: number
  totalMs: number
  targets: PersistenceTargetStats[]
}

/**
 * Phase-marking handle for a single in-flight write. Callers mark each phase
 * as it completes; `end()` commits one aggregated sample.
 */
export interface PersistenceWriteProbe {
  afterSerialize(bytes: number): void
  afterWrite(): void
  afterFsync(): void
  afterRename(): void
  end(): void
}

const PROBE_ENV_FLAG = 'PERF_PRELOAD_PROBE'

type NowFn = () => number

let nowFn: NowFn = () => Date.now()
let enabledOverride: boolean | null = null
const targets = new Map<PersistenceTargetClass, PersistenceTargetStats>()

function envEnabled(): boolean {
  const raw = process.env[PROBE_ENV_FLAG]
  return raw === '1' || raw === 'true'
}

/**
 * True when persistence probes should record. Read fresh rather than cached at
 * module load: the harness may set the flag after import, and a stale cached
 * `false` would silently produce an empty metric set that looks like a passing
 * run with nothing measured.
 */
export function isPersistenceProbeEnabled(): boolean {
  return enabledOverride === null ? envEnabled() : enabledOverride
}

/**
 * Classify a persistence path into the bounded target vocabulary.
 *
 * Chat files live at `<userData>/chats/<appChatId>.json`; the id is dropped so
 * cardinality stays at one entry for every chat rather than one per chat.
 */
export function classifyPersistenceTarget(filePath: string): PersistenceTargetClass {
  const normalized = filePath.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)

  if (base === 'chat-list-index.json') return 'chat-list-index'
  if (base === 'session-checkpoints.json') return 'session-checkpoints'
  if (base === 'session-checkpoints-archive.jsonl') return 'session-checkpoints-archive'
  if (base === 'settings.json') return 'settings'
  if (base === 'run-queue.json') return 'run-queue'
  if (base === 'approval-ledger.json') return 'approval-ledger'
  if (base === 'workspaces.json') return 'workspaces'
  if (base === 'scheduled-tasks.json') return 'scheduled-tasks'
  if (base === 'workflows.json') return 'workflows'
  if (/\/chats\/[^/]+\.json$/.test(normalized)) return 'chat'
  // Journal appends, snapshots and tombstones all live under one directory.
  // They share a class: the append/snapshot split is reported separately by
  // the journal's own stats (bytesWritten vs snapshotsWritten), so the
  // bounded target vocabulary only grows by one.
  if (/\/chat-journal\//.test(normalized)) return 'chat-journal'
  return 'other'
}

function statsFor(target: PersistenceTargetClass): PersistenceTargetStats {
  let entry = targets.get(target)
  if (!entry) {
    entry = {
      target,
      writes: 0,
      bytes: 0,
      serializeMs: 0,
      writeMs: 0,
      fsyncMs: 0,
      renameMs: 0,
      totalMs: 0,
      maxTotalMs: 0,
      maxBytes: 0
    }
    targets.set(target, entry)
  }
  return entry
}

/** Record one already-measured sample. Exported for tests and for callers that time themselves. */
export function recordPersistenceWrite(sample: PersistenceWriteSample): void {
  if (!isPersistenceProbeEnabled()) return
  const entry = statsFor(sample.target)
  entry.writes += 1
  entry.bytes += sample.bytes
  entry.serializeMs += sample.serializeMs
  entry.writeMs += sample.writeMs
  entry.fsyncMs += sample.fsyncMs
  entry.renameMs += sample.renameMs
  entry.totalMs += sample.totalMs
  if (sample.totalMs > entry.maxTotalMs) entry.maxTotalMs = sample.totalMs
  if (sample.bytes > entry.maxBytes) entry.maxBytes = sample.bytes
}

/**
 * Begin timing one `writeJson` call. Returns `null` when probes are disabled so
 * the production path pays a single null check and nothing else.
 *
 * A probe that is abandoned without `end()` — the write threw — contributes
 * nothing. A failed write is not a measurement, and silently folding partial
 * phases into the totals would understate real per-write cost.
 */
export function beginPersistenceWrite(filePath: string): PersistenceWriteProbe | null {
  if (!isPersistenceProbeEnabled()) return null

  const target = classifyPersistenceTarget(filePath)
  const started = nowFn()
  let cursor = started
  let bytes = 0
  let serializeMs = 0
  let writeMs = 0
  let fsyncMs = 0
  let renameMs = 0
  let ended = false

  const lap = (): number => {
    const at = nowFn()
    const delta = at - cursor
    cursor = at
    return delta > 0 ? delta : 0
  }

  return {
    afterSerialize(serializedBytes: number) {
      bytes = serializedBytes
      serializeMs = lap()
    },
    afterWrite() {
      writeMs = lap()
    },
    afterFsync() {
      fsyncMs = lap()
    },
    afterRename() {
      renameMs = lap()
    },
    end() {
      if (ended) return
      ended = true
      const totalMs = Math.max(0, nowFn() - started)
      recordPersistenceWrite({
        target,
        bytes,
        serializeMs,
        writeMs,
        fsyncMs,
        renameMs,
        totalMs
      })
    }
  }
}

/** Aggregated snapshot for the perf harness report. Safe to call when disabled. */
export function snapshotPersistenceProbes(): PersistenceProbeSnapshot {
  const list = [...targets.values()]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => b.bytes - a.bytes || a.target.localeCompare(b.target))

  return {
    enabled: isPersistenceProbeEnabled(),
    writes: list.reduce((sum, entry) => sum + entry.writes, 0),
    bytes: list.reduce((sum, entry) => sum + entry.bytes, 0),
    serializeMs: list.reduce((sum, entry) => sum + entry.serializeMs, 0),
    writeMs: list.reduce((sum, entry) => sum + entry.writeMs, 0),
    fsyncMs: list.reduce((sum, entry) => sum + entry.fsyncMs, 0),
    renameMs: list.reduce((sum, entry) => sum + entry.renameMs, 0),
    totalMs: list.reduce((sum, entry) => sum + entry.totalMs, 0),
    targets: list
  }
}

/** Clear accumulated counters. Used by tests and between harness phases. */
export function resetPersistenceProbes(): void {
  targets.clear()
}

/** Test seam: force enablement and supply a deterministic clock. */
export function __setPersistenceProbeTestHooks(hooks: {
  enabled?: boolean | null
  now?: NowFn | null
}): void {
  if (hooks.enabled !== undefined) enabledOverride = hooks.enabled
  if (hooks.now !== undefined) nowFn = hooks.now ?? (() => Date.now())
}
