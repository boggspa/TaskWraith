/**
 * In-progress `ask_user_question` draft answers, keyed by questionId.
 *
 * The live card mounts inside a transcript row keyed by `${messageId}#${index}`.
 * Pending markers re-tail on every chat-updated merge, which changes that index
 * and remounts the card — wiping component-local useState. This store keeps the
 * typed draft across those remounts (and virtualization / fallback flips) until
 * the question is answered, dismissed, or cancelled.
 */

export type AgentQuestionDraft = {
  freeText: string
  showFreeText: boolean
}

const drafts = new Map<string, AgentQuestionDraft>()

export function readAgentQuestionDraft(questionId: string): AgentQuestionDraft | undefined {
  if (!questionId) return undefined
  const draft = drafts.get(questionId)
  return draft ? { ...draft } : undefined
}

export function writeAgentQuestionDraft(
  questionId: string,
  patch: Partial<AgentQuestionDraft>
): AgentQuestionDraft {
  const previous = drafts.get(questionId)
  const next: AgentQuestionDraft = {
    freeText: patch.freeText ?? previous?.freeText ?? '',
    showFreeText: patch.showFreeText ?? previous?.showFreeText ?? false
  }
  drafts.set(questionId, next)
  return { ...next }
}

export function clearAgentQuestionDraft(questionId: string): void {
  if (!questionId) return
  drafts.delete(questionId)
}

/** Initial UI state for a freshly mounted (or remounted) question card. */
export function initialAgentQuestionCardDraft(
  questionId: string,
  hasOptions: boolean
): AgentQuestionDraft {
  const saved = readAgentQuestionDraft(questionId)
  if (saved) {
    return {
      freeText: saved.freeText,
      showFreeText: hasOptions ? saved.showFreeText : true
    }
  }
  return {
    freeText: '',
    showFreeText: !hasOptions
  }
}

/** Test-only / chat-teardown helper. */
export function clearAllAgentQuestionDrafts(): void {
  drafts.clear()
}
