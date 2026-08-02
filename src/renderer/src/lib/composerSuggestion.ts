/**
 * Composer prefill suggestions — v1, template-only.
 *
 * The composer can offer a greyed-out ghost suggestion that Tab turns
 * into real draft text. This module decides WHAT to suggest; it holds
 * no React state and touches no DOM, so the trigger table is unit
 * testable without jsdom (this repo's renderer tests run against
 * `renderToStaticMarkup` or pure logic — there is no DOM environment).
 *
 * Display wording remains template-only: every trigger below fires on state
 * the app already knows exactly, and fills a template whose target is
 * verifiable — "rerun lane 2" either names a lane that failed or it doesn't.
 * An optional on-device model may only rank the finite host-approved set; it
 * never receives display text or invents a new suggestion.
 *
 * One class of suggestion is deliberately absent: replying to a
 * question the agent just asked. The natural template there is "yes,
 * go ahead", and making assent a one-key path is precisely the
 * anchoring failure this feature has to avoid — the cost of a
 * frictionless "yes" to a confirmation prompt is not a wasted
 * keystroke. Suggest actions, never agreement.
 */

import {
  isComposerContinuationHardBlocked,
  type ComposerContinuationCheckpoint
} from './composerContinuationCheckpoint'

export type ComposerSuggestionTrigger =
  | 'picker-dismissed'
  | 'task-continuation'
  | 'lane-failed'
  | 'uncommitted-changes'

export interface ComposerSuggestion {
  /**
   * Stable across re-derives of the same underlying state, so the
   * caller can dedupe "already showing this" and remember "user
   * dismissed this one" without the suggestion flickering.
   */
  id: string
  trigger: ComposerSuggestionTrigger
  /** The literal string Tab commits into the draft. */
  text: string
  /** Human-readable source explanation; absent for legacy templates. */
  explanation?: string
  /** Source class, never a transcript or telemetry-derived value. */
  provenance?: 'user-confirmed-active-goal'
}

/**
 * A finite, host-approved candidate. Personalization and an on-device model
 * may rank these candidates, but may never create a candidate of their own.
 */
export interface ComposerSuggestionCandidate {
  suggestion: ComposerSuggestion
  /** Baseline score before local preference evidence is applied. */
  baselineScore: number
  /** Cannot be outranked by learned preference or a model proposal. */
  hard: boolean
}

export interface ComposerSuggestionModel {
  /** Display label, e.g. `Opus 5`. */
  label: string
  /** `provider:modelId`, used only for the suggestion id. */
  key: string
}

export interface ComposerSuggestionLane {
  /** Display label — the seat's role, falling back to its provider id. */
  label: string
  /** Stable lane/participant identity, used only for the suggestion id. */
  id: string
  /** Provider behind the seat, named when the fix is to relaunch it. */
  provider: string
  /**
   * `failed` — dispatched and the provider returned an error, so a
   * rerun is the right next move.
   *
   * `unreachable` — the round's pre-flight check never reached the
   * provider's runtime/socket/binary at all. Suggesting a rerun here
   * would be actively wrong advice: it fails again for the same reason
   * until the provider is relaunched. The two statuses look alike in
   * summary views (both read as "Failed") but they want opposite
   * actions, which is exactly the kind of distinction a template has to
   * get right to be worth offering.
   */
  kind: 'failed' | 'unreachable'
}

export interface ComposerSuggestionContext {
  /**
   * Current draft text. Any non-empty draft suppresses every
   * suggestion — v1 only offers a ghost into an empty composer, which
   * sidesteps caret-position mirroring entirely and matches the actual
   * moment of use (you haven't typed yet and are deciding what to ask).
   */
  draft: string
  /** True while a run is in flight. No suggestions mid-turn. */
  busy: boolean
  /**
   * True once the chat has at least one settled assistant turn. Without
   * one there is nothing to "retry" or "rerun", so the action triggers
   * have no referent.
   */
  hasPriorTurn: boolean
  /**
   * Model the user highlighted in the picker and then dismissed
   * without selecting. The strongest single intent signal the composer
   * has: they went looking, considered one, and backed out.
   */
  consideredModel: ComposerSuggestionModel | null
  /** Currently active model — never suggest switching to it. */
  selectedModelKey: string | null
  /** Lanes that failed in the most recent settled ensemble round. */
  failedLanes: readonly ComposerSuggestionLane[]
  /** Narrow host-owned checkpoint; it deliberately excludes transcript prose. */
  continuationCheckpoint?: ComposerContinuationCheckpoint | null
  /** Changed-file count from the primary git snapshot. */
  uncommittedFileCount: number
  /** Current branch name, for the commit template's phrasing. */
  branch: string | null
  /** Suggestion ids the user has already dismissed in this chat. */
  dismissedIds: ReadonlySet<string>
}

/**
 * Priority is recency-of-gesture, not importance. A picker dismissal
 * happened seconds ago and was deliberate; uncommitted files have
 * probably been sitting there all session. Ranking the ambient state
 * above the fresh gesture is how these features start feeling stale.
 */
export function deriveComposerSuggestion(
  ctx: ComposerSuggestionContext
): ComposerSuggestion | null {
  return deriveComposerSuggestionCandidates(ctx)[0]?.suggestion ?? null
}

/**
 * Return every currently eligible candidate in deterministic fallback order.
 * The hook may apply bounded local personalization to the soft candidates;
 * callers that do not need personalization can continue using
 * `deriveComposerSuggestion()` above.
 */
