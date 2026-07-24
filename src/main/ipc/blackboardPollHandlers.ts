import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ChatRecord } from '../store/types'
import { applyBlackboardPollVoteToChat } from '../blackboard/BlackboardPoll'

interface UserPollResponseResult {
  ok: boolean
  message: string
}

export interface BlackboardPollHandlersDeps {
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  getChat: (chatId: string) => ChatRecord | null | undefined
  saveAndBroadcastChat: (chat: ChatRecord) => void
  userPollResponseForChat?: (
    chatId: string | undefined,
    payload: { pollId?: string; choice?: string }
  ) => UserPollResponseResult
  now?: () => Date
}

interface AnswerEnsemblePollPayload {
  appChatId?: string
  pollId?: string
  choice?: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function registerBlackboardPollHandlers(deps: BlackboardPollHandlersDeps): void {
  ipcMain.handle(
    'answer-ensemble-poll',
    (event, rawPayload: AnswerEnsemblePollPayload | null | undefined) => {
      const payload = rawPayload || {}
      const appChatId = optionalString(payload.appChatId)
      if (appChatId) {
        deps.assertSenderChatScope(event, appChatId)
      } else if (!deps.isMainRendererSender(event)) {
        throw new Error('Renderer cannot resolve Ensemble poll chat authority.')
      }

      const pollId = optionalString(payload.pollId)
      const choice = optionalString(payload.choice)
      const now = deps.now?.() || new Date()
      const votedAt = now.toISOString()
      const blackboardVote = applyBlackboardPollVoteToChat({
        chat: appChatId ? deps.getChat(appChatId) : null,
        pollId: pollId || '',
        choice: choice || '',
        voterId: 'user',
        votedAt,
        updatedAtMs: now.getTime()
      })
      if (blackboardVote.handled) {
        if (!blackboardVote.ok) return { ok: false, error: blackboardVote.message }
        deps.saveAndBroadcastChat(blackboardVote.updatedChat)
        return { ok: true }
      }

      const result = deps.userPollResponseForChat?.(appChatId, { pollId, choice }) || {
        ok: false,
        message: 'Ensemble orchestrator is not available.'
      }
      return result.ok ? { ok: true } : { ok: false, error: result.message }
    }
  )
}
