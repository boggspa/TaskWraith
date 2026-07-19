export type CodexCompactStartOutcome = 'accepted' | 'rejected' | 'timeout'

/** JSON-RPC acceptance and timeout can both mean a native turn exists. A
 * synchronous server rejection cannot erase earlier ambiguous evidence. */
export function updateCodexCompactionLaunchEvidence(
  mayBeLive: boolean,
  outcome: CodexCompactStartOutcome
): boolean {
  return mayBeLive || outcome === 'accepted' || outcome === 'timeout'
}

/** Balance pre-launch native activity only with affirmative evidence that no
 * compact turn was accepted or observed. */
export function codexCompactionFailureProvesNoLiveTurn(input: {
  launchMayBeLive: boolean
  observedTurnId?: string
}): boolean {
  return !input.launchMayBeLive && !input.observedTurnId
}
