import { ipcMain } from 'electron'
import type {
  AuditRetentionPurgeRequest,
  ProductAuditBundleExportRequest,
  ProductAuditBundleVerificationRequest,
  ProductCrashFilter,
  ProductCrashInput,
  ProductOperationsStatus
} from '../store/types'
import type { BugReportSubmission as BugReportSubmissionInput } from '../services/BugReportService'

export interface DiagnosticsHandlersDeps {
  getProductOperationsStatus: () => Promise<ProductOperationsStatus>
  getProductCrashes: (filter?: ProductCrashFilter) => unknown
  recordProductCrash: (input: ProductCrashInput) => unknown
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
  ipcMain.handle('get-product-operations-status', async () => deps.getProductOperationsStatus())

  ipcMain.handle('get-product-crashes', (_, filter?: ProductCrashFilter) =>
    deps.getProductCrashes(filter || {})
  )

  ipcMain.handle('record-product-crash', (_, input: ProductCrashInput) =>
    deps.recordProductCrash({
      ...input,
      source: input?.source || 'renderer'
    })
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
