export interface ComposerDraftSubmissionReceipt {
  /** Accept the submission and stop watching this draft for rollback safety. */
  commit(): void
  /** Restore the submitted text only when the user has not edited since clear. */
  restoreIfUntouched(): boolean
}

interface BeginComposerDraftSubmissionInput {
  chatId: string
  submittedDraft: string
  getDraft: (chatId: string) => string
  setDraft: (chatId: string, value: string) => void
  subscribeToDraft: (chatId: string, listener: () => void) => () => void
}

/** Statuses that prove main retained the exact request, whether live or queued. */
export function isAcceptedEnsembleSteerResult(
  result: { status?: string } | null | undefined
): boolean {
  return result?.status === 'steered' || result?.status === 'started' || result?.status === 'queued'
}

/**
 * Optimistically consume one exact composer draft while an async dispatch is
 * waiting for its durable acknowledgement.
 *
 * The submitted text disappears at gesture time, but an IPC rejection can
 * still restore it. Any subsequent user edit permanently disables rollback so
 * a late failure can neither overwrite a new draft nor resurrect text the user
 * deliberately typed and removed.
 */
export function beginComposerDraftSubmission(
  input: BeginComposerDraftSubmissionInput
): ComposerDraftSubmissionReceipt | null {
  if (!input.submittedDraft || input.getDraft(input.chatId) !== input.submittedDraft) return null

  let settled = false
  let ownClearInProgress = false
  let changedAfterClear = false
  const unsubscribe = input.subscribeToDraft(input.chatId, () => {
    if (!ownClearInProgress) changedAfterClear = true
  })

  ownClearInProgress = true
  input.setDraft(input.chatId, '')
  ownClearInProgress = false

  const settle = (): boolean => {
    if (settled) return false
    settled = true
    unsubscribe()
    return true
  }

  return {
    commit() {
      settle()
    },
    restoreIfUntouched() {
      if (!settle() || changedAfterClear || input.getDraft(input.chatId) !== '') return false
      input.setDraft(input.chatId, input.submittedDraft)
      return true
    }
  }
}
