export const RENDERER_DIAGNOSTIC_SCHEMA_VERSION = 1 as const
export const RENDERER_DIAGNOSTIC_RING_CAPACITY = 120
export const RENDERER_DIAGNOSTIC_SAMPLE_INTERVAL_MS = 15_000

const MAX_COUNTER = 1_000_000_000
const MAX_BYTE_VALUE = 16 * 1024 * 1024 * 1024 * 1024
const MAX_CHAT_ID_CHARS = 200
const MAX_ERROR_NAME_CHARS = 160
const MAX_ERROR_MESSAGE_CHARS = 2_048
const MAX_ERROR_STACK_CHARS = 4_096
const MAX_COMPONENT_STACK_CHARS = 4_096

export interface RendererChatUpdateClientCounters {
  received: number
  snapshots: number
  patches: number
  applyFailures: number
  acksSent: number
}

export interface RendererDiagnosticClientSample {
  activeChatId?: string
  activeChatMessageCount: number
  v8HeapUsedBytes?: number
  v8HeapTotalBytes?: number
  v8HeapLimitBytes?: number
  /** Live DOM element count; separates Blink-side growth from V8 heap growth. */
  domNodeCount?: number
  chatUpdates: RendererChatUpdateClientCounters
}

export interface RendererDiagnosticChatUpdateCounters {
  rendererReceived: number
  rendererSnapshots: number
  rendererPatches: number
  rendererApplyFailures: number
  rendererAcksSent: number
  mainSnapshots: number
  mainPatches: number
  mainBaselineDrops: number
  /** Baseline held, producer delta unusable — the cause a snapshot/patch ratio cannot see. */
  mainProducerDeltaMissing: number
  /** Deliveries the transport recovered by diffing the baseline instead of sending the record. */
  mainSpliceRecoveries: number
  /**
   * Broadcasts discarded by the coordinator's enqueue staleness guard. Sustained
   * increments during a live run are the "frozen transcript, healthy counters"
   * signature.
   */
  mainStaleEnqueueDrops: number
  /** Accepted deliveries whose ACK was rejected or timed out. */
  mainAckRejections: number
  /** Optional per-reason breakdown of {@link mainAckRejections}. */
  mainAckRejectReasons?: Record<string, number>
  mainTrackedChats: number
  mainInFlight: number
  mainPending: number
  /** Oldest in-flight chat-update ACK wait in ms. 0 when idle. */
  mainInFlightAgeMs: number
  /** Accepted chat updates awaiting a non-gating render receipt. */
  mainRenderPending: number
  /** Oldest accepted update without a render receipt in ms. */
  mainRenderReceiptAgeMs: number
  mainRetainedMessages: number
  mainRetainedBytes: number
}

export type RendererDiagnosticCause =
  | 'interval'
  | 'unresponsive'
  | 'responsive'
  | 'error-boundary'
  | 'render-process-gone'

export interface RendererErrorBoundaryReport {
  name?: string
  message: string
  stack?: string
  componentStack?: string
}

/**
 * Outcome of the getAppMetrics acquisition behind one sample.
 * - fresh: read from Electron for this sample.
 * - cached: reused TTL-shared snapshot (see metricsSnapshotAgeMs).
 * - failed: the reader threw.
 * - invalid: the reader returned a non-array value.
 * - missing: no reader configured or the reader returned undefined.
 */
export type RendererDiagnosticMetricsStatus = 'fresh' | 'cached' | 'failed' | 'invalid' | 'missing'

/** Freshness of one memory lane: fresh read, last-known carry, or no value. */
export type RendererDiagnosticLaneMemoryStatus = 'fresh' | 'carried' | 'missing'

/**
 * Freshness of the GPU lane. 'absent' is a healthy signal (snapshot read fine,
 * Electron reported no GPU row); 'missing' means the read itself failed or the
 * reader is unavailable, so absence cannot be claimed.
 */
export type RendererDiagnosticGpuMemoryStatus = 'fresh' | 'carried' | 'absent' | 'missing'

/**
 * Provenance of the renderer-owned client values in one sample.
 * - fresh: arrived from the renderer with this sample.
 * - reused: last-known client values for the same renderer PID.
 * - none: no client values (none received yet, or the cached client belongs to
 *   a different renderer PID after a restart).
 */
export type RendererDiagnosticClientSampleStatus = 'fresh' | 'reused' | 'none'

