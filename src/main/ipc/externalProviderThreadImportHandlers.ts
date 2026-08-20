import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import type { ExternalProviderThreadImportService } from '../import/ExternalProviderThreadImport'
import {
  externalProviderThreadImportLabel,
  isExternalProviderThreadImportProvider,
  type ExternalProviderThreadImportChatSummary,
  type ExternalProviderThreadImportResult
} from '../../shared/externalProviderThreadImport'

export interface ExternalProviderThreadImportHandlersDeps {
  readonly importer: Pick<ExternalProviderThreadImportService, 'importFile'>
  readonly getRequestingWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null
  readonly showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions
  ) => Promise<{ canceled: boolean; filePaths: string[] }>
  readonly assertMainRendererSender: (event: IpcMainInvokeEvent) => void
  readonly broadcastThreadList: () => void
}

export type ExternalProviderThreadImportHandlerResult =
  ExternalProviderThreadImportResult<ExternalProviderThreadImportChatSummary>

function inputRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function registerExternalProviderThreadImportHandlers(
  deps: ExternalProviderThreadImportHandlersDeps
): void {
  ipcMain.handle(
    'import-external-provider-thread',
    async (event, input: unknown): Promise<ExternalProviderThreadImportHandlerResult> => {
      deps.assertMainRendererSender(event)
      const request = inputRecord(input)
      if (!request || !isExternalProviderThreadImportProvider(request.provider)) {
        return {
          ok: false,
          canceled: false,
          code: 'invalid-provider',
          error: 'Choose Codex, Claude, Cursor, or AntiGravity.'
        }
      }
      const window = deps.getRequestingWindow(event)
      if (!window) {
        return {
          ok: false,
          canceled: false,
          code: 'window-unavailable',
          error: 'The settings window is unavailable.'
        }
      }
      const label = externalProviderThreadImportLabel(request.provider)
      const selection = await deps.showOpenDialog(window, {
        title: `Import ${label} thread transcript`,
        message:
          'Choose one transcript file. TaskWraith does not scan provider directories or import native resume credentials.',
        properties: ['openFile'],
        filters: [
          { name: `${label} transcript`, extensions: ['jsonl', 'json'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (selection.canceled || selection.filePaths.length === 0) {
        return { ok: true, canceled: true }
      }
      // The native picker yields the event loop; revalidate renderer authority
      // after the human returns before reading the selected path.
      deps.assertMainRendererSender(event)
      try {
        const result = await deps.importer.importFile({
          provider: request.provider,
          filePath: selection.filePaths[0]
        })
        if (!result.duplicate) deps.broadcastThreadList()
        const metadata = result.chat.externalProviderThreadImport
        if (!metadata) throw new Error('Imported transcript provenance is unavailable.')
        return {
          ok: true,
          canceled: false,
          duplicate: result.duplicate,
          truncated: result.truncated,
          importedMessageCount: result.importedMessageCount,
          sourceMessageCount: result.sourceMessageCount,
          chat: {
            appChatId: result.chat.appChatId,
            title: result.chat.title,
            archived: true,
            externalProviderThreadImport: metadata
          }
        }
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown }
        return {
          ok: false,
          canceled: false,
          code: typeof candidate?.code === 'string' ? candidate.code : 'import-failed',
          error:
            typeof candidate?.message === 'string'
              ? candidate.message
              : 'The selected transcript could not be imported.'
        }
      }
    }
  )
}
