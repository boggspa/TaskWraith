import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  SessionCheckpointRecord,
  SessionCheckpointStore,
  formatSessionCheckpointResumePrompt as FormatSessionCheckpointResumePrompt
} from '../checkpoints/SessionCheckpoint'

type SessionCheckpointStoreLike = Pick<
  SessionCheckpointStore,
  'list' | 'latestForChat' | 'accept' | 'dismiss'
>

type ResumePromptFormatter = typeof FormatSessionCheckpointResumePrompt

export interface CheckpointHandlersDeps {
  getSessionCheckpointStore: () => SessionCheckpointStoreLike | null
  requireNonEmptyString: (value: unknown, label: string) => string
  formatSessionCheckpointResumePrompt: ResumePromptFormatter
  /** Main renderers may address any chat. Secondary renderers must match the
   * durable chat owner recorded for their exact BrowserWindow. */
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
}

type AcceptResult =
  | { ok: false; error: 'No checkpoint matches.' }
  | {
      ok: true
      checkpoint: SessionCheckpointRecord
      resumePrompt: string
    }

type DismissResult =
  | { ok: false; error: 'No checkpoint matches.' }
  | { ok: true; checkpoint: SessionCheckpointRecord }

export function registerCheckpointHandlers(deps: CheckpointHandlersDeps): void {
  ipcMain.handle('session-checkpoints:latest', async (event, chatId?: string) => {
    const id = deps.requireNonEmptyString(chatId, 'Chat id')
    deps.assertSenderChatScope(event, id)
    const store = deps.getSessionCheckpointStore()
    return store?.latestForChat(id) || null
  })

  ipcMain.handle(
    'session-checkpoints:accept',
    async (event, checkpointId?: string): Promise<AcceptResult> => {
      const id = deps.requireNonEmptyString(checkpointId, 'Checkpoint id')
      const store = deps.getSessionCheckpointStore()
      const checkpoint = store?.list().find((record) => record.id === id)
      if (!store || !checkpoint) return { ok: false, error: 'No checkpoint matches.' }
      deps.assertSenderChatScope(event, checkpoint.chatId)
      const accepted = store.accept(id)
      if (!accepted) return { ok: false, error: 'No checkpoint matches.' }
      return {
        ok: true,
        checkpoint: accepted.checkpoint,
        resumePrompt:
          accepted.resumePrompt || deps.formatSessionCheckpointResumePrompt(accepted.checkpoint)
      }
    }
  )

  ipcMain.handle(
    'session-checkpoints:dismiss',
    async (event, checkpointId?: string): Promise<DismissResult> => {
      const id = deps.requireNonEmptyString(checkpointId, 'Checkpoint id')
      const store = deps.getSessionCheckpointStore()
      const checkpoint = store?.list().find((record) => record.id === id)
      if (!store || !checkpoint) return { ok: false, error: 'No checkpoint matches.' }
      deps.assertSenderChatScope(event, checkpoint.chatId)
      const dismissed = store.dismiss(id)
      return dismissed
        ? { ok: true, checkpoint: dismissed }
        : { ok: false, error: 'No checkpoint matches.' }
    }
  )
}
