/**
 * M1 S3 — the harness-gated read of main's work spans per measured window.
 *
 * WHY THIS EXISTS:
 * The T2 runner folds main's `workSpans` section once, after the replay, so
 * its percentiles run over every window and both paired roles at once.
 * Per-window evidence needs the raw spans that started inside each window,
 * split by lane, plus proof that ring eviction removed none of them. This
 * handle is that read. The runner evaluates it through the main inspector,
 * as it samples `__TASKWRAITH_PERF_STATS__`, so no IPC, renderer or disk
 * work joins the measured path.
 *
 * READ A WINDOW ONLY AFTER IT DRAINS, AND NAME ITS END. Every span is
 * recorded when its work completes, so a span still open at the read is
 * simply absent: `censored: false` rules out eviction, not that. Those are
 * the longest spans, so a boundary read biases p95/p99 low. Spans the
 * sampler declined, and rejected or clock-degraded spans, never enter the
 * ring either; the `ring` counters are the only evidence of them, and the
 * runner must diff them against a read taken before measurement began.
 *
 * CONTAINMENT (as the perf stats handle, `store/perfStatsHandle.ts`):
 *  1. Installed only when `PERF_PRELOAD_PROBE` is `1` or `true`. Every
 *     production build and normal launch leaves the global absent.
 *  2. No identity leaves the process. The caller names each lane by its own
 *     label and chat id and gets back that label with span timings plus the
 *     fixed-vocabulary kind, resource and reason. No chat, run, participant
 *     or lane id, no path, title or content. Admission is read down to
 *     numbers.
 *  3. Read-only: no setter, and reading never resets or windows the
 *     recorder, so the post-replay fold keeps its own basis.
 *  4. Every call builds fresh copies, and a malformed query is refused with
 *     a reason instead of throwing.
 */

import type { EnsembleHostAdmissionSnapshot } from '../services/EnsembleHostAdmissionScheduler'
import { isPerfStatsHandleEnabled } from '../store/perfStatsHandle'
import type {
  WorkSpanKind,
  WorkSpanReason,
  WorkSpanRecorder,
  WorkSpanResource
} from './WorkSpanRecorder'

/** Global name the harness evaluates. Must stay in lockstep with the runner. */
export const PERF_WORK_SPANS_GLOBAL = '__TASKWRAITH_PERF_WORK_SPANS__'

const MAX_LANES = 8
const MAX_CHAT_ID_LENGTH = 256
const LANE_LABEL = /^[a-z][a-z0-9_]{0,31}$/

/** One span as the runner sees it: when, how long, and what it waited on. */
export interface PerfWorkSpanTiming {
  kind: WorkSpanKind
  startedAt: number
  durationMs: number
  resource: WorkSpanResource
  bytes: number
  fallback: boolean
  reason?: WorkSpanReason
}

export interface PerfWorkSpanLane {
  /**
   * Spans of the lane's chat that started inside the window, in the order
   * the recorder accepted them (completion order, not start order).
   */
  spans: PerfWorkSpanTiming[]
  /** The chat's admission counts, or null when admission could not be read. */
  admission: { active: number; queued: number } | null
}

export interface PerfWorkSpanWindow {
  sampledAt: number
  sinceMs: number
  untilMs: number
  /**
   * True when the ring evicted a span that started at or after `sinceMs`:
   * the window's spans are then incomplete and its percentiles censored.
   */
  censored: boolean
  /** Recorder counters since its last reset; the runner diffs them per window. */
  ring: {
    recorded: number
    dropped: number
    sampledOut: number
    rejected: number
    degraded: number
  }
  lanes: Record<string, PerfWorkSpanLane>
  admission: {
    occupancy: Record<string, number | boolean>
    metrics: Record<string, number>
  } | null
}

export interface PerfWorkSpanRefusal {
  sampledAt: number
  refused: 'query_invalid' | 'lanes_invalid' | 'window_invalid'
}

