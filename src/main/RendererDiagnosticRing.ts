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
  type RendererDiagnosticClientSampleStatus,
  type RendererDiagnosticGpuMemoryStatus,
  type RendererDiagnosticLaneMemoryStatus,
  type RendererDiagnosticMetricsStatus,
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

export interface MainMemoryUsageSnapshot {
  rss?: unknown
  heapUsed?: unknown
}

export interface RendererDiagnosticRecorderOptions extends RendererDiagnosticRingOptions {
  filePath: string
  now?: () => Date
  getAppMetrics?: () => ProcessMetric[]
  getMainMemoryUsage?: () => MainMemoryUsageSnapshot | null | undefined
  getMainPid?: () => number | null | undefined
  /**
   * Coalesces getAppMetrics bursts: samples recorded within this window share
   * one process snapshot. 0 disables sharing. Defaults to 1_000ms.
   */
  metricsSnapshotTtlMs?: number
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

function boundedPid(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

/** Bounds the persisted GPU identity list so one sample cannot grow the ring. */
const MAX_GPU_PID_ENTRIES = 8

/**
 * Accepts only entries safe to read pid/type/memory from. Malformed entries are
 * counted by the caller so a junk row cannot poison aggregation or masquerade
 * as a healthy empty snapshot.
 */
function wellFormedMetricEntry(entry: unknown): ProcessMetric | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const candidate = entry as Partial<ProcessMetric>
  if (typeof candidate.pid !== 'number' || !Number.isFinite(candidate.pid)) return undefined
  if (!candidate.memory || typeof candidate.memory !== 'object') return undefined
  return entry as ProcessMetric
}

function normalizedCapacity(value: number | undefined): number {
  if (!Number.isFinite(value)) return RENDERER_DIAGNOSTIC_RING_CAPACITY
  return Math.max(MIN_RING_CAPACITY, Math.min(MAX_RING_CAPACITY, Math.floor(value!)))
}

function normalizedMaxFileBytes(value: number | undefined): number {
  if (!Number.isFinite(value)) return MAX_RING_FILE_BYTES
  return Math.max(1_024, Math.min(MAX_RING_FILE_BYTES, Math.floor(value!)))
}

const DEFAULT_METRICS_SNAPSHOT_TTL_MS = 1_000

function normalizedMetricsSnapshotTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_METRICS_SNAPSHOT_TTL_MS
  return Math.max(0, Math.min(60_000, Math.floor(value!)))
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

type MetricsSnapshotOutcome = 'ok' | 'failed' | 'invalid' | 'missing'

/** Combines renderer-owned V8 state with main-owned RSS, disk, and IPC state. */
export class RendererDiagnosticRecorder {
  readonly ring: RendererDiagnosticRing
  private readonly latestClientByTarget = new Map<
    number,
    { client: RendererDiagnosticClientSample; rendererPid: number }
  >()
  private readonly latestSampleByTarget = new Map<number, RendererDiagnosticSample>()
  private readonly now: () => Date
  private readonly metricsSnapshotTtlMs: number
  private metricsSnapshot: {
    atMs: number
    metrics: ProcessMetric[]
    malformedEntries: number
    outcome: MetricsSnapshotOutcome
  } | null = null

  constructor(private readonly options: RendererDiagnosticRecorderOptions) {
    this.now = options.now ?? (() => new Date())
    this.metricsSnapshotTtlMs = normalizedMetricsSnapshotTtlMs(options.metricsSnapshotTtlMs)
    this.ring = new RendererDiagnosticRing(options.filePath, options)
  }

  recordClientSample(target: RendererDiagnosticTarget, input: unknown): RendererDiagnosticSample {
    const client = sanitizeRendererDiagnosticClientSample(input)
    this.latestClientByTarget.set(target.webContentsId, {
      client,
      rendererPid: target.rendererPid
    })
    return this.record(target, 'interval', client, undefined, undefined, 'fresh')
  }

  recordLifecycleSample(
    target: RendererDiagnosticTarget,
    cause: RendererLifecycleDiagnosticCause,
    crash?: { reason?: string; exitCode?: number }
  ): RendererDiagnosticSample {
    const cached = this.cachedClientFor(target)
    return this.record(target, cause, cached.client, crash, undefined, cached.status)
  }

  recordErrorBoundary(target: RendererDiagnosticTarget, input: unknown): RendererDiagnosticSample {
    const cached = this.cachedClientFor(target)
    return this.record(
      target,
      'error-boundary',
      cached.client,
      undefined,
      sanitizeRendererErrorBoundaryReport(input),
      cached.status
    )
  }

