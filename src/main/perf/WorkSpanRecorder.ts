/**
 * Cross-thread work-span recorder (Independent Threads Programme M1,
 * Appendix B of docs/performance/independent-threads-programme.md).
 *
 * The programme's gates need attribution, not adjectives: WHICH chat, run,
 * participant and lane paid an admission wait, a prompt build, a checkpoint
 * preparation or a Host queue wait, and on WHICH shared resource. This
 * recorder is the one span sink a process uses for that answer. It is
 * deliberately boring: begin/record/snapshot over a bounded ring, exact
 * aggregate totals per span kind and per resource, and counters for
 * everything it declined to keep. Nothing here may ever throw on the hot
 * path — malformed input is counted (`rejected`) and forgotten, a crashing
 * sampler keeps the span (fail-open), and retention overflow evicts the
 * oldest span (`dropped`) while the exact totals keep counting.
 *
 * Semantics worth pinning:
 * - Aggregate `count`/`totalMs`/`maxMs`/`bytes`/`fallbackCount` are exact
 *   over every accepted span since the last reset, including spans later
 *   evicted from the ring. `p50Ms`/`p95Ms` are nearest-rank percentiles over
 *   the retained ring sample at snapshot time; with no retained sample for a
 *   key they read 0.
 * - Sampling happens after validation and before retention AND aggregation:
 *   a sampled-out span is invisible except for `sampledOut`. The default
 *   sampler keeps everything until the current window has been offered
 *   max(DEFAULT_KEEP_ALL_MIN_WINDOW, maxRetained * 8) spans, then keeps
 *   1 in DEFAULT_SAMPLE_KEEP_EVERY, deterministically.
 * - `snapshot({ reset: true })` windows everything: ring, aggregates and all
 *   counters restart after the returned snapshot. `section` never resets.
 */

export const WORK_SPAN_PROCESSES = ['main', 'host', 'renderer'] as const
export type WorkSpanProcess = (typeof WORK_SPAN_PROCESSES)[number]

export const WORK_SPAN_KINDS = [
  'admission_wait',
  'provider_config_wait',
  'prompt_build',
  'checkpoint_prepare',
  'host_queue_wait',
  'durable_commit',
  'receipt_delivery',
  'control_response'
] as const
export type WorkSpanKind = (typeof WORK_SPAN_KINDS)[number]

export const WORK_SPAN_RESOURCES = [
  'ensemble_pool',
  'host_chain',
  'codex_daemon',
  'cursor_overlay',
  'ollama_model',
  'workspace_lock',
  'none'
] as const
export type WorkSpanResource = (typeof WORK_SPAN_RESOURCES)[number]

/** Appendix B span schema: one attributed unit of cross-thread work. */
export interface WorkSpan {
  process: WorkSpanProcess
  chatId: string
  runId: string
  participantId: string
  laneId: string
  kind: WorkSpanKind
  startedAt: number
  durationMs: number
  resource: WorkSpanResource
  bytes: number
  fallback: boolean
}

/** Attribution supplied at begin/record time; omitted identities become ''. */
export interface WorkSpanAttrs {
  chatId: string
  kind: WorkSpanKind
  runId?: string
  participantId?: string
  laneId?: string
  /** Defaults to 'none'. */
  resource?: WorkSpanResource
}

/** A pre-measured span; `process` defaults to the recorder's own process. */
export interface WorkSpanRecordInput extends WorkSpanAttrs {
  startedAt: number
  durationMs: number
  process?: WorkSpanProcess
  bytes?: number
  fallback?: boolean
}

export interface WorkSpanEndOptions {
  bytes?: number
  fallback?: boolean
}

/** Idempotent end handle; the second and later calls are no-ops. */
export type WorkSpanEnd = (options?: WorkSpanEndOptions) => void

export interface WorkSpanKeyAggregate {
  count: number
  totalMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  bytes: number
  fallbackCount: number
}

export interface WorkSpanAggregates {
  process: WorkSpanProcess
  byKind: Partial<Record<WorkSpanKind, WorkSpanKeyAggregate>>
  byResource: Partial<Record<WorkSpanResource, WorkSpanKeyAggregate>>
  /** Spans accepted (retained or since evicted) since the last reset. */
  recorded: number
  /** Spans evicted from the bounded ring by retention overflow. */
  dropped: number
  /** Spans the sampler declined; absent from aggregates entirely. */
  sampledOut: number
  /** Malformed begin/record inputs; nothing was thrown or recorded. */
  rejected: number
}

export interface WorkSpanSnapshot extends WorkSpanAggregates {
  /** Retained spans, oldest first, never more than maxRetained. */
  spans: WorkSpan[]
}

