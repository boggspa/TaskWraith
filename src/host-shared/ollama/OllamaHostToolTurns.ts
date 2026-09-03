/**
 * Runaway breakers for the Host-owned Ollama tool loop.
 *
 * Ported from the desktop lane (src/main/ollama/OllamaProvider.ts:
 * OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS, the identical-tool-failure
 * streak, and ollamaCeilingFinalizeContent). The pure-Node Host cannot import
 * that module — it is Electron-bound — so the semantics are re-stated here as a
 * pure state machine the adapter drives. Desktop reuse is a named follow-up.
 *
 * The rule the desktop lane learned at cost: an executed-but-failed tool is
 * progress the first couple of times, because compile-error to read to fix is a
 * legitimate loop. The SAME failure over and over is not, and without a breaker
 * the run grinds until the user cancels (2026-07-28 QA: an 82-minute
 * shell-error loop with no ceiling).
 */

/** Absolute tool-turn cap. Generous: the Host tier offers at most four tools. */
export const HOST_OLLAMA_MAX_TOOL_TURNS = 12
/** Finalize gracefully after this many CONSECUTIVE non-productive turns. */
export const HOST_OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS = 4
/** An identical failure stops counting as progress after this many in a row. */
export const HOST_OLLAMA_MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES = 3

/** Failure identity is the tool plus the head of its message, as on the desktop. */
const FAILURE_KEY_MAX_CHARS = 160

export interface OllamaHostToolTurnState {
  readonly consecutiveNonProductiveTurns: number
  readonly identicalFailureStreak: number
  readonly lastFailureKey: string | null
}

export function createOllamaHostToolTurnState(): OllamaHostToolTurnState {
  return { consecutiveNonProductiveTurns: 0, identicalFailureStreak: 0, lastFailureKey: null }
}

/**
 * Fold one tool outcome into the breaker state. `productive` answers the only
 * question the ceiling cares about: did this call advance the run? A success
 * always does. A failure does while it is still a NEW failure — a model
 * genuinely iterating on an error keeps its credit, and the streak resets.
 */
export function foldOllamaHostToolOutcome(
  state: OllamaHostToolTurnState,
  outcome: { readonly toolName: string; readonly ok: boolean; readonly result: string }
): { readonly state: OllamaHostToolTurnState; readonly productive: boolean } {
  if (outcome.ok) {
    return {
      state: { ...state, identicalFailureStreak: 0, lastFailureKey: null },
      productive: true
    }
  }
  const failureKey = `${outcome.toolName}\n${outcome.result.slice(0, FAILURE_KEY_MAX_CHARS)}`
  const identicalFailureStreak =
    failureKey === state.lastFailureKey ? state.identicalFailureStreak + 1 : 1
  return {
    state: { ...state, identicalFailureStreak, lastFailureKey: failureKey },
    productive: identicalFailureStreak < HOST_OLLAMA_MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES
  }
}

/** Close a turn. A turn that ran no productive tool call feeds the ceiling. */
export function closeOllamaHostToolTurn(
  state: OllamaHostToolTurnState,
  input: { readonly productive: boolean }
): OllamaHostToolTurnState {
  return {
    ...state,
    consecutiveNonProductiveTurns: input.productive ? 0 : state.consecutiveNonProductiveTurns + 1
  }
}

export function ollamaHostToolCeilingReached(state: OllamaHostToolTurnState): boolean {
  return state.consecutiveNonProductiveTurns >= HOST_OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS
}

/** Terminal content emitted when a breaker fires, so a run never ends silent. */
export function ollamaHostToolCeilingContent(): string {
  return 'I could not produce a valid tool call or a usable answer after several attempts, so I am stopping instead of looping. Please rephrase or narrow the request.'
}
