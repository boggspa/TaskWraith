import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  AuditRetentionPurgeRequest,
  ProductAuditBundleExportRequest,
  ProductAuditBundleVerificationRequest,
  ProductCrashFilter,
  ProductCrashInput,
  ProductOperationsStatus
} from '../store/types'
import type { BugReportSubmission as BugReportSubmissionInput } from '../services/BugReportService'
import type { RendererDiagnosticClientSample } from '../../shared/rendererDiagnostics'

export const PRODUCT_AUDIT_BUNDLE_MAX_VERIFY_BYTES = 64 * 1024 * 1024
export const SECONDARY_RENDERER_CRASH_REPORT_LIMIT = 12
export const SECONDARY_RENDERER_CRASH_REPORT_WINDOW_MS = 60_000

const SECONDARY_RENDERER_CRASH_TEXT_MAX_CHARS = 12_000
const SECONDARY_RENDERER_CRASH_METADATA_MAX_DEPTH = 6
const SECONDARY_RENDERER_CRASH_METADATA_MAX_NODES = 256
const SECONDARY_RENDERER_CRASH_METADATA_MAX_ENTRIES = 48
const SECONDARY_RENDERER_CRASH_METADATA_MAX_KEY_CHARS = 160
const SECONDARY_RENDERER_CRASH_METADATA_MAX_STRING_CHARS = 2_000
const secondaryRendererCrashSecretKeyPattern =
  /(credential|token|secret|password|authorization|cookie|bookmark|encrypted)/i

function boundedRendererCrashText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, SECONDARY_RENDERER_CRASH_TEXT_MAX_CHARS)
}

/**
 * Renderer crash metadata is untrusted structured-clone input. Bound the graph
 * before ProductOperations performs its normal redaction so a cyclic or deeply
 * nested payload cannot recurse indefinitely in the main process.
 */
export function sanitizeSecondaryRendererCrashMetadata(
  input: unknown
): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined

  const seen = new WeakSet<object>()
  let visitedNodes = 0
  const visit = (value: unknown, depth: number): unknown => {
    if (visitedNodes >= SECONDARY_RENDERER_CRASH_METADATA_MAX_NODES) {
      return '[node-limited]'
    }
    visitedNodes += 1
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      return value
    }
    if (typeof value === 'string') {
      return value.slice(0, SECONDARY_RENDERER_CRASH_METADATA_MAX_STRING_CHARS)
    }
    if (typeof value === 'bigint') return value.toString()
    if (!value || typeof value !== 'object') return String(value ?? '')
    if (depth >= SECONDARY_RENDERER_CRASH_METADATA_MAX_DEPTH) return '[depth-limited]'
    if (seen.has(value)) return '[circular]'

    seen.add(value)
    if (Array.isArray(value)) {
      return value
        .slice(0, SECONDARY_RENDERER_CRASH_METADATA_MAX_ENTRIES)
        .map((entry) => visit(entry, depth + 1))
    }

    const output: Record<string, unknown> = {}
    let entryCount = 0
    for (const rawKey in value) {
      if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue
      if (entryCount >= SECONDARY_RENDERER_CRASH_METADATA_MAX_ENTRIES) break
      entryCount += 1
      const rawValue = (value as Record<string, unknown>)[rawKey]
      const key = rawKey.slice(0, SECONDARY_RENDERER_CRASH_METADATA_MAX_KEY_CHARS)
      output[key] = secondaryRendererCrashSecretKeyPattern.test(key)
        ? '[redacted]'
        : visit(rawValue, depth + 1)
    }
    return output
  }

  return visit(input, 0) as Record<string, unknown>
}

export function sanitizeSecondaryRendererCrashInput(input: unknown): ProductCrashInput {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
  const metadata = sanitizeSecondaryRendererCrashMetadata(source.metadata)
  return {
    source: 'renderer',
    severity: source.severity === 'warning' ? 'warning' : 'error',
    message:
      boundedRendererCrashText(source.message) ||
      boundedRendererCrashText(source.reason) ||
      'Renderer error.',
    ...(boundedRendererCrashText(source.reason)
      ? { reason: boundedRendererCrashText(source.reason) }
      : {}),
    ...(boundedRendererCrashText(source.name)
      ? { name: boundedRendererCrashText(source.name) }
      : {}),
    ...(boundedRendererCrashText(source.stack)
      ? { stack: boundedRendererCrashText(source.stack) }
      : {}),
    ...(metadata ? { metadata } : {})
  }
}

export function assertProductAuditBundleVerificationSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Audit bundle size could not be verified safely.')
  }
  if (size > PRODUCT_AUDIT_BUNDLE_MAX_VERIFY_BYTES) {
    throw new Error(
      `Audit bundle exceeds the ${PRODUCT_AUDIT_BUNDLE_MAX_VERIFY_BYTES}-byte verification limit.`
    )
  }
}