export interface WorkSpanRecorderOptions {
  process: WorkSpanProcess
  /** Ring bound for retained spans; clamped to at least 1. */
  maxRetained: number
  /**
   * Deterministic sampling seam: return false to skip a span entirely.
   * Receives normalized attrs. A throwing sampler keeps the span (fail-open).
   */
  sampler?: (attrs: Required<WorkSpanAttrs>) => boolean
  /** Clock for startedAt and durations; defaults to Date.now. */
  now?: () => number
}

export interface WorkSpanRecorder {
  /** Start a span; returns the end handle. Never throws. */
  begin(attrs: WorkSpanAttrs): WorkSpanEnd
  /** Record a pre-measured span. Never throws. */
  record(span: WorkSpanRecordInput): void
  /** Retained spans plus aggregates; `reset` windows everything after it. */
  snapshot(options?: { reset?: boolean }): WorkSpanSnapshot
  /**
   * Aggregates without the raw spans, shaped for
   * `createMainPerfInstrumentation({ sections })`: register the property
   * itself (`sections: { workSpans: recorder.section }`). MainPerfSnapshot
   * already degrades a throwing provider to `{ error }`; this one only
   * reads counters and never resets the window.
   */
  section: () => WorkSpanAggregates
}

/** Default sampler keeps everything until this many spans in one window. */
export const DEFAULT_KEEP_ALL_MIN_WINDOW = 256
/** Above the keep-all threshold the default sampler keeps 1 in this many. */
export const DEFAULT_SAMPLE_KEEP_EVERY = 8

const KIND_SET: ReadonlySet<string> = new Set(WORK_SPAN_KINDS)
const RESOURCE_SET: ReadonlySet<string> = new Set(WORK_SPAN_RESOURCES)
const PROCESS_SET: ReadonlySet<string> = new Set(WORK_SPAN_PROCESSES)

interface MutableTotals {
  count: number
  totalMs: number
  maxMs: number
  bytes: number
  fallbackCount: number
}

function optionalIdentity(value: unknown): string | null {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : null
}

function normalizeAttrs(attrs: WorkSpanAttrs): Required<WorkSpanAttrs> | null {
  if (typeof attrs !== 'object' || attrs === null) return null
  if (typeof attrs.chatId !== 'string' || attrs.chatId.length === 0) return null
  if (!KIND_SET.has(attrs.kind as string)) return null
  const runId = optionalIdentity(attrs.runId)
  const participantId = optionalIdentity(attrs.participantId)
  const laneId = optionalIdentity(attrs.laneId)
  if (runId === null || participantId === null || laneId === null) return null
  const resource = attrs.resource === undefined ? 'none' : attrs.resource
  if (!RESOURCE_SET.has(resource as string)) return null
  return { chatId: attrs.chatId, kind: attrs.kind, runId, participantId, laneId, resource }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nearestRank(sortedAscending: number[], q: number): number {
  if (sortedAscending.length === 0) return 0
  const rank = Math.ceil((q / 100) * sortedAscending.length)
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))]
}

function totalsFor<K>(totals: Map<K, MutableTotals>, key: K): MutableTotals {
  let entry = totals.get(key)
  if (!entry) {
    entry = { count: 0, totalMs: 0, maxMs: 0, bytes: 0, fallbackCount: 0 }
    totals.set(key, entry)
  }
  return entry
}

function buildKeyAggregates<K extends string>(
  totals: Map<K, MutableTotals>,
  retainedDurations: Map<K, number[]>
): Partial<Record<K, WorkSpanKeyAggregate>> {
  const out: Partial<Record<K, WorkSpanKeyAggregate>> = {}
  for (const [key, entry] of totals) {
    const durations = [...(retainedDurations.get(key) ?? [])].sort((a, b) => a - b)
    out[key] = {
      count: entry.count,
      totalMs: entry.totalMs,
      p50Ms: nearestRank(durations, 50),
      p95Ms: nearestRank(durations, 95),
      maxMs: entry.maxMs,
      bytes: entry.bytes,
      fallbackCount: entry.fallbackCount
    }
  }
  return out
}

