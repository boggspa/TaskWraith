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
 * sampler keeps the span (fail-open), a crashing or non-finite injected
 * clock abandons only the measurement (`degraded`), and retention overflow
 * evicts the oldest span (`dropped`) while the exact totals keep counting.
 * The application work being measured never fails because its diagnostic
 * did.
 *
 * Placement: the implementation lives in src/host-shared so the standalone
 * Host runtime (which imports nothing from src/main) can construct its own
 * recorder for HostPerfSnapshot; src/main/perf/WorkSpanRecorder.ts re-exports
 * this module for main-process importers (pattern precedent:
 * src/main/host/HostCommandIdentity.ts).
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
  'round_start',
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

/**
 * Why a wait happened, per kind (Amendment A1.1). §1.1's bounds are not
 * actionable without it: "the light thread waited 400 ms on provider
 * configuration" is a different verdict when the cause is a cold start than
 * when it is another chat draining a cohort. Closed sets per kind, so an
 * unrecognised reason is rejected rather than silently attributed.
 */
export const WORK_SPAN_REASONS = {
  provider_config_wait: [
    'cold_start',
    'cohort_drain',
    'runtime_or_credential_domain',
    'registration_change'
  ],
  admission_wait: [
    'occupancy',
    'foreground_reserved',
    'lane_reserved',
    'queued',
    'cancelled',
    // Scheduler waiter outcomes (M1 A1.1): one admission_wait span per
    // settled waiter, its reason naming how the wait ended.
    'admitted',
    'rejected',
    'shutdown'
  ]
} as const satisfies Partial<Record<WorkSpanKind, readonly string[]>>

export type WorkSpanReasonKind = keyof typeof WORK_SPAN_REASONS
export type WorkSpanReason = (typeof WORK_SPAN_REASONS)[WorkSpanReasonKind][number]

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
  /** Present only for kinds that declare a reason set. */
  reason?: WorkSpanReason
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
  /**
   * Why this wait occurred. Valid only for a kind in WORK_SPAN_REASONS, and
   * only from that kind's closed set; anything else is `rejected`.
   */
  reason?: WorkSpanReason
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
  p99Ms: number
  maxMs: number
  bytes: number
  fallbackCount: number
}

/**
 * Exact, NEVER-SAMPLED counters over every span the recorder was OFFERED,
 * including spans the sampler declined. `count`/`bytes`/`fallbackCount` in
 * the aggregates above cover ACCEPTED spans only, so a sampled-out fallback
 * is invisible there — a zero sampled `fallbackCount` can never prove zero
 * fallbacks occurred (§1.1 B7). These counters are the authoritative
 * coverage evidence; only durations remain sampled.
 */
export interface WorkSpanOfferedCounters {
  offeredCount: number
  offeredFallbackCount: number
  offeredBytes: number
}

export interface WorkSpanExactCounters extends WorkSpanOfferedCounters {
  byKind: Partial<Record<WorkSpanKind, WorkSpanOfferedCounters>>
  byResource: Partial<Record<WorkSpanResource, WorkSpanOfferedCounters>>
}

/** Per-chat attributed durations; the light-vs-heavy evidence G-X needs. */
export interface WorkSpanChatAggregate {
  count: number
  totalMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
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
  /**
   * Measurements abandoned because the injected clock threw or returned a
   * non-finite timestamp. The application work continued; only the
   * diagnostic was dropped.
   */
  degraded: number
  /** Exact offered-span counters; unaffected by sampling. */
  exact: WorkSpanExactCounters
  /**
   * Bounded per-chat, per-kind attributed durations. Process-wide byKind /
   * byResource cannot tell a light thread from a heavy one, so paired G-X
   * comparisons read this map instead.
   */
  byChat: Record<string, Partial<Record<WorkSpanKind, WorkSpanChatAggregate>>>
  /** Offered spans whose chat was not admitted to `byChat` (bound reached). */
  attributionOverflow: number
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
  sampler?: (attrs: NormalizedWorkSpanAttrs) => boolean
  /** Clock for startedAt and durations; defaults to Date.now. */
  now?: () => number
  /**
   * How many distinct chats may hold a `byChat` entry. Admission is
   * first-come and never evicts, so a light thread active from the start of
   * the window is always attributed; spans from later chats beyond the bound
   * only increment `attributionOverflow`. Never an unbounded map.
   */
  maxAttributedChats?: number
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

/** Default `byChat` bound: enough for a paired light/heavy matrix cell. */
export const DEFAULT_MAX_ATTRIBUTED_CHATS = 16

/** Default sampler keeps everything until this many spans in one window. */
export const DEFAULT_KEEP_ALL_MIN_WINDOW = 256
/** Above the keep-all threshold the default sampler keeps 1 in this many. */
export const DEFAULT_SAMPLE_KEEP_EVERY = 8

/** Attrs after validation: identities defaulted, reason still optional. */
export type NormalizedWorkSpanAttrs = Required<Omit<WorkSpanAttrs, 'reason'>> & {
  reason?: WorkSpanReason
}

const REASON_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(WORK_SPAN_REASONS).map(([kind, reasons]) => [kind, new Set<string>(reasons)])
)

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

