import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname } from 'node:path'
import type { BrowserWindow, ProcessMetric } from 'electron'
import type {
  ChatUpdateDeliveryStats,
  ChatUpdateProtocolCounters
} from './ChatUpdateDeliveryCoordinator'
import {
  isRendererDiagnosticCause,
  RENDERER_DIAGNOSTIC_RING_CAPACITY,
  RENDERER_DIAGNOSTIC_SCHEMA_VERSION,
  sanitizeRendererDiagnosticClientSample,
  sanitizeRendererErrorBoundaryReport,
  type RendererDiagnosticCause,
  type RendererDiagnosticClientSample,
  type RendererDiagnosticRingFile,
  type RendererDiagnosticSample,
  type RendererErrorBoundaryReport
} from '../shared/rendererDiagnostics'

const MAX_RING_FILE_BYTES = 2 * 1024 * 1024
const MIN_RING_CAPACITY = 8
const MAX_RING_CAPACITY = 1_000
type RendererLifecycleDiagnosticCause = Exclude<
  RendererDiagnosticCause,
  'interval' | 'error-boundary'
>

export interface RendererDiagnosticTarget {
  windowId: number
  webContentsId: number
  rendererPid: number
}

export interface RendererDiagnosticRingOptions {
  capacity?: number
  maxFileBytes?: number
  onError?: (message: string, error: unknown) => void
}

export interface RendererDiagnosticRecorderOptions extends RendererDiagnosticRingOptions {
  filePath: string
  now?: () => Date
  getAppMetrics?: () => ProcessMetric[]
  getChatRecordPath?: (chatId: string) => string | null
  getChatUpdateTargetStats?: (webContentsId: number) => ChatUpdateDeliveryStats
  getChatUpdateProtocolCounters?: () => ChatUpdateProtocolCounters
  shouldRecordWindow?: (window: BrowserWindow) => boolean
}

function boundedNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const bounded = boundedNonNegativeInteger(value)
  return bounded > 0 || value === 0 ? bounded : undefined
}

function kibibytesToBytes(value: unknown): number | undefined {
  const kibibytes = optionalNonNegativeInteger(value)
  if (kibibytes === undefined) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, kibibytes * 1024)
}

function normalizedCapacity(value: number | undefined): number {
  if (!Number.isFinite(value)) return RENDERER_DIAGNOSTIC_RING_CAPACITY
  return Math.max(MIN_RING_CAPACITY, Math.min(MAX_RING_CAPACITY, Math.floor(value!)))
}

function normalizedMaxFileBytes(value: number | undefined): number {
  if (!Number.isFinite(value)) return MAX_RING_FILE_BYTES
  return Math.max(1_024, Math.min(MAX_RING_FILE_BYTES, Math.floor(value!)))
}

function isPersistedDiagnosticSample(value: unknown): value is RendererDiagnosticSample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const sample = value as Partial<RendererDiagnosticSample>
  return (
    sample.schemaVersion === RENDERER_DIAGNOSTIC_SCHEMA_VERSION &&
    typeof sample.sampledAt === 'string' &&
    isRendererDiagnosticCause(sample.cause) &&
    typeof sample.webContentsId === 'number' &&
    Boolean(sample.chatUpdates && typeof sample.chatUpdates === 'object')
  )
}

/** Fixed-capacity, atomically replaced local evidence file. */
export class RendererDiagnosticRing {
  private readonly capacity: number
  private readonly maxFileBytes: number
  private readonly samples: RendererDiagnosticSample[]

  constructor(
    readonly filePath: string,
    private readonly options: RendererDiagnosticRingOptions = {}
  ) {
    this.capacity = normalizedCapacity(options.capacity)
    this.maxFileBytes = normalizedMaxFileBytes(options.maxFileBytes)
    this.samples = this.load()
  }

  append(sample: RendererDiagnosticSample): RendererDiagnosticSample {
    this.samples.push(sample)
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity)
    }
    try {
      this.persist()
    } catch (error) {
      this.options.onError?.('Failed to persist renderer diagnostics.', error)
    }
    return sample
  }

  snapshot(): RendererDiagnosticRingFile {
    return JSON.parse(
      JSON.stringify({
        schemaVersion: RENDERER_DIAGNOSTIC_SCHEMA_VERSION,
        capacity: this.capacity,
        samples: this.samples
      } satisfies RendererDiagnosticRingFile)
    ) as RendererDiagnosticRingFile
  }

  private load(): RendererDiagnosticSample[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      const stat = fs.statSync(this.filePath)
      if (!stat.isFile() || stat.size > this.maxFileBytes) return []
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8')
      ) as Partial<RendererDiagnosticRingFile>
      if (
        parsed.schemaVersion !== RENDERER_DIAGNOSTIC_SCHEMA_VERSION ||
        !Array.isArray(parsed.samples)
      ) {
        return []
      }
      return parsed.samples.filter(isPersistedDiagnosticSample).slice(-this.capacity)
    } catch (error) {
      this.options.onError?.('Failed to read renderer diagnostics.', error)
      return []
    }
  }

  private persist(): void {
    fs.mkdirSync(dirname(this.filePath), { recursive: true })
    let serialized = `${JSON.stringify(this.snapshot(), null, 2)}\n`
    // Capacity bounds entry count; this second bound is deliberately based on
    // encoded bytes so non-ASCII stacks cannot produce a file that load() will
    // reject on the next launch. Preserve the newest evidence as the tail.
    while (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes && this.samples.length > 1) {
      this.samples.shift()
      serialized = `${JSON.stringify(this.snapshot(), null, 2)}\n`
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes) {
      throw new Error('A renderer diagnostic sample exceeds the ring file budget.')
    }
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, serialized, 'utf8')
    fs.renameSync(temporaryPath, this.filePath)
  }
}

