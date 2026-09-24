/**
 * One pollable bundle for "is the Host process healthy, and if not, which
 * thread's work is eating it" (Independent Threads Programme M1).
 *
 * Mirrors createMainPerfInstrumentation's start/stop/snapshot contract for
 * the Host runtime: the Host had no loop-lag meter before M1, so S2/S5
 * stalls (command chain, record persistence) were invisible outside a
 * hand-attached profiler. `eventLoopLag` says THAT the Host loop stalled;
 * the `workSpans` section — a Host-process WorkSpanRecorder exposed as
 * `.spans` so the composition root can hand begin/record to Host
 * subsystems — says WHICH chat/run/kind paid for it in the same window.
 * Extra sections are read-only closures supplied by the composition root,
 * and every section degrades to `{ error }` independently: diagnostics
 * that crash under the load they exist to diagnose are worse than none.
 *
 * Both dependencies come from src/host-shared/perf; this module must not
 * import src/main (the packaged standalone Host excludes that tree).
 */
import {
  createEventLoopLagMeter,
  type EventLoopLagMeter,
  type EventLoopLagSnapshot
} from '../host-shared/perf/EventLoopLagMeter'
import {
  createWorkSpanRecorder,
  type WorkSpanKind,
  type WorkSpanReason,
  type WorkSpanRecentRead,
  type WorkSpanRecorder,
  type WorkSpanResource
} from '../host-shared/perf/WorkSpanRecorder'

export interface HostPerfSnapshot {
  capturedAt: string
  eventLoopLag: EventLoopLagSnapshot
  sections: Record<string, unknown>
}

export interface HostPerfInstrumentation {
  start(): void
  stop(): void
  snapshot(options?: { resetLagWindow?: boolean }): HostPerfSnapshot
  /**
   * The Host-process recorder behind the `workSpans` section. The
   * composition root hands `spans.begin`/`spans.record` to the S2/S3/S5
   * seams; the section stays bounded because it reads aggregates plus a
   * tail of at most `recentSpanLimit` spans.
   */
  spans: WorkSpanRecorder
}

export interface HostPerfInstrumentationOptions {
  /** Injection seam for tests; production uses the native sampler. */
  meter?: EventLoopLagMeter
  /** Injection seam for tests; production constructs a Host recorder. */
  spans?: WorkSpanRecorder
  sections?: Record<string, () => unknown>
  now?: () => Date
  /** Rows in the `recentSpans` tail; defaults to HOST_WORK_SPAN_RECENT_LIMIT. */
  recentSpanLimit?: number
}

/**
 * Rows in the `workSpans.recentSpans` tail (M1 S3b). The runner reads every
 * 5 s capture and unions the tails by acceptance sequence, so a tail only
 * has to reach back to the previous capture the runner accepted: 1,024 rows
 * is 5 s at about 200 accepted spans a second. A tail that falls short is
 * detected by sequence and censors the windows it could touch; it is never
 * estimated around. Measured with a full ring: a full tail is 74 KB of JSON
 * over 16 chats and 122 KB over 1,024 distinct UUID chat ids (the file's cap
 * is 256 KiB). A capture, serialized and written with its rename, takes
 * 2.70 ms at p50 against 2.32 ms without the tail; the file grows from
 * 8.4 KB to 81.7 KB. Most of a capture's cost is `section()`, not the tail.
 */
export const HOST_WORK_SPAN_RECENT_LIMIT = 1024

/** Row encoding of the tail; hostSpans.cjs validates exactly this. */
export const HOST_RECENT_SPANS_ENCODING = 'ring_tail_rows_v1'
export const HOST_RECENT_SPAN_COLUMNS = [
  'seq',
  'chat',
  'kind',
  'resource',
  'startedAt',
  'durationMs',
  'bytes',
  'fallback',
  'reason'
] as const

export type HostRecentSpanRow = [
  seq: number,
  chat: number,
  kind: WorkSpanKind,
  resource: WorkSpanResource,
  startedAt: number,
  durationMs: number,
  bytes: number,
  fallback: boolean,
  reason: WorkSpanReason | null
]

/**
 * The newest accepted spans as the snapshot file carries them: rows in
 * acceptance order, each naming its chat by index into `chats`. Only the
 * chat id travels; run, participant and lane ids stay in the process.
 */