export function createWorkSpanRecorder(options: WorkSpanRecorderOptions): WorkSpanRecorder {
  if (!PROCESS_SET.has(options.process as string)) {
    // Construction happens once at a composition root; failing fast there is
    // not a hot-path throw and surfaces the config bug where it was written.
    throw new TypeError(
      `WorkSpanRecorder process must be one of: ${WORK_SPAN_PROCESSES.join(', ')}`
    )
  }
  const maxRetained = finiteNonNegative(options.maxRetained)
    ? Math.max(1, Math.floor(options.maxRetained))
    : DEFAULT_KEEP_ALL_MIN_WINDOW
  const now = options.now ?? (() => Date.now())
  const keepAllBelow = Math.max(DEFAULT_KEEP_ALL_MIN_WINDOW, maxRetained * 8)

  let ring: WorkSpan[] = []
  let ringCursor = 0
  let byKind = new Map<WorkSpanKind, MutableTotals>()
  let byResource = new Map<WorkSpanResource, MutableTotals>()
  let recorded = 0
  let dropped = 0
  let sampledOut = 0
  let rejected = 0
  let windowOffered = 0

  const defaultSampler = (): boolean =>
    windowOffered <= keepAllBelow || windowOffered % DEFAULT_SAMPLE_KEEP_EVERY === 1
  const sampler = options.sampler ?? defaultSampler

  const shouldKeep = (attrs: Required<WorkSpanAttrs>): boolean => {
    windowOffered += 1
    try {
      return sampler(attrs) !== false
    } catch {
      // Sampling is an optimization; a broken sampler must not lose spans.
      return true
    }
  }

  const accept = (span: WorkSpan): void => {
    recorded += 1
    for (const totals of [totalsFor(byKind, span.kind), totalsFor(byResource, span.resource)]) {
      totals.count += 1
      totals.totalMs += span.durationMs
      totals.maxMs = Math.max(totals.maxMs, span.durationMs)
      totals.bytes += span.bytes
      if (span.fallback) totals.fallbackCount += 1
    }
    if (ring.length < maxRetained) {
      ring.push(span)
    } else {
      ring[ringCursor] = span
      ringCursor = (ringCursor + 1) % maxRetained
      dropped += 1
    }
  }

  const begin = (attrs: WorkSpanAttrs): WorkSpanEnd => {
    const normalized = normalizeAttrs(attrs)
    if (!normalized) {
      rejected += 1
      return () => {}
    }
    if (!shouldKeep(normalized)) {
      sampledOut += 1
      return () => {}
    }
    const startedAt = now()
    let ended = false
    return (endOptions?: WorkSpanEndOptions) => {
      if (ended) return
      ended = true
      const bytes = endOptions?.bytes
      accept({
        process: options.process,
        ...normalized,
        startedAt,
        durationMs: Math.max(0, now() - startedAt),
        // End decorations are coerced, not rejected: the measured wait is the
        // valuable part and this path must never throw.
        bytes: finiteNonNegative(bytes) ? bytes : 0,
        fallback: endOptions?.fallback === true
      })
    }
  }

  const record = (span: WorkSpanRecordInput): void => {
    const normalized = normalizeAttrs(span)
    if (
      !normalized ||
      !finiteNonNegative(span.startedAt) ||
      !finiteNonNegative(span.durationMs) ||
      (span.process !== undefined && !PROCESS_SET.has(span.process as string)) ||
      (span.bytes !== undefined && !finiteNonNegative(span.bytes)) ||
      (span.fallback !== undefined && typeof span.fallback !== 'boolean')
    ) {
      rejected += 1
      return
    }
    if (!shouldKeep(normalized)) {
      sampledOut += 1
      return
    }
    accept({
      process: span.process ?? options.process,
      ...normalized,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      bytes: span.bytes ?? 0,
      fallback: span.fallback === true
    })
  }

  const orderedRing = (): WorkSpan[] =>
    ring.length < maxRetained || ringCursor === 0
      ? ring.slice()
      : [...ring.slice(ringCursor), ...ring.slice(0, ringCursor)]

  const collectAggregates = (): WorkSpanAggregates => {
    const kindDurations = new Map<WorkSpanKind, number[]>()
    const resourceDurations = new Map<WorkSpanResource, number[]>()
    for (const span of orderedRing()) {
      let byKindDurations = kindDurations.get(span.kind)
      if (!byKindDurations) kindDurations.set(span.kind, (byKindDurations = []))
      byKindDurations.push(span.durationMs)
      let byResourceDurations = resourceDurations.get(span.resource)
      if (!byResourceDurations) resourceDurations.set(span.resource, (byResourceDurations = []))
      byResourceDurations.push(span.durationMs)
    }
    return {
      process: options.process,
      byKind: buildKeyAggregates(byKind, kindDurations),
      byResource: buildKeyAggregates(byResource, resourceDurations),
      recorded,
      dropped,
      sampledOut,
      rejected
    }
  }

  const reset = (): void => {
    ring = []
    ringCursor = 0
    byKind = new Map()
    byResource = new Map()
    recorded = 0
    dropped = 0
    sampledOut = 0
    rejected = 0
    windowOffered = 0
  }

  const snapshot = (snapshotOptions?: { reset?: boolean }): WorkSpanSnapshot => {
    const result: WorkSpanSnapshot = { ...collectAggregates(), spans: orderedRing() }
    if (snapshotOptions?.reset) reset()
    return result
  }

  const section = (): WorkSpanAggregates => collectAggregates()

  return { begin, record, snapshot, section }
}
