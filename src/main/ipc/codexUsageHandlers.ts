import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  CodexUsageImportResult,
  ProviderUsageSnapshotOptions
} from '../providers/ProviderAuthUsage'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'

export const CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL = 'import-codex-usage-credential'
export const CODEX_USAGE_CLEAR_CREDENTIAL_CHANNEL = 'clear-codex-usage-credential'
export const CODEX_USAGE_GET_SNAPSHOT_CHANNEL = 'get-codex-usage-snapshot'

export interface CodexUsageHandlerDeps {
  importCodexUsageCredential: (
    event: IpcMainInvokeEvent,
    filePath?: string | null
  ) => Promise<CodexUsageImportResult>
  clearCodexUsageCredential: () => void
  fetchCodexUsageSnapshot: (
    options?: ProviderUsageSnapshotOptions
  ) => Promise<NormalizedProviderUsageSnapshot>
}

export function registerCodexUsageHandlers(deps: CodexUsageHandlerDeps): void {
  ipcMain.handle(CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL, async (event, filePath?: string | null) => {
    return deps.importCodexUsageCredential(event, filePath)
  })

  ipcMain.handle(CODEX_USAGE_CLEAR_CREDENTIAL_CHANNEL, async () => {
    deps.clearCodexUsageCredential()
    return true
  })

  ipcMain.handle(CODEX_USAGE_GET_SNAPSHOT_CHANNEL, async (_, options?: { force?: unknown }) => {
    return deps.fetchCodexUsageSnapshot({ force: options?.force === true })
  })
}

export function unregisterCodexUsageHandlers(): void {
  ipcMain.removeHandler(CODEX_USAGE_IMPORT_CREDENTIAL_CHANNEL)
  ipcMain.removeHandler(CODEX_USAGE_CLEAR_CREDENTIAL_CHANNEL)
  ipcMain.removeHandler(CODEX_USAGE_GET_SNAPSHOT_CHANNEL)
}