interface MutableOffered {
  offeredCount: number
  offeredFallbackCount: number
  offeredBytes: number
}

function offeredFor<K>(counters: Map<K, MutableOffered>, key: K): MutableOffered {
  let entry = counters.get(key)
  if (!entry) {
    entry = { offeredCount: 0, offeredFallbackCount: 0, offeredBytes: 0 }
    counters.set(key, entry)
  }
  return entry
}

function readOffered<K extends string>(
  counters: Map<K, MutableOffered>
): Partial<Record<K, WorkSpanOfferedCounters>> {
  const out: Partial<Record<K, WorkSpanOfferedCounters>> = {}
  for (const [key, entry] of counters) out[key] = { ...entry }
  return out
}

function optionalIdentity(value: unknown): string | null {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : null
}

function normalizeAttrs(attrs: WorkSpanAttrs): NormalizedWorkSpanAttrs | null {
  if (typeof attrs !== 'object' || attrs === null) return null
  if (typeof attrs.chatId !== 'string' || attrs.chatId.length === 0) return null
  if (!KIND_SET.has(attrs.kind as string)) return null
  const runId = optionalIdentity(attrs.runId)
  const participantId = optionalIdentity(attrs.participantId)
  const laneId = optionalIdentity(attrs.laneId)
  if (runId === null || participantId === null || laneId === null) return null
  const resource = attrs.resource === undefined ? 'none' : attrs.resource
  if (!RESOURCE_SET.has(resource as string)) return null
  if (attrs.reason !== undefined) {
    const allowed = REASON_SETS.get(attrs.kind)
    // A reason on a kind that declares none, or outside that kind's closed
    // set, is a taxonomy error — never silently dropped or silently kept.
    if (!allowed || !allowed.has(attrs.reason)) return null
  }
  return {
    chatId: attrs.chatId,
    kind: attrs.kind,
    runId,
    participantId,
    laneId,
    resource,
    reason: attrs.reason
  }
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
      p99Ms: nearestRank(durations, 99),
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
  const maxAttributedChats = finiteNonNegative(options.maxAttributedChats)
    ? Math.max(1, Math.floor(options.maxAttributedChats))
    : DEFAULT_MAX_ATTRIBUTED_CHATS

  let ringByChat = new Map<string, Map<WorkSpanKind, MutableTotals>>()
  let attributionOverflow = 0
  let offeredTotals: MutableOffered = {
    offeredCount: 0,
    offeredFallbackCount: 0,
    offeredBytes: 0
  }
  let offeredByKind = new Map<WorkSpanKind, MutableOffered>()
  let offeredByResource = new Map<WorkSpanResource, MutableOffered>()
  let recorded = 0
  let dropped = 0
  let sampledOut = 0
  let rejected = 0
  let degraded = 0
  let windowOffered = 0

  /**
   * Exact accounting, applied to EVERY offered span before the sampler is
   * consulted. `begin()` reports its bytes/fallback late (they arrive at
   * end), so the handle calls this again with the decorations even when the
   * span itself was sampled out — that is the whole point of R2-M1-2.
   */
  const countOffered = (
    attrs: NormalizedWorkSpanAttrs,
    decorations: { bytes: number; fallback: boolean; counted: boolean }
  ): void => {
    const targets = [
      offeredTotals,
      offeredFor(offeredByKind, attrs.kind),
      offeredFor(offeredByResource, attrs.resource)
    ]
    for (const target of targets) {
      if (decorations.counted) target.offeredCount += 1
      target.offeredBytes += decorations.bytes
      if (decorations.fallback) target.offeredFallbackCount += 1
    }
  }

  /** Bounded per-chat attribution; admission is first-come and never evicts. */
  const attribute = (span: WorkSpan): void => {
    let kinds = ringByChat.get(span.chatId)
    if (!kinds) {
      if (ringByChat.size >= maxAttributedChats) {
        attributionOverflow += 1
        return
      }
      ringByChat.set(span.chatId, (kinds = new Map()))
    }
    const totals = totalsFor(kinds, span.kind)
    totals.count += 1
    totals.totalMs += span.durationMs
    totals.maxMs = Math.max(totals.maxMs, span.durationMs)
  }

  /**
   * The injected clock is caller code on the hot path, so it is treated as
   * hostile: a throw or a non-finite reading abandons the measurement
   * (counted in `degraded`) instead of propagating into the application work
   * being measured. Returns null when the reading is unusable.
   */
  const readClock = (): number | null => {
    let value: unknown
    try {
      value = now()
    } catch {
      return null
    }
    return finiteNonNegative(value) ? value : null
  }

  const defaultSampler = (): boolean =>
    windowOffered <= keepAllBelow || windowOffered % DEFAULT_SAMPLE_KEEP_EVERY === 1
  const sampler = options.sampler ?? defaultSampler

  const shouldKeep = (attrs: NormalizedWorkSpanAttrs): boolean => {
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
    attribute(span)
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
    countOffered(normalized, { bytes: 0, fallback: false, counted: true })
    if (!shouldKeep(normalized)) {
      sampledOut += 1
      // Exact coverage still owes this span's late decorations: a fallback
      // reported at end must be counted even though nothing is retained.
      let decorated = false
      return (endOptions?: WorkSpanEndOptions) => {
        if (decorated) return
        decorated = true
        const bytes = endOptions?.bytes
        countOffered(normalized, {
          bytes: finiteNonNegative(bytes) ? bytes : 0,
          fallback: endOptions?.fallback === true,
          counted: false
        })
      }
    }
    const startedAt = readClock()
    if (startedAt === null) {
      degraded += 1
      return () => {}
    }
    let ended = false
    return (endOptions?: WorkSpanEndOptions) => {
      if (ended) return
      ended = true
      const bytes = endOptions?.bytes
      countOffered(normalized, {
        bytes: finiteNonNegative(bytes) ? bytes : 0,
        fallback: endOptions?.fallback === true,
        counted: false
      })
      const endedAt = readClock()
      if (endedAt === null) {
        degraded += 1
        return
      }
      accept({
        process: options.process,
        ...normalized,
        startedAt,
        durationMs: Math.max(0, endedAt - startedAt),
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
    countOffered(normalized, {
      bytes: span.bytes ?? 0,
      fallback: span.fallback === true,
      counted: true
    })
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
      rejected,
      degraded,
      exact: {
        ...offeredTotals,
        byKind: readOffered(offeredByKind),
        byResource: readOffered(offeredByResource)
      },
      byChat: collectByChat(),
      attributionOverflow
    }
  }

  /**
   * Per-chat aggregates: counts/totals are exact over accepted spans (they
   * survive ring eviction), percentiles are nearest-rank over the retained
   * window for that chat and kind — the same split as byKind/byResource.
   */
  const collectByChat = (): Record<
    string,
    Partial<Record<WorkSpanKind, WorkSpanChatAggregate>>
  > => {
    const durations = new Map<string, Map<WorkSpanKind, number[]>>()
    for (const span of orderedRing()) {
      if (!ringByChat.has(span.chatId)) continue
      let kinds = durations.get(span.chatId)
      if (!kinds) durations.set(span.chatId, (kinds = new Map()))
      let list = kinds.get(span.kind)
      if (!list) kinds.set(span.kind, (list = []))
      list.push(span.durationMs)
    }
    const out: Record<string, Partial<Record<WorkSpanKind, WorkSpanChatAggregate>>> = {}
    for (const [chatId, kinds] of ringByChat) {
      const perKind: Partial<Record<WorkSpanKind, WorkSpanChatAggregate>> = {}
      for (const [kind, totals] of kinds) {
        const retained = [...(durations.get(chatId)?.get(kind) ?? [])].sort((a, b) => a - b)
        perKind[kind] = {
          count: totals.count,
          totalMs: totals.totalMs,
          p50Ms: nearestRank(retained, 50),
          p95Ms: nearestRank(retained, 95),
          p99Ms: nearestRank(retained, 99),
          maxMs: totals.maxMs
        }
      }
      out[chatId] = perKind
    }
    return out
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
    degraded = 0
    windowOffered = 0
    ringByChat = new Map()
    attributionOverflow = 0
    offeredTotals = { offeredCount: 0, offeredFallbackCount: 0, offeredBytes: 0 }
    offeredByKind = new Map()
    offeredByResource = new Map()
  }

  const snapshot = (snapshotOptions?: { reset?: boolean }): WorkSpanSnapshot => {
    // Callers get span copies: mutating a returned snapshot must never be
    // able to corrupt the retained ring or later percentile computations.
    const result: WorkSpanSnapshot = {
      ...collectAggregates(),
      spans: orderedRing().map((span) => ({ ...span }))
    }
    if (snapshotOptions?.reset) reset()
    return result
  }

  const section = (): WorkSpanAggregates => collectAggregates()

  return { begin, record, snapshot, section }
}
