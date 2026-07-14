import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  ComposerInput,
  ComposerRunPayload,
  ComposerService
} from '../services/ComposerService'

type ComposeRun = Pick<ComposerService, 'composeRun'>['composeRun']

export interface ResolvedComposeRunAuthority {
  input: ComposerInput
  /** Exact attachments restored from a validated, main-owned scheduled task. */
  mainOwnedAttachments?: boolean
}

export interface ComposeRunHandlersDeps {
  composeRun: ComposeRun
  requireNonEmptyString: (value: unknown, label: string) => string
  resolveSenderComposeAuthority: (
    event: IpcMainInvokeEvent,
    input: ComposerInput
  ) => ResolvedComposeRunAuthority
  resolveSenderAttachmentPaths: (event: IpcMainInvokeEvent, paths: string[]) => string[]
  onScheduledRunComposed?: (
    event: IpcMainInvokeEvent,
    input: ComposerInput,
    payload: ComposerRunPayload
  ) => void
  /** Main renderers may address any chat. Secondary renderers must match the
   * durable chat owner recorded for their exact BrowserWindow. */
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
}

const SNAPSHOT_IDENTITY_ERROR = 'Composer chat snapshot does not match the requested chat.'

export function registerComposeRunHandlers(deps: ComposeRunHandlersDeps): void {
  ipcMain.handle('compose-run', (event, input?: ComposerInput): ComposerRunPayload => {
    const chatId = deps.requireNonEmptyString(input?.chatId, 'Chat id')
    deps.assertSenderChatScope(event, chatId)

    const snapshot = input?.chatSnapshot as unknown
    if (
      snapshot !== undefined &&
      (!snapshot ||
        typeof snapshot !== 'object' ||
        (snapshot as { appChatId?: unknown }).appChatId !== chatId)
    ) {
      throw new Error(SNAPSHOT_IDENTITY_ERROR)
    }

    const resolvedAuthority = deps.resolveSenderComposeAuthority(event, input as ComposerInput)
    const authorizedInput = { ...resolvedAuthority.input }
    if (!resolvedAuthority.mainOwnedAttachments) {
      for (const field of ['attachments', 'imageAttachments'] as const) {
        const attachments = authorizedInput[field]
        if (!Array.isArray(attachments)) continue
        const paths = attachments
          .map((attachment) => (typeof attachment?.path === 'string' ? attachment.path.trim() : ''))
          .filter(Boolean)
        const resolvedPaths = deps.resolveSenderAttachmentPaths(event, paths)
        let resolvedIndex = 0
        authorizedInput[field] = attachments.map((attachment) => {
          if (typeof attachment?.path !== 'string' || !attachment.path.trim()) return attachment
          return { ...attachment, path: resolvedPaths[resolvedIndex++] }
        })
      }
    }

    const payload = deps.composeRun(authorizedInput)
    if (resolvedAuthority.mainOwnedAttachments && authorizedInput.scheduledTaskId) {
      deps.onScheduledRunComposed?.(event, authorizedInput, payload)
    }
    return payload
  })
}
