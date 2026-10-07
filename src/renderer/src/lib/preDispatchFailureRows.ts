/**
 * Which prompt, if any, executeRun's outer catch must land as a user row
 * ahead of its "Run execution failed unexpectedly" error row.
 *
 * ORDERING INVARIANT: a run error never lands before the user message that
 * triggered it, and the user's prompt is never left only in the composer.
 *
 * EXACTLY-ONCE: a solo prompt row is authored by the renderer, so the catch
 * may always write it when it is missing. An Ensemble prompt row is authored
 * by the orchestrator in main once `runEnsembleRound` takes the prompt, so
 * the catch may write it only when that IPC was provably never invoked for
 * this request. A throw FROM the IPC is ambiguous -- main may already have
 * retained the prompt and authored its row -- so it lands nothing extra.
 */
export interface PreDispatchFailurePromptInput {
  readonly chatKind?: string | null
  /** Main accepted the dispatch; the run is no longer pre-dispatch. */
  readonly dispatchAccepted: boolean
  /** Set immediately before `window.api.runEnsembleRound` is called. */
  readonly ensembleRoundIpcInvoked: boolean
  /** The run's own prompt row is already in the transcript. */
  readonly promptRowWritten: boolean
  /** Edit-and-resend / retry: the prompt row already exists upstream. */
  readonly existingPrompt?: string | null
  readonly displayPrompt?: unknown
  readonly prompt?: unknown
}

/** The prompt text the run was sent with, preferring its display form. */
export function preDispatchFailurePromptText(
  input: Pick<PreDispatchFailurePromptInput, 'displayPrompt' | 'prompt'>
): string {
  if (typeof input.displayPrompt === 'string' && input.displayPrompt.trim()) {
    return input.displayPrompt
  }
  return typeof input.prompt === 'string' ? input.prompt.trim() : ''
}

/** The user-row content to land before the error row, or null for none. */
export function preDispatchFailurePrompt(input: PreDispatchFailurePromptInput): string | null {
  if (input.promptRowWritten || input.existingPrompt) return null
  const text = preDispatchFailurePromptText(input)
  if (!text) return null
  if (input.chatKind === 'ensemble') {
    if (input.dispatchAccepted || input.ensembleRoundIpcInvoked) return null
  }
  return text
}