  /**
   * Reuses the last-known client sample only when it belongs to the same
   * renderer. After a restart the same webContentsId hosts a new PID whose heap
   * and DOM values are unknown until its first client sample arrives; reusing
   * the dead renderer's values would misattribute them to the new PID. A target
   * PID of 0 means the PID is unavailable (e.g. after render-process-gone), so
   * the terminal sample keeps last-known values.
   */
  private cachedClientFor(target: RendererDiagnosticTarget): {
    client: RendererDiagnosticClientSample
    status: Exclude<RendererDiagnosticClientSampleStatus, 'fresh'>
  } {
    const cached = this.latestClientByTarget.get(target.webContentsId)
    if (
      cached &&
      (target.rendererPid === 0 ||
        cached.rendererPid === 0 ||
        cached.rendererPid === target.rendererPid)
    ) {
      return { client: cached.client, status: 'reused' }
    }
    return { client: sanitizeRendererDiagnosticClientSample(undefined), status: 'none' }
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
    errorBoundary?: RendererErrorBoundaryReport,
    clientStatus: RendererDiagnosticClientSampleStatus = 'none'
  ): RendererDiagnosticSample {
    const previous = this.latestSampleByTarget.get(target.webContentsId)
    const rendererPid = target.rendererPid || previous?.rendererPid || 0
    const sameRenderer = !target.rendererPid || target.rendererPid === previous?.rendererPid
    // Fresh arrivals are trusted for the target renderer even across a PID
    // change; reused cache is trusted only for its own PID (see
    // cachedClientFor). Anything else falls back to same-renderer carry.
    const clientIsCurrent = clientStatus !== 'none'
    const trustClient = clientIsCurrent || sameRenderer
    const metricsSnapshot = this.snapshotAppMetrics()
    const metricsFailed =
      metricsSnapshot.outcome === 'failed' || metricsSnapshot.outcome === 'invalid'
    const metricsHealthy = metricsSnapshot.outcome === 'ok'
    const metric = rendererPid
      ? this.safeRead(
          () => metricsSnapshot.metrics.find((entry) => entry.pid === rendererPid),
          undefined
        )
      : undefined
    const gpuTotals = this.safeRead(() => this.gpuMemoryTotals(metricsSnapshot.metrics), {
      pids: [] as number[]
    })
    const mainUsage = this.mainMemoryUsage()
    const mainPid = this.mainPid()

    const rendererRssFresh = kibibytesToBytes(metric?.memory.workingSetSize)
    const rendererPeakFresh = kibibytesToBytes(metric?.memory.peakWorkingSetSize)
    const rendererPrivateFresh = kibibytesToBytes(metric?.memory.privateBytes)
    const rendererRssBytes =
      rendererRssFresh ?? (sameRenderer ? previous?.rendererRssBytes : undefined)
    const rendererPeakRssBytes =
      rendererPeakFresh ?? (sameRenderer ? previous?.rendererPeakRssBytes : undefined)
    const rendererPrivateBytes =
      rendererPrivateFresh ?? (sameRenderer ? previous?.rendererPrivateBytes : undefined)
    const rendererCarriedAny =
      (rendererRssBytes !== undefined && rendererRssFresh === undefined) ||
      (rendererPeakRssBytes !== undefined && rendererPeakFresh === undefined) ||
      (rendererPrivateBytes !== undefined && rendererPrivateFresh === undefined)
    const rendererMemoryStatus: RendererDiagnosticLaneMemoryStatus =
      rendererRssBytes === undefined &&
      rendererPeakRssBytes === undefined &&
      rendererPrivateBytes === undefined
        ? 'missing'
        : rendererCarriedAny
          ? 'carried'
          : 'fresh'

    const gpuRssBytes = gpuTotals.rssBytes ?? (metricsFailed ? previous?.gpuRssBytes : undefined)
    const gpuPrivateBytes =
      gpuTotals.privateBytes ?? (metricsFailed ? previous?.gpuPrivateBytes : undefined)
    const gpuPids =
      gpuTotals.pids.length > 0 ? gpuTotals.pids : metricsFailed ? previous?.gpuPids : undefined
    const gpuMemoryStatus: RendererDiagnosticGpuMemoryStatus = metricsHealthy
      ? gpuTotals.pids.length > 0
        ? 'fresh'
        : 'absent'
      : metricsFailed
        ? gpuRssBytes !== undefined || gpuPrivateBytes !== undefined || gpuPids !== undefined
          ? 'carried'
          : 'missing'
        : 'missing'

    const mainRssFresh = optionalNonNegativeInteger(mainUsage?.rss)
    const mainHeapFresh = optionalNonNegativeInteger(mainUsage?.heapUsed)
    const mainRssBytes = mainRssFresh ?? previous?.mainRssBytes
    const mainHeapUsedBytes = mainHeapFresh ?? previous?.mainHeapUsedBytes
    const mainCarriedAny =
      (mainRssBytes !== undefined && mainRssFresh === undefined) ||
      (mainHeapUsedBytes !== undefined && mainHeapFresh === undefined)
    const mainMemoryStatus: RendererDiagnosticLaneMemoryStatus =
      mainRssBytes === undefined && mainHeapUsedBytes === undefined
        ? 'missing'
        : mainCarriedAny
          ? 'carried'
          : 'fresh'
    const mainPidValue = mainPid ?? previous?.mainPid

    const metricsStatus: RendererDiagnosticMetricsStatus = metricsSnapshot.cached
      ? 'cached'
      : metricsSnapshot.outcome === 'ok'
        ? 'fresh'
        : metricsSnapshot.outcome

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
      ...(rendererRssBytes !== undefined ? { rendererRssBytes } : {}),
      ...(rendererPeakRssBytes !== undefined ? { rendererPeakRssBytes } : {}),
      ...(rendererPrivateBytes !== undefined ? { rendererPrivateBytes } : {}),
      ...(client.v8HeapUsedBytes !== undefined && trustClient
        ? { v8HeapUsedBytes: client.v8HeapUsedBytes }
        : sameRenderer && previous?.v8HeapUsedBytes !== undefined
          ? { v8HeapUsedBytes: previous.v8HeapUsedBytes }
          : {}),
      ...(client.v8HeapTotalBytes !== undefined && trustClient
        ? { v8HeapTotalBytes: client.v8HeapTotalBytes }
        : sameRenderer && previous?.v8HeapTotalBytes !== undefined
          ? { v8HeapTotalBytes: previous.v8HeapTotalBytes }
          : {}),
      ...(client.v8HeapLimitBytes !== undefined && trustClient
        ? { v8HeapLimitBytes: client.v8HeapLimitBytes }
        : sameRenderer && previous?.v8HeapLimitBytes !== undefined
          ? { v8HeapLimitBytes: previous.v8HeapLimitBytes }
          : {}),
      ...(client.domNodeCount !== undefined && trustClient
        ? { rendererDomNodeCount: client.domNodeCount }
        : sameRenderer && previous?.rendererDomNodeCount !== undefined
          ? { rendererDomNodeCount: previous.rendererDomNodeCount }
          : {}),
      ...(client.blinkCacheUsage !== undefined && trustClient
        ? { blinkCacheUsage: client.blinkCacheUsage }
        : sameRenderer && previous?.blinkCacheUsage !== undefined
          ? { blinkCacheUsage: previous.blinkCacheUsage }
          : {}),
      ...(gpuRssBytes !== undefined ? { gpuRssBytes } : {}),
      ...(gpuPrivateBytes !== undefined ? { gpuPrivateBytes } : {}),
      ...(gpuPids !== undefined ? { gpuPids } : {}),
      ...(mainRssBytes !== undefined ? { mainRssBytes } : {}),
      ...(mainHeapUsedBytes !== undefined ? { mainHeapUsedBytes } : {}),
      ...(mainPidValue !== undefined ? { mainPid: mainPidValue } : {}),
      metricsStatus,
      metricsSnapshotAgeMs: boundedNonNegativeInteger(metricsSnapshot.ageMs),
      ...(metricsSnapshot.malformedEntries > 0
        ? { metricsMalformedEntries: metricsSnapshot.malformedEntries }
        : {}),
      rendererMemoryStatus,
      gpuMemoryStatus,
      mainMemoryStatus,
      clientSampleStatus: clientStatus,
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
        mainProducerDeltaMissing: boundedNonNegativeInteger(protocolCounters?.producerDeltaMissing),
        mainSpliceRecoveries: boundedNonNegativeInteger(protocolCounters?.spliceRecoveries),
        mainStaleEnqueueDrops: boundedNonNegativeInteger(protocolCounters?.staleEnqueueDrops),
        mainAckRejections: boundedNonNegativeInteger(protocolCounters?.ackRejections),
        ...(protocolCounters?.ackRejectReasons &&
        Object.keys(protocolCounters.ackRejectReasons).length > 0
          ? { mainAckRejectReasons: { ...protocolCounters.ackRejectReasons } }
          : {}),
        mainTrackedChats: boundedNonNegativeInteger(targetStats?.trackedChats),
        mainInFlight: boundedNonNegativeInteger(targetStats?.inFlight),
        mainPending: boundedNonNegativeInteger(targetStats?.pending),
        mainInFlightAgeMs: boundedNonNegativeInteger(targetStats?.inFlightAgeMs),
        mainRenderPending: boundedNonNegativeInteger(targetStats?.renderPending),
        mainRenderReceiptAgeMs: boundedNonNegativeInteger(targetStats?.renderReceiptAgeMs),
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

  private snapshotAppMetrics(): {
    metrics: ProcessMetric[]
    malformedEntries: number
    outcome: MetricsSnapshotOutcome
    cached: boolean
    ageMs: number
  } {
    let atMs = Number.NaN
    try {
      atMs = this.now().getTime()
    } catch (error) {
      this.options.onError?.('Renderer diagnostic sampling failed.', error)
    }
    const cached = this.metricsSnapshot
    if (cached && this.metricsSnapshotTtlMs > 0 && Number.isFinite(atMs)) {
      const ageMs = atMs - cached.atMs
      if (ageMs >= 0 && ageMs < this.metricsSnapshotTtlMs) {
        return {
          metrics: cached.metrics,
          malformedEntries: cached.malformedEntries,
          outcome: cached.outcome,
          cached: true,
          ageMs
        }
      }
    }
    let metrics: ProcessMetric[] = []
    let malformedEntries = 0
    let outcome: MetricsSnapshotOutcome = 'ok'
    try {
      const read = this.options.getAppMetrics?.()
      if (read === undefined) {
        outcome = 'missing'
      } else if (!Array.isArray(read)) {
        outcome = 'invalid'
        this.options.onError?.(
          'Renderer diagnostic sampling failed.',
          new Error('getAppMetrics returned a non-array snapshot.')
        )
      } else {
        for (const entry of read) {
          const wellFormed = wellFormedMetricEntry(entry)
          if (wellFormed) metrics.push(wellFormed)
          else malformedEntries += 1
        }
      }
    } catch (error) {
      outcome = 'failed'
      metrics = []
      malformedEntries = 0
      this.options.onError?.('Renderer diagnostic sampling failed.', error)
    }
    const snapshot = { atMs, metrics, malformedEntries, outcome }
    this.metricsSnapshot = Number.isFinite(atMs) ? snapshot : null
    return { ...snapshot, cached: false, ageMs: 0 }
  }

  private gpuMemoryTotals(metrics: ProcessMetric[]): {
    rssBytes?: number
    privateBytes?: number
    pids: number[]
  } {
    let rssKiB = 0
    let privateKiB = 0
    let rssSeen = false
    let privateSeen = false
    const pids: number[] = []
    for (const entry of metrics) {
      if (entry.type !== 'GPU') continue
      const pid = boundedPid(entry.pid)
      if (pid !== undefined) pids.push(pid)
      const rss = optionalNonNegativeInteger(entry.memory.workingSetSize)
      if (rss !== undefined) {
        rssKiB += rss
        rssSeen = true
      }
      const priv = optionalNonNegativeInteger(entry.memory.privateBytes)
      if (priv !== undefined) {
        privateKiB += priv
        privateSeen = true
      }
    }
    pids.sort((a, b) => a - b)
    return {
      ...(rssSeen ? { rssBytes: Math.min(Number.MAX_SAFE_INTEGER, rssKiB * 1024) } : {}),
      ...(privateSeen
        ? { privateBytes: Math.min(Number.MAX_SAFE_INTEGER, privateKiB * 1024) }
        : {}),
      pids: pids.slice(0, MAX_GPU_PID_ENTRIES)
    }
  }

  private mainMemoryUsage(): MainMemoryUsageSnapshot | undefined {
    return this.safeRead(() => {
      if (this.options.getMainMemoryUsage) {
        return this.options.getMainMemoryUsage() ?? undefined
      }
      return process.memoryUsage()
    }, undefined)
  }

  private mainPid(): number | undefined {
    return this.safeRead(() => {
      if (this.options.getMainPid) {
        return boundedPid(this.options.getMainPid() ?? undefined)
      }
      return boundedPid(process.pid)
    }, undefined)
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
