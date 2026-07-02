import { assessCompletionClaimSupport } from './EvidencePackModel'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  CompletionClaimSupportAnnotation,
  EvidencePackRecord
} from './store/types'

const TERMINAL_SUCCESS_STATUSES = new Set(['success', 'success_with_warnings', 'completed'])

function isSuccessfulTerminalRun(run: ChatRun): boolean {
  return TERMINAL_SUCCESS_STATUSES.has(String(run.status || ''))
}

function latestAssistantMessageIndexForRun(messages: ChatMessage[], runId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.runId === runId && message.content.trim()) {
      return index
    }
  }
  return -1
}

function compactAnnotation(
  assessment: ReturnType<typeof assessCompletionClaimSupport>,
  assessedAt: string
): CompletionClaimSupportAnnotation | null {
  if (!assessment.hasCompletionLanguage || assessment.status === 'no_completion_claim') return null
  return {
    status: assessment.status,
    hasCompletionLanguage: assessment.hasCompletionLanguage,
    completionPhrases: assessment.completionPhrases,
    evidencePackIds: assessment.evidencePackIds,
    supportingEvidenceRefs: assessment.supportingEvidenceRefs,
    message: assessment.message,
    ...(assessment.recommendedCaveat ? { recommendedCaveat: assessment.recommendedCaveat } : {}),
    assessedAt
  }
}

function annotationEqual(
  left: CompletionClaimSupportAnnotation | undefined,
  right: CompletionClaimSupportAnnotation | null
): boolean {
  const stable = (value: CompletionClaimSupportAnnotation | undefined | null) => {
    if (!value) return null
    const { assessedAt: _assessedAt, ...rest } = value
    return rest
  }
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

export function annotateChatCompletionClaimSupport(
  chat: ChatRecord,
  packs: EvidencePackRecord[],
  options: { now?: Date } = {}
): { chat: ChatRecord; changed: boolean } {
  if (chat.scope !== 'workspace' || !chat.workspaceId || !Array.isArray(chat.runs)) {
    return { chat, changed: false }
  }

  let changed = false
  const messages = [...(chat.messages || [])]
  const assessedAt = (options.now || new Date()).toISOString()
  for (const run of chat.runs) {
    if (!run.runId || !isSuccessfulTerminalRun(run)) continue
    const messageIndex = latestAssistantMessageIndexForRun(messages, run.runId)
    if (messageIndex < 0) continue
    const message = messages[messageIndex]
    const assessment = assessCompletionClaimSupport(message.content, packs, {
      workspaceId: chat.workspaceId,
      chatId: chat.appChatId,
      runId: run.runId
    })
    const nextAnnotation = compactAnnotation(assessment, assessedAt)
    const priorAnnotation = message.metadata?.completionClaimSupport
    if (annotationEqual(priorAnnotation, nextAnnotation)) continue
    const nextMetadata = { ...(message.metadata || {}) }
    if (nextAnnotation) nextMetadata.completionClaimSupport = nextAnnotation
    else delete nextMetadata.completionClaimSupport
    messages[messageIndex] = {
      ...message,
      metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined
    }
    changed = true
  }

  if (!changed) return { chat, changed: false }
  return {
    chat: {
      ...chat,
      messages
    },
    changed: true
  }
}