export interface RendererDiagnosticSample {
  schemaVersion: typeof RENDERER_DIAGNOSTIC_SCHEMA_VERSION
  sampledAt: string
  cause: RendererDiagnosticCause
  windowId: number
  webContentsId: number
  rendererPid: number
  rendererRssBytes?: number
  rendererPeakRssBytes?: number
  rendererPrivateBytes?: number
  v8HeapUsedBytes?: number
  v8HeapTotalBytes?: number
  v8HeapLimitBytes?: number
  rendererDomNodeCount?: number
  /** Aggregate GPU-process RSS/private bytes; the "heap low, process grows" lane. */
  gpuRssBytes?: number
  gpuPrivateBytes?: number
  /** Main-process RSS and V8 heap; separates main-side growth from renderers. */
  mainRssBytes?: number
  mainHeapUsedBytes?: number
  /**
   * PIDs of the GPU-process rows aggregated into gpuRssBytes/gpuPrivateBytes.
   * Sorted ascending and bounded; a PID change beside a bytes discontinuity
   * marks a GPU restart rather than growth. Carried last-known on failed reads.
   */
  gpuPids?: number[]
  /** Main-process PID; constant within a run, carried last-known on failed reads. */
  mainPid?: number
  /**
   * Freshness/identity evidence so cached or carried values cannot masquerade
   * as fresh readings. All optional: pre-extension v1 samples omit them.
   */
  metricsStatus?: RendererDiagnosticMetricsStatus
  /** Age of the getAppMetrics snapshot behind this sample; 0 read it fresh. */
  metricsSnapshotAgeMs?: number
  /** Malformed getAppMetrics entries skipped for this sample; set only when > 0. */
  metricsMalformedEntries?: number
  rendererMemoryStatus?: RendererDiagnosticLaneMemoryStatus
  gpuMemoryStatus?: RendererDiagnosticGpuMemoryStatus
  mainMemoryStatus?: RendererDiagnosticLaneMemoryStatus
  clientSampleStatus?: RendererDiagnosticClientSampleStatus
  activeChatIdHash?: string
  activeChatMessageCount: number
  activeChatPersistedBytes?: number
  chatUpdates: RendererDiagnosticChatUpdateCounters
  errorBoundary?: RendererErrorBoundaryReport
  crashReason?: string
  crashExitCode?: number
}

export interface RendererDiagnosticRingFile {
  schemaVersion: typeof RENDERER_DIAGNOSTIC_SCHEMA_VERSION
  capacity: number
  samples: RendererDiagnosticSample[]
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(maximum, Math.floor(value))
}

function boundedCounter(value: unknown): number {
  return boundedInteger(value, MAX_COUNTER) ?? 0
}

function boundedOptionalCounter(value: unknown): number | undefined {
  return boundedInteger(value, MAX_COUNTER)
}

function boundedBytes(value: unknown): number | undefined {
  return boundedInteger(value, MAX_BYTE_VALUE)
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maximum) : undefined
}

/** Bounds error-boundary context before it crosses into the persisted ring. */
export function sanitizeRendererErrorBoundaryReport(input: unknown): RendererErrorBoundaryReport {
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const name = boundedText(source.name, MAX_ERROR_NAME_CHARS)
  const stack = boundedText(source.stack, MAX_ERROR_STACK_CHARS)
  const componentStack = boundedText(source.componentStack, MAX_COMPONENT_STACK_CHARS)
  return {
    ...(name ? { name } : {}),
    message:
      boundedText(source.message, MAX_ERROR_MESSAGE_CHARS) ||
      'The renderer error boundary caught an unknown error.',
    ...(stack ? { stack } : {}),
    ...(componentStack ? { componentStack } : {})
  }
}

/** Bounds the untrusted renderer payload before it reaches persistence. */
export function sanitizeRendererDiagnosticClientSample(
  input: unknown
): RendererDiagnosticClientSample {
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const rawCounters =
    source.chatUpdates &&
    typeof source.chatUpdates === 'object' &&
    !Array.isArray(source.chatUpdates)
      ? (source.chatUpdates as Record<string, unknown>)
      : {}
  const activeChatId =
    typeof source.activeChatId === 'string' && source.activeChatId.trim()
      ? source.activeChatId.trim().slice(0, MAX_CHAT_ID_CHARS)
      : undefined

  return {
    ...(activeChatId ? { activeChatId } : {}),
    activeChatMessageCount: boundedCounter(source.activeChatMessageCount),
    ...(boundedBytes(source.v8HeapUsedBytes) !== undefined
      ? { v8HeapUsedBytes: boundedBytes(source.v8HeapUsedBytes) }
      : {}),
    ...(boundedBytes(source.v8HeapTotalBytes) !== undefined
      ? { v8HeapTotalBytes: boundedBytes(source.v8HeapTotalBytes) }
      : {}),
    ...(boundedBytes(source.v8HeapLimitBytes) !== undefined
      ? { v8HeapLimitBytes: boundedBytes(source.v8HeapLimitBytes) }
      : {}),
    ...(boundedOptionalCounter(source.domNodeCount) !== undefined
      ? { domNodeCount: boundedOptionalCounter(source.domNodeCount) }
      : {}),
    chatUpdates: {
      received: boundedCounter(rawCounters.received),
      snapshots: boundedCounter(rawCounters.snapshots),
      patches: boundedCounter(rawCounters.patches),
      applyFailures: boundedCounter(rawCounters.applyFailures),
      acksSent: boundedCounter(rawCounters.acksSent)
    }
  }
}

export function isRendererDiagnosticCause(value: unknown): value is RendererDiagnosticCause {
  return (
    value === 'interval' ||
    value === 'unresponsive' ||
    value === 'responsive' ||
    value === 'error-boundary' ||
    value === 'render-process-gone'
  )
}
