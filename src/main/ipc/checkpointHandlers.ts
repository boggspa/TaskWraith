import { ipcMain } from 'electron'
import type {
  SessionCheckpointRecord,
  SessionCheckpointStore,
  formatSessionCheckpointResumePrompt as FormatSessionCheckpointResumePrompt
} from '../checkpoints/SessionCheckpoint'

type SessionCheckpointStoreLike = Pick<
  SessionCheckpointStore,
  'latestForChat' | 'accept' | 'dismiss'
>

type ResumePromptFormatter = typeof FormatSessionCheckpointResumePrompt

export interface CheckpointHandlersDeps {
  getSessionCheckpointStore: () => SessionCheckpointStoreLike | null
  requireNonEmptyString: (value: unknown, label: string) => string
  formatSessionCheckpointResumePrompt: ResumePromptFormatter
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
  ipcMain.handle('session-checkpoints:latest', async (_, chatId?: string) => {
    const id = deps.requireNonEmptyString(chatId, 'Chat id')
    const store = deps.getSessionCheckpointStore()
    return store?.latestForChat(id) || null
  })

  ipcMain.handle(
    'session-checkpoints:accept',
    async (_, checkpointId?: string): Promise<AcceptResult> => {
      const id = deps.requireNonEmptyString(checkpointId, 'Checkpoint id')
      const store = deps.getSessionCheckpointStore()
      const accepted = store?.accept(id) || null
      if (!accepted) return { ok: false, error: 'No checkpoint matches.' }
      return {
        ok: true,
        checkpoint: accepted.checkpoint,
        resumePrompt:
          accepted.resumePrompt ||
          deps.formatSessionCheckpointResumePrompt(accepted.checkpoint)
      }
    }
  )

  ipcMain.handle(
    'session-checkpoints:dismiss',
    async (_, checkpointId?: string): Promise<DismissResult> => {
      const id = deps.requireNonEmptyString(checkpointId, 'Checkpoint id')
      const store = deps.getSessionCheckpointStore()
      const dismissed = store?.dismiss(id) || null
      return dismissed
        ? { ok: true, checkpoint: dismissed }
        : { ok: false, error: 'No checkpoint matches.' }
    }
  )
}