export interface PerfWorkSpanSource {
  recorder: Pick<WorkSpanRecorder, 'readWindow'>
  admission?: () => EnsembleHostAdmissionSnapshot
  now?: () => number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The query's lanes as label → chat id, or null when any lane is malformed. */
function readLanes(value: unknown): Map<string, string> | null {
  if (!isPlainObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_LANES) return null
  const lanes = new Map<string, string>()
  const chats = new Set<string>()
  for (const [label, chatId] of entries) {
    if (!LANE_LABEL.test(label)) return null
    if (typeof chatId !== 'string' || chatId.length === 0 || chatId.length > MAX_CHAT_ID_LENGTH) {
      return null
    }
    if (chats.has(chatId)) return null
    chats.add(chatId)
    lanes.set(label, chatId)
  }
  return lanes
}

function numbersOnly<T extends object>(record: T): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

interface AdmissionRead {
  occupancy: Record<string, number | boolean>
  metrics: Record<string, number>
  byChat: Map<string, { active: number; queued: number }>
}

/**
 * The admission snapshot reduced to numbers inside one guard: a throwing
 * source, or a snapshot missing any part, reads as unavailable rather than
 * throwing out of the handle.
 */
function readAdmission(source: PerfWorkSpanSource): AdmissionRead | null {
  if (!source.admission) return null
  try {
    const snapshot = source.admission()
    const byChat = new Map<string, { active: number; queued: number }>()
    for (const entry of snapshot.byChat) {
      byChat.set(entry.chatId, {
        active: Number.isFinite(entry.active) ? entry.active : 0,
        queued: Number.isFinite(entry.queued) ? entry.queued : 0
      })
    }
    return {
      occupancy: {
        ...numbersOnly(snapshot.occupancy),
        shuttingDown: snapshot.occupancy.shuttingDown === true
      },
      metrics: numbersOnly(snapshot.metrics),
      byChat
    }
  } catch {
    return null
  }
}

interface WindowQuery {
  lanes: Map<string, string> | null
  sinceMs: unknown
  untilMs: unknown
}

/** The query's fields, or null when merely reading them throws (a getter, a Proxy). */
function readQuery(query: unknown): WindowQuery | null {
  try {
    const input = isPlainObject(query) ? query : {}
    return { lanes: readLanes(input.lanes), sinceMs: input.sinceMs, untilMs: input.untilMs }
  } catch {
    return null
  }
}

/** Build one window read; never throws. */
export function readPerfWorkSpanWindow(
  source: PerfWorkSpanSource,
  query: unknown
): PerfWorkSpanWindow | PerfWorkSpanRefusal {
  const now = source.now ?? Date.now
  const sampledAt = now()
  const input = readQuery(query)
  if (!input) return { sampledAt, refused: 'query_invalid' }
  const { lanes, sinceMs, untilMs } = input
  if (!lanes) return { sampledAt, refused: 'lanes_invalid' }
  // The end is required: a read that defaults it to "now" is a boundary read,
  // which misses every span still open (see the header).
  if (
    typeof sinceMs !== 'number' ||
    typeof untilMs !== 'number' ||
    !Number.isFinite(sinceMs) ||
    !Number.isFinite(untilMs) ||
    sinceMs < 0 ||
    untilMs < sinceMs
  ) {
    return { sampledAt, refused: 'window_invalid' }
  }

  const read = source.recorder.readWindow({ sinceMs, untilMs })
  const admission = readAdmission(source)
  const out: Record<string, PerfWorkSpanLane> = {}
  for (const [label, chatId] of lanes) {
    const spans: PerfWorkSpanTiming[] = []
    for (const span of read.spans) {
      if (span.chatId !== chatId) continue
      spans.push({
        kind: span.kind,
        startedAt: span.startedAt,
        durationMs: span.durationMs,
        resource: span.resource,
        bytes: span.bytes,
        fallback: span.fallback,
        ...(span.reason === undefined ? {} : { reason: span.reason })
      })
    }
    out[label] = {
      spans,
      admission: admission ? (admission.byChat.get(chatId) ?? { active: 0, queued: 0 }) : null
    }
  }
  return {
    sampledAt,
    sinceMs,
    untilMs,
    censored: read.evictedMaxStartedAt !== null && read.evictedMaxStartedAt >= sinceMs,
    ring: {
      recorded: read.recorded,
      dropped: read.dropped,
      sampledOut: read.sampledOut,
      rejected: read.rejected,
      degraded: read.degraded
    },
    lanes: out,
    admission: admission ? { occupancy: admission.occupancy, metrics: admission.metrics } : null
  }
}

/**
 * Install the handle over main's recorder and admission runtime when the
 * harness flag is set. Returns true when installed, so callers and tests
 * assert the gate rather than guess. Re-installing replaces the handle.
 */
export function installMainPerfWorkSpanHandle(
  recorder: Pick<WorkSpanRecorder, 'readWindow'>,
  admission: () => EnsembleHostAdmissionSnapshot,
  options: { env?: NodeJS.ProcessEnv; target?: Record<string, unknown> } = {}
): boolean {
  if (!isPerfStatsHandleEnabled(options.env ?? process.env)) return false
  const target = options.target ?? (globalThis as unknown as Record<string, unknown>)
  target[PERF_WORK_SPANS_GLOBAL] = (query: unknown) =>
    readPerfWorkSpanWindow({ recorder, admission }, query)
  return true
}