export interface HostRecentSpans {
  encoding: typeof HOST_RECENT_SPANS_ENCODING
  columns: string[]
  limit: number
  fromSeq: number | null
  toSeq: number | null
  /** Latest start among accepted spans the tail leaves out; null when none. */
  omittedMaxStartedAt: number | null
  chats: string[]
  rows: HostRecentSpanRow[]
}

export function encodeHostRecentSpans(read: WorkSpanRecentRead, limit: number): HostRecentSpans {
  const chats: string[] = []
  const chatIndex = new Map<string, number>()
  const rows = read.spans.map((span): HostRecentSpanRow => {
    let chat = chatIndex.get(span.chatId)
    if (chat === undefined) {
      chat = chats.push(span.chatId) - 1
      chatIndex.set(span.chatId, chat)
    }
    return [
      span.seq,
      chat,
      span.kind,
      span.resource,
      span.startedAt,
      span.durationMs,
      span.bytes,
      span.fallback,
      span.reason ?? null
    ]
  })
  return {
    encoding: HOST_RECENT_SPANS_ENCODING,
    columns: [...HOST_RECENT_SPAN_COLUMNS],
    limit,
    fromSeq: read.fromSeq,
    toSeq: read.toSeq,
    omittedMaxStartedAt: read.omittedMaxStartedAt,
    chats,
    rows
  }
}

/**
 * Ring bound for the default Host recorder; snapshots stay bounded.
 *
 * 512 was chosen before anyone had seen real span volume. The first run to
 * produce production Host spans recorded 4,512 in a single window and dropped
 * 4,000 of them — retained 512, exactly the bound — so every percentile in that
 * snapshot was nearest-rank over the most recent 11% of the window. Raised to
 * cover an observed window with headroom.
 *
 * The cost is proportional to spans RECORDED, not to this number: the ring is
 * `[]` and grows by push, so an install that records nothing allocates nothing.
 * Measured for both recorders together: 0.012 MiB idle at this bound, 1.534 MiB
 * at the observed host volume, 2.703 MiB full.
 *
 * NOTE, because it rides on the same constant: the default sampler keeps every
 * span until a window has been offered `max(256, maxRetained * 8)` and then
 * keeps 1-in-N, so raising this also raises the keep-everything threshold from
 * 4,096 to 65,536. That is the fidelity-improving direction, but it is a second
 * behavioural change and should not be discovered later.
 *
 * This bounds the SAMPLE; it does not fix the ESTIMATOR. Percentiles are still
 * nearest-rank over a retained tail, and `percentileSampleCount` is what says so
 * per aggregate. A bucketed histogram over every accepted span is the real fix
 * and is queued as its own reviewed change.
 */
export const HOST_WORK_SPAN_MAX_RETAINED = 8192

export function createHostPerfInstrumentation(
  options: HostPerfInstrumentationOptions = {}
): HostPerfInstrumentation {
  const meter = options.meter ?? createEventLoopLagMeter()
  const spans =
    options.spans ??
    createWorkSpanRecorder({ process: 'host', maxRetained: HOST_WORK_SPAN_MAX_RETAINED })
  const now = options.now ?? (() => new Date())
  const recentSpanLimit = options.recentSpanLimit ?? HOST_WORK_SPAN_RECENT_LIMIT
  if (!Number.isSafeInteger(recentSpanLimit) || recentSpanLimit < 0) {
    throw new TypeError('Host perf recentSpanLimit must be a non-negative integer.')
  }
  // The recorder's own section wins over a caller-supplied workSpans entry:
  // this instrumentation exists to make the Host recorder pollable. Both
  // reads run in one synchronous turn, so the tail ends at `recorded`.
  const sections = {
    ...options.sections,
    workSpans: () => ({
      ...spans.section(),
      recentSpans: encodeHostRecentSpans(spans.readRecent(recentSpanLimit), recentSpanLimit)
    })
  }

  const snapshot = (snapshotOptions?: { resetLagWindow?: boolean }): HostPerfSnapshot => {
    const collected: Record<string, unknown> = {}
    for (const [name, provider] of Object.entries(sections)) {
      try {
        collected[name] = provider() ?? null
      } catch (error) {
        collected[name] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      capturedAt: now().toISOString(),
      eventLoopLag: meter.snapshot({ reset: snapshotOptions?.resetLagWindow }),
      sections: collected
    }
  }

  return {
    start: () => meter.start(),
    stop: () => meter.stop(),
    snapshot,
    spans
  }
}