export function deriveComposerSuggestionCandidates(
  ctx: ComposerSuggestionContext
): ComposerSuggestionCandidate[] {
  if (ctx.draft.trim().length > 0) return []
  if (ctx.busy) return []

  return candidatesInPriorityOrder(ctx).filter(
    (candidate): candidate is ComposerSuggestionCandidate =>
      Boolean(candidate) && !ctx.dismissedIds.has(candidate.suggestion.id)
  )
}

function candidatesInPriorityOrder(
  ctx: ComposerSuggestionContext
): (ComposerSuggestionCandidate | null)[] {
  const picker = pickerDismissed(ctx)
  const continuation = taskContinuation(ctx)
  const failure = laneFailed(ctx)
  const hygiene = uncommittedChanges(ctx)

  // When every attempted seat failed, diagnosis is a genuine blocker. With a
  // partial-success round, however, an active user goal is a better default
  // than repeatedly asking about the failures that did not stop the work.
  if (isComposerContinuationHardBlocked(ctx.continuationCheckpoint)) {
    return [picker, failure, continuation, hygiene]
  }
  return [picker, continuation, failure, hygiene]
}

function pickerDismissed(ctx: ComposerSuggestionContext): ComposerSuggestionCandidate | null {
  const considered = ctx.consideredModel
  if (!considered || !ctx.hasPriorTurn) return null
  // Backing out of the picker on the row that's already active is a
  // no-op gesture, not an escalation signal.
  if (considered.key === ctx.selectedModelKey) return null
  return {
    suggestion: {
      id: `picker-dismissed:${considered.key}`,
      trigger: 'picker-dismissed',
      text: `Retry that last turn on ${considered.label}`
    },
    baselineScore: 400,
    hard: true
  }
}

function taskContinuation(ctx: ComposerSuggestionContext): ComposerSuggestionCandidate | null {
  if (!ctx.hasPriorTurn) return null
  const checkpoint = ctx.continuationCheckpoint
  const action = checkpoint?.action
  if (!checkpoint || !action) return null
  return {
    suggestion: {
      id: `task-continuation:${checkpoint.id}:${action.id}`,
      trigger: 'task-continuation',
      text: action.text,
      explanation: action.explanation,
      provenance: action.provenance
    },
    baselineScore: 260,
    hard: false
  }
}

function laneFailed(ctx: ComposerSuggestionContext): ComposerSuggestionCandidate | null {
  if (!ctx.hasPriorTurn) return null
  if (ctx.failedLanes.length === 0) return null

  // Errored seats rank above never-reached ones: a rerun is a real next
  // move, whereas an unreachable seat needs its provider brought back
  // up first and would only fail again.
  const errored = ctx.failedLanes.filter((lane) => lane.kind === 'failed')
  if (errored.length === 1) {
    return {
      suggestion: {
        id: `lane-failed:${errored[0].id}`,
        trigger: 'lane-failed',
        text: `Rerun ${errored[0].label}`
      },
      baselineScore: isComposerContinuationHardBlocked(ctx.continuationCheckpoint) ? 360 : 210,
      hard: isComposerContinuationHardBlocked(ctx.continuationCheckpoint)
    }
  }
  // With several down, the useful ask is what went wrong — naming one
  // to rerun would be a coin flip presented as a recommendation.
  if (errored.length > 1) {
    return {
      suggestion: {
        id: `lane-failed:multi:${errored.map((lane) => lane.id).join(',')}`,
        trigger: 'lane-failed',
        text: `Why did ${errored.length} seats fail?`
      },
      baselineScore: isComposerContinuationHardBlocked(ctx.continuationCheckpoint) ? 360 : 210,
      hard: isComposerContinuationHardBlocked(ctx.continuationCheckpoint)
    }
  }

  const unreachable = ctx.failedLanes
  if (unreachable.length === 1) {
    const lane = unreachable[0]
    return {
      suggestion: {
        id: `lane-unreachable:${lane.id}`,
        trigger: 'lane-failed',
        text: `${lane.label} was never reached — is ${lane.provider} running?`
      },
      baselineScore: isComposerContinuationHardBlocked(ctx.continuationCheckpoint) ? 360 : 210,
      hard: isComposerContinuationHardBlocked(ctx.continuationCheckpoint)
    }
  }
  return {
    suggestion: {
      id: `lane-unreachable:multi:${unreachable.map((lane) => lane.id).join(',')}`,
      trigger: 'lane-failed',
      text: `Why were ${unreachable.length} seats unreachable?`
    },
    baselineScore: isComposerContinuationHardBlocked(ctx.continuationCheckpoint) ? 360 : 210,
    hard: isComposerContinuationHardBlocked(ctx.continuationCheckpoint)
  }
}

function uncommittedChanges(ctx: ComposerSuggestionContext): ComposerSuggestionCandidate | null {
  if (!ctx.hasPriorTurn) return null
  if (ctx.uncommittedFileCount <= 0) return null
  const branch = ctx.branch?.trim()
  return {
    suggestion: {
      id: `uncommitted-changes:${branch || 'detached'}:${ctx.uncommittedFileCount}`,
      trigger: 'uncommitted-changes',
      text: branch ? `Commit the working changes on ${branch}` : 'Commit the working changes'
    },
    baselineScore: 160,
    hard: false
  }
}
