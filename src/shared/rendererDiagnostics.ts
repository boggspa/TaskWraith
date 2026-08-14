export const RENDERER_DIAGNOSTIC_SCHEMA_VERSION = 1 as const
export const RENDERER_DIAGNOSTIC_RING_CAPACITY = 120
export const RENDERER_DIAGNOSTIC_SAMPLE_INTERVAL_MS = 15_000

const MAX_COUNTER = 1_000_000_000
const MAX_BYTE_VALUE = 16 * 1024 * 1024 * 1024 * 1024
const MAX_CHAT_ID_CHARS = 200

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
  mainTrackedChats: number
  mainInFlight: number
  mainPending: number
  mainRetainedMessages: number
  mainRetainedBytes: number
}

export type RendererDiagnosticCause =
  | 'interval'
  | 'unresponsive'
  | 'responsive'
  | 'render-process-gone'

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
  activeChatIdHash?: string
  activeChatMessageCount: number
  activeChatPersistedBytes?: number
  chatUpdates: RendererDiagnosticChatUpdateCounters
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

function boundedBytes(value: unknown): number | undefined {
  return boundedInteger(value, MAX_BYTE_VALUE)
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
    value === 'render-process-gone'
  )
}
