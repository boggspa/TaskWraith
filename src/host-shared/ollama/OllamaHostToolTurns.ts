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
/**
 * Key-independent backstop, cleared by any success. "Identical" is keyed on the
 * identical CALL, so a model that varies its arguments while failing every time
 * never repeats a key and the streak above can no longer bound it on its own.
 */
export const HOST_OLLAMA_MAX_CONSECUTIVE_TOOL_FAILURES = 8

/**
 * Failure identity is the tool, its operative ARGUMENTS, and the head of its
 * message. The arguments are load-bearing: several refusals carry a fixed
 * preamble with no discriminator inside this window, so keying on the message
 * head alone collapsed three DIFFERENT failing calls into one streak and
 * finalized runs that were still making progress.
 */
const FAILURE_KEY_MAX_CHARS = 160

/**
 * Narration keys, stripped from the failure key. They are free prose the model
 * rewrites at will, so counting them would mint a fresh key every turn and the
 * breaker would never fire. Mirrors OLLAMA_TOOL_NARRATION_ARG_KEYS on the
 * desktop lane, re-stated because the Host cannot import it.
 */
const HOST_NARRATION_ARG_KEYS = ['intent', 'summary', 'reason', 'description']

/** Order-independent serialization, so key order cannot fork the identity. */
function hostCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(hostCanonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${hostCanonicalJson(record[key])}`)
    .join(',')}}`
}

/** Call identity: the tool plus its arguments, minus TOP-LEVEL narration. */
function hostToolCallKey(toolName: string, args?: Record<string, unknown>): string {
  const identity: Record<string, unknown> = { ...(args || {}) }
  for (const key of HOST_NARRATION_ARG_KEYS) delete identity[key]
  return `${toolName}${hostCanonicalJson(identity)}`
}

export interface OllamaHostToolTurnState {
  readonly consecutiveNonProductiveTurns: number
  readonly identicalFailureStreak: number
  readonly lastFailureKey: string | null
  readonly consecutiveFailures: number
}

export function createOllamaHostToolTurnState(): OllamaHostToolTurnState {
  return {
    consecutiveNonProductiveTurns: 0,
    identicalFailureStreak: 0,
    lastFailureKey: null,
    consecutiveFailures: 0
  }
}

/**
 * Fold one tool outcome into the breaker state. `productive` answers the only
 * question the ceiling cares about: did this call advance the run? A success
 * always does. A failure does while it is still a NEW failure — a model
 * genuinely iterating on an error keeps its credit, and the streak resets.
 */
export function foldOllamaHostToolOutcome(
  state: OllamaHostToolTurnState,
  outcome: {
    readonly toolName: string
    readonly ok: boolean
    readonly result: string
    readonly args?: Record<string, unknown>
  }
): { readonly state: OllamaHostToolTurnState; readonly productive: boolean } {
  if (outcome.ok) {
    return {
      state: { ...state, identicalFailureStreak: 0, lastFailureKey: null, consecutiveFailures: 0 },
      productive: true
    }
  }
  const callKey = hostToolCallKey(outcome.toolName, outcome.args)
  const failureKey = `${callKey}\n${outcome.result.slice(0, FAILURE_KEY_MAX_CHARS)}`
  const identicalFailureStreak =
    failureKey === state.lastFailureKey ? state.identicalFailureStreak + 1 : 1
  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    state: { ...state, identicalFailureStreak, lastFailureKey: failureKey, consecutiveFailures },
    productive:
      identicalFailureStreak < HOST_OLLAMA_MAX_CONSECUTIVE_IDENTICAL_TOOL_FAILURES &&
      consecutiveFailures < HOST_OLLAMA_MAX_CONSECUTIVE_TOOL_FAILURES
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
