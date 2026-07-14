import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  REMOTE_QUESTION_MAX_ANSWER_CHARS,
  type RemoteQuestionResolutionScope
} from '../RemoteQuestionRegistry'

interface QuestionResolutionResult {
  ok: boolean
  reason?: string
}

interface AgentQuestionRegistryLike {
  answer: (questionId: string, answer: string, isCustom: boolean) => QuestionResolutionResult
  answerScoped: (
    questionId: string,
    scope: RemoteQuestionResolutionScope,
    answer: string,
    isCustom: boolean
  ) => QuestionResolutionResult
  reject: (questionId: string, reason: string) => QuestionResolutionResult
  rejectScoped: (
    questionId: string,
    scope: RemoteQuestionResolutionScope,
    reason: string
  ) => QuestionResolutionResult
}

interface AgentQuestionPayloadScope {
  appChatId?: string
  appRunId?: string
  workspaceId?: string | null
}

interface AnswerAgentQuestionPayload extends AgentQuestionPayloadScope {
  questionId: string
  answer: string
  isCustom?: boolean
}

interface CancelAgentQuestionPayload extends AgentQuestionPayloadScope {
  questionId: string
  reason?: string
}

export interface AgentQuestionHandlersDeps {
  registry: AgentQuestionRegistryLike
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function resolutionScope(
  deps: AgentQuestionHandlersDeps,
  event: IpcMainInvokeEvent,
  payload: AgentQuestionPayloadScope
): RemoteQuestionResolutionScope | null {
  const threadId = optionalString(payload.appChatId)
  if (!deps.isMainRendererSender(event)) {
    if (!threadId) {
      throw new Error('Renderer cannot resolve an agent question without chat authority.')
    }
    deps.assertSenderChatScope(event, threadId)
  } else if (threadId) {
    deps.assertSenderChatScope(event, threadId)
  }

  const scope: RemoteQuestionResolutionScope = {
    workspaceId: payload.workspaceId,
    threadId,
    runId: optionalString(payload.appRunId)
  }
  return scope.threadId || scope.runId || scope.workspaceId ? scope : null
}

export function registerAgentQuestionHandlers(deps: AgentQuestionHandlersDeps): void {
  ipcMain.handle('answer-agent-question', (event, payload: AnswerAgentQuestionPayload) => {
    const scope = resolutionScope(deps, event, payload)
    const answer = String(payload.answer || '').slice(0, REMOTE_QUESTION_MAX_ANSWER_CHARS)
    const result = scope
      ? deps.registry.answerScoped(
          payload.questionId,
          scope,
          answer,
          Boolean(payload.isCustom)
        )
      : deps.registry.answer(payload.questionId, answer, Boolean(payload.isCustom))
    if (!result.ok) return { ok: false, error: result.reason || 'no-such-question' }
    return { ok: true }
  })

  ipcMain.handle('cancel-agent-question', (event, payload: CancelAgentQuestionPayload) => {
    const scope = resolutionScope(deps, event, payload)
    const reason = optionalString(payload.reason) || 'user-dismissed'
    const result = scope
      ? deps.registry.rejectScoped(payload.questionId, scope, reason)
      : deps.registry.reject(payload.questionId, reason)
    if (!result.ok) return { ok: false, error: result.reason || 'no-such-question' }
    return { ok: true }
  })
}