export function rendererDiagnosticTargetFromWindow(
  window: BrowserWindow
): RendererDiagnosticTarget {
  let rendererPid = 0
  try {
    rendererPid = window.webContents.getOSProcessId()
  } catch {
    // Electron may no longer expose the pid after render-process-gone.
  }
  return {
    windowId: boundedNonNegativeInteger(window.id),
    webContentsId: boundedNonNegativeInteger(window.webContents.id),
    rendererPid: boundedNonNegativeInteger(rendererPid)
  }
}

/** Combines renderer-owned V8 state with main-owned RSS, disk, and IPC state. */
export class RendererDiagnosticRecorder {
  readonly ring: RendererDiagnosticRing
  private readonly latestClientByTarget = new Map<number, RendererDiagnosticClientSample>()
  private readonly latestSampleByTarget = new Map<number, RendererDiagnosticSample>()
  private readonly now: () => Date

  constructor(private readonly options: RendererDiagnosticRecorderOptions) {
    this.now = options.now ?? (() => new Date())
    this.ring = new RendererDiagnosticRing(options.filePath, options)
  }

  recordClientSample(target: RendererDiagnosticTarget, input: unknown): RendererDiagnosticSample {
    const client = sanitizeRendererDiagnosticClientSample(input)
    this.latestClientByTarget.set(target.webContentsId, client)
    return this.record(target, 'interval', client)
  }

  recordLifecycleSample(
    target: RendererDiagnosticTarget,
    cause: RendererLifecycleDiagnosticCause,
    crash?: { reason?: string; exitCode?: number }
  ): RendererDiagnosticSample {
    const client =
      this.latestClientByTarget.get(target.webContentsId) ??
      sanitizeRendererDiagnosticClientSample(undefined)
    return this.record(target, cause, client, crash)
  }

  recordErrorBoundary(target: RendererDiagnosticTarget, input: unknown): RendererDiagnosticSample {
    const client =
      this.latestClientByTarget.get(target.webContentsId) ??
      sanitizeRendererDiagnosticClientSample(undefined)
    return this.record(
      target,
      'error-boundary',
      client,
      undefined,
      sanitizeRendererErrorBoundaryReport(input)
    )
  }

  recordWindowLifecycleSample(
    window: BrowserWindow,
    cause: RendererLifecycleDiagnosticCause,
    crash?: { reason?: string; exitCode?: number }
  ): RendererDiagnosticSample | null {
    if (this.options.shouldRecordWindow && !this.options.shouldRecordWindow(window)) return null
    return this.recordLifecycleSample(rendererDiagnosticTargetFromWindow(window), cause, crash)
  }

  clearTarget(webContentsId: number): void {
    this.latestClientByTarget.delete(webContentsId)
    this.latestSampleByTarget.delete(webContentsId)
  }