export interface DiagnosticsHandlersDeps {
  getProductOperationsStatus: () => Promise<ProductOperationsStatus>
  getProductCrashes: (filter?: ProductCrashFilter) => unknown
  recordProductCrash: (input: ProductCrashInput) => unknown
  recordRendererDiagnosticSample: (
    event: IpcMainInvokeEvent,
    input: RendererDiagnosticClientSample
  ) => unknown
  exportProductDiagnostics: (requestedPath?: string) => Promise<unknown>
  exportProductAuditBundle: (request?: ProductAuditBundleExportRequest) => Promise<unknown>
  verifyProductAuditBundle: (request?: ProductAuditBundleVerificationRequest) => Promise<unknown>
  purgeProductAuditRetention: (request?: AuditRetentionPurgeRequest) => Promise<unknown> | unknown
  repairProductInstall: () => Promise<ProductOperationsStatus>
  getAppShellStatsSnapshot: () => unknown
  getAppVersion: () => string | undefined
  getUserDataPath: () => string
  appendBugReport: (
    userDataPath: string,
    payload: BugReportSubmissionInput
  ) => Promise<{
    path: string
    sizeWarning?: boolean
    totalBytes?: number
  }>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  nowMs?: () => number
}

function normalizeAuditBundleExportRequest(
  request?: ProductAuditBundleExportRequest
): ProductAuditBundleExportRequest {
  if (!request) return {}
  if (request.redactionMode && request.redactionMode !== 'default') {
    throw new Error('Sensitive audit-bundle export modes are not available.')
  }
  return {
    ...request,
    redactionMode: request.redactionMode || 'default'
  }
}

export function registerDiagnosticsHandlers(deps: DiagnosticsHandlersDeps): void {
  const secondaryCrashReports = new Map<number, { windowStartedAt: number; count: number }>()
  const consumeSecondaryCrashReport = (event: IpcMainInvokeEvent): void => {
    const senderId = event.sender.id
    if (!Number.isSafeInteger(senderId) || senderId < 0) {
      throw new Error('Renderer crash telemetry sender is invalid.')
    }
    const now = deps.nowMs?.() ?? Date.now()
    const current = secondaryCrashReports.get(senderId)
    if (!current || now - current.windowStartedAt >= SECONDARY_RENDERER_CRASH_REPORT_WINDOW_MS) {
      secondaryCrashReports.set(senderId, { windowStartedAt: now, count: 1 })
    } else {
      if (current.count >= SECONDARY_RENDERER_CRASH_REPORT_LIMIT) {
        throw new Error('Renderer crash telemetry rate limit exceeded.')
      }
      current.count += 1
    }
    if (secondaryCrashReports.size > 128) {
      for (const [id, entry] of secondaryCrashReports) {
        if (now - entry.windowStartedAt >= SECONDARY_RENDERER_CRASH_REPORT_WINDOW_MS) {
          secondaryCrashReports.delete(id)
        }
      }
    }
  }

  ipcMain.handle('get-product-operations-status', async () => deps.getProductOperationsStatus())

  ipcMain.handle('get-product-crashes', (_, filter?: ProductCrashFilter) =>
    deps.getProductCrashes(filter || {})
  )

  ipcMain.handle('record-product-crash', (event, input: ProductCrashInput) => {
    if (deps.isMainRendererSender(event)) {
      return deps.recordProductCrash({ ...input, source: input?.source || 'renderer' })
    }
    consumeSecondaryCrashReport(event)
    return deps.recordProductCrash(sanitizeSecondaryRendererCrashInput(input))
  })

  ipcMain.handle(
    'record-renderer-diagnostic-sample',
    (event, input: RendererDiagnosticClientSample) => {
      if (!deps.isMainRendererSender(event)) return false
      deps.recordRendererDiagnosticSample(event, input)
      return true
    }
  )

  ipcMain.handle('export-product-diagnostics', async (_, requestedPath?: string) =>
    deps.exportProductDiagnostics(requestedPath)
  )

  ipcMain.handle('export-product-audit-bundle', async (_, request?: ProductAuditBundleExportRequest) =>
    deps.exportProductAuditBundle(normalizeAuditBundleExportRequest(request))
  )

  ipcMain.handle(
    'verify-product-audit-bundle',
    async (_, request?: ProductAuditBundleVerificationRequest) =>
      deps.verifyProductAuditBundle(request || {})
  )

  ipcMain.handle('purge-product-audit-retention', async (_, request?: AuditRetentionPurgeRequest) =>
    deps.purgeProductAuditRetention(request || {})
  )

  ipcMain.handle('repair-product-install', async () => deps.repairProductInstall())

  ipcMain.handle('app-shell-stats:snapshot', async () => deps.getAppShellStatsSnapshot())

  ipcMain.handle('get-app-version', () => deps.getAppVersion() || 'unknown')

  ipcMain.handle('submit-bug-report', async (_, payload: BugReportSubmissionInput) => {
    try {
      const submission: BugReportSubmissionInput = {
        ...payload,
        context: {
          ...payload?.context,
          timestamp: payload?.context?.timestamp || new Date().toISOString(),
          version: deps.getAppVersion() || payload?.context?.version
        }
      }
      const result = await deps.appendBugReport(deps.getUserDataPath(), submission)
      if (result.sizeWarning) {
        console.warn(
          `[bug-report] file is large (${result.totalBytes} bytes) — consider archiving and clearing ${result.path}.`
        )
      }
      return { ok: true, path: result.path }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save bug report.'
      console.error('[bug-report] append failed:', err)
      return { ok: false, error: message }
    }
  })
}