  private record(
    target: RendererDiagnosticTarget,
    cause: RendererDiagnosticCause,
    client: RendererDiagnosticClientSample,
    crash?: { reason?: string; exitCode?: number },
    errorBoundary?: RendererErrorBoundaryReport
  ): RendererDiagnosticSample {
    const previous = this.latestSampleByTarget.get(target.webContentsId)
    const rendererPid = target.rendererPid || previous?.rendererPid || 0
    const sameRenderer = !target.rendererPid || target.rendererPid === previous?.rendererPid
    const metric = this.rendererMetric(rendererPid)
    const activeChatIdHash = client.activeChatId
      ? createHash('sha256').update(client.activeChatId).digest('hex').slice(0, 16)
      : undefined
    const activeChatPersistedBytes = this.activeChatPersistedBytes(client.activeChatId)
    const targetStats = this.safeRead(
      () => this.options.getChatUpdateTargetStats?.(target.webContentsId),
      undefined
    )
    const protocolCounters = this.safeRead(
      () => this.options.getChatUpdateProtocolCounters?.(),
      undefined
    )

    const sample: RendererDiagnosticSample = {
      schemaVersion: RENDERER_DIAGNOSTIC_SCHEMA_VERSION,
      sampledAt: this.now().toISOString(),
      cause,
      windowId: target.windowId || previous?.windowId || 0,
      webContentsId: target.webContentsId,
      rendererPid,
      ...(kibibytesToBytes(metric?.memory.workingSetSize) !== undefined
        ? { rendererRssBytes: kibibytesToBytes(metric?.memory.workingSetSize) }
        : sameRenderer && previous?.rendererRssBytes !== undefined
          ? { rendererRssBytes: previous.rendererRssBytes }
          : {}),
      ...(kibibytesToBytes(metric?.memory.peakWorkingSetSize) !== undefined
        ? { rendererPeakRssBytes: kibibytesToBytes(metric?.memory.peakWorkingSetSize) }
        : sameRenderer && previous?.rendererPeakRssBytes !== undefined
          ? { rendererPeakRssBytes: previous.rendererPeakRssBytes }
          : {}),
      ...(kibibytesToBytes(metric?.memory.privateBytes) !== undefined
        ? { rendererPrivateBytes: kibibytesToBytes(metric?.memory.privateBytes) }
        : sameRenderer && previous?.rendererPrivateBytes !== undefined
          ? { rendererPrivateBytes: previous.rendererPrivateBytes }
          : {}),
      ...(client.v8HeapUsedBytes !== undefined
        ? { v8HeapUsedBytes: client.v8HeapUsedBytes }
        : sameRenderer && previous?.v8HeapUsedBytes !== undefined
          ? { v8HeapUsedBytes: previous.v8HeapUsedBytes }
          : {}),
      ...(client.v8HeapTotalBytes !== undefined
        ? { v8HeapTotalBytes: client.v8HeapTotalBytes }
        : sameRenderer && previous?.v8HeapTotalBytes !== undefined
          ? { v8HeapTotalBytes: previous.v8HeapTotalBytes }
          : {}),
      ...(client.v8HeapLimitBytes !== undefined
        ? { v8HeapLimitBytes: client.v8HeapLimitBytes }
        : sameRenderer && previous?.v8HeapLimitBytes !== undefined
          ? { v8HeapLimitBytes: previous.v8HeapLimitBytes }
          : {}),
      ...(activeChatIdHash ? { activeChatIdHash } : {}),
      activeChatMessageCount: client.activeChatMessageCount,
      ...(activeChatPersistedBytes !== undefined
        ? { activeChatPersistedBytes }
        : activeChatIdHash === previous?.activeChatIdHash &&
            previous?.activeChatPersistedBytes !== undefined
          ? { activeChatPersistedBytes: previous.activeChatPersistedBytes }
          : {}),
      chatUpdates: {
        rendererReceived: client.chatUpdates.received,
        rendererSnapshots: client.chatUpdates.snapshots,
        rendererPatches: client.chatUpdates.patches,
        rendererApplyFailures: client.chatUpdates.applyFailures,
        rendererAcksSent: client.chatUpdates.acksSent,
        mainSnapshots: boundedNonNegativeInteger(protocolCounters?.snapshots),
        mainPatches: boundedNonNegativeInteger(protocolCounters?.patches),
        mainBaselineDrops: boundedNonNegativeInteger(protocolCounters?.baselineDrops),
        mainProducerDeltaMissing: boundedNonNegativeInteger(
          protocolCounters?.producerDeltaMissing
        ),
        mainSpliceRecoveries: boundedNonNegativeInteger(protocolCounters?.spliceRecoveries),
        mainTrackedChats: boundedNonNegativeInteger(targetStats?.trackedChats),
        mainInFlight: boundedNonNegativeInteger(targetStats?.inFlight),
        mainPending: boundedNonNegativeInteger(targetStats?.pending),
        mainRetainedMessages: boundedNonNegativeInteger(targetStats?.retainedMessages),
        mainRetainedBytes: boundedNonNegativeInteger(targetStats?.retainedBaselineBytes)
      },
      ...(errorBoundary ? { errorBoundary } : {}),
      ...(typeof crash?.reason === 'string' && crash.reason
        ? { crashReason: crash.reason.slice(0, 80) }
        : {}),
      ...(typeof crash?.exitCode === 'number' && Number.isFinite(crash.exitCode)
        ? { crashExitCode: Math.trunc(crash.exitCode) }
        : {})
    }
    this.latestSampleByTarget.set(target.webContentsId, sample)
    return this.ring.append(sample)
  }

  private rendererMetric(rendererPid: number): ProcessMetric | undefined {
    if (!rendererPid) return undefined
    return this.safeRead(
      () => this.options.getAppMetrics?.().find((metric) => metric.pid === rendererPid),
      undefined
    )
  }

  private activeChatPersistedBytes(chatId: string | undefined): number | undefined {
    if (!chatId) return undefined
    return this.safeRead(() => {
      const recordPath = this.options.getChatRecordPath?.(chatId)
      if (!recordPath || !fs.existsSync(recordPath)) return undefined
      const stat = fs.statSync(recordPath)
      return stat.isFile() ? boundedNonNegativeInteger(stat.size) : undefined
    }, undefined)
  }

  private safeRead<T>(read: () => T, fallback: T): T {
    try {
      return read()
    } catch (error) {
      this.options.onError?.('Renderer diagnostic sampling failed.', error)
      return fallback
    }
  }
}

export function rendererDiagnosticMetadata(
  sample: RendererDiagnosticSample | null
): Record<string, unknown> {
  if (!sample) return {}
  return {
    rendererDiagnosticSampledAt: sample.sampledAt,
    rendererDiagnosticsFile: 'renderer-diagnostics.json'
  }
}
