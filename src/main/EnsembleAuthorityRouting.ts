import type { ActiveGoal, EnsembleParticipant } from './store/types'
import { resolveYieldTargetDetail } from './services/EnsembleMentionAlias'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../shared/ensembleLimits'

/**
 * A short-lived authority checkpoint attached to a Boss/Captain serial run.
 * It never changes provider admission or permissions; it tells the host and
 * prompt builder that this authority turn may deliberately reshape the
 * remaining queue before it ends.
 */
export interface EnsembleAuthorityRoutingCheckpoint {
  kind: 'later_pass' | 'tagged_intervention'
  /** One-based autonomous pass number within the active Ensemble round. */
  pass: number
  /** Continuous authority passes require a keep/skip/routing decision before ending. */
  selectionRequired: boolean
  /** Present when a peer explicitly summoned the active authority by @-mention. */
  sourceParticipantLabel?: string
}

export type EnsembleAuthorityRoutingDecision =
  | 'selected'
  | 'skipped_intervention'
  | 'skipped_participant'
  | 'summoned'
  | 'fanout'
  | 'redirected'
  | 'mentioned'

/**
 * Continuous acting Boss/Captain owns queue direction whenever ordinary
 * serial seats remain. Pass 1 is included — Turn-bound keeps its full
 * first-pass preserve separately.
 */
export function shouldAttachContinuousAuthoritySelectionCheckpoint(input: {
  orchestrationMode: string | undefined
  remainingParticipantCount: number
}): boolean {
  return input.orchestrationMode === 'continuous' && input.remainingParticipantCount > 0
}

/**
 * Turn-bound first pass always preserves every seat. Continuous lifts that
 * preserve so acting Boss/Captain can select/skip on pass 1.
 */
export function preservesInitialPassRoster(input: {
  orchestrationMode: string | undefined
  continuationPass: number
}): boolean {
  return input.continuationPass <= 1 && input.orchestrationMode !== 'continuous'
}

/** Quiet Continuous authority completion with an unmet selection checkpoint. */
export function shouldResummonAuthorityForUnresolvedRouting(input: {
  orchestrationMode: string | undefined
  selectionRequired: boolean | undefined
  decision: EnsembleAuthorityRoutingDecision | undefined
}): boolean {
  return (
    input.orchestrationMode === 'continuous' && Boolean(input.selectionRequired) && !input.decision
  )
}

/**
 * Whether this round owns a newly-terminal goal. A terminal goal carried in
 * from before the round is stale context, while a goal that left `active`
 * during the round supersedes any still-open authority routing checkpoint.
 */
export function goalBecameTerminalDuringRound(input: {
  activeGoal: ActiveGoal | undefined
  roundStartGoalId: string | undefined
  roundStartGoalWasTerminal: boolean | undefined
}): boolean {
  const goal = input.activeGoal
  if (!goal || goal.status === 'active') return false
  return !(input.roundStartGoalWasTerminal && goal.id === input.roundStartGoalId)
}

/**
 * Candidate seat ids for Continuous auto-continue when assign_work was never
 * used: authority-directed expansion only (fan-out targets, reserved fan-out,
 * yield-return stack, optional foreground synthesizer). Prior speakers
 * (answered/yielded/sleeping) are NOT re-admitted from status harvest —
 * select_participants expands within the authority-only pass instead.
 * Callers still add Boss/acting Captain and fail-open to the full roster when
 * the filtered admit set is empty.
 */
export function collectAuthorityOnlyContinuationCandidateIds(input: {
  fannedOutParticipantIds?: Iterable<string>
  fanoutReservedParticipantIds?: Iterable<string>
  yieldReturnParticipantIds?: Iterable<string>
  synthesizerParticipantId?: string
}): string[] {
  const admitted = new Set<string>()
  for (const id of input.fannedOutParticipantIds || []) {
    if (id) admitted.add(id)
  }
  for (const id of input.fanoutReservedParticipantIds || []) {
    if (id) admitted.add(id)
  }
  for (const id of input.yieldReturnParticipantIds || []) {
    if (id) admitted.add(id)
  }
  const synthesizerId = input.synthesizerParticipantId?.trim()
  if (synthesizerId) admitted.add(synthesizerId)
  return [...admitted]
}

export interface ResolveAuthoritySelectionInput {
  /**
   * Exact ids are preferred, but unique role/model aliases are accepted so a
   * provider can select `Worker` without first round-tripping an id lookup.
   */
  participantIds?: readonly string[]
  /** Explicit role/model selectors, kept separate for constrained tool callers. */
  participantRoles?: readonly string[]
  participants: readonly EnsembleParticipant[]
  pendingParticipants: readonly EnsembleParticipant[]
  callerParticipantId: string
}

export type AuthoritySelectionResolution =
  | {
      ok: true
      selected: EnsembleParticipant[]
      skipped: EnsembleParticipant[]
    }
  | {
      ok: false
      error:
        | 'missing_selection'
        | 'ambiguous_selector'
        | 'unknown_selector'
        | 'not_pending_selector'
      selector?: string
    }

function normalizeSelectors(values: readonly string[] | undefined): string[] {
  if (!values) return []
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, MAX_ENSEMBLE_PARTICIPANTS)
}

/**
 * Resolve an authority's explicit keep-list without mutating the queue. The
 * caller owns the queue update and durable participant-status projection;
 * keeping this resolver pure makes the first-pass and alias semantics easy to
 * test independently of provider dispatch.
 */
export function resolveAuthoritySelection(
  input: ResolveAuthoritySelectionInput
): AuthoritySelectionResolution {
  const selectors = [
    ...normalizeSelectors(input.participantIds),
    ...normalizeSelectors(input.participantRoles)
  ]
  if (selectors.length === 0) return { ok: false, error: 'missing_selection' }

  const pendingById = new Map(
    input.pendingParticipants.map((participant) => [participant.id, participant])
  )
  const selected: EnsembleParticipant[] = []
  const selectedIds = new Set<string>()
  const excluded = new Set([input.callerParticipantId])

  for (const selector of selectors) {
    const detail = resolveYieldTargetDetail(selector, [...input.participants], excluded)
    if (detail.kind === 'ambiguous') {
      return { ok: false, error: 'ambiguous_selector', selector }
    }
    if (detail.kind !== 'resolved') {
      return { ok: false, error: 'unknown_selector', selector }
    }
    const pending = pendingById.get(detail.participant.id)
    if (!pending) {
      return { ok: false, error: 'not_pending_selector', selector }
    }
    if (!selectedIds.has(pending.id)) {
      selectedIds.add(pending.id)
      selected.push(pending)
    }
  }

  return {
    ok: true,
    selected,
    skipped: input.pendingParticipants.filter((participant) => !selectedIds.has(participant.id))
  }
}

/**
 * One-shot keep-list an authority queued because its live `select_participants`
 * call arrived after every named seat had already dispatched in the current
 * pass. Consumed exactly once when the next Continuous pass forms; it dies with
 * the round runtime if no further pass forms (restart recovery deliberately
 * does not resurrect it — a stale trim is worse than a full pass).
 */
export interface QueuedAuthorityRosterSelection {
  participantIds?: string[]
  participantRoles?: string[]
  reason?: string
  authorityLabel: 'Boss' | 'Captain'
  callerParticipantId: string
  queuedAtPass: number
}

export type QueuedAuthorityRosterSelectionOutcome =
  | { applied: true; roster: EnsembleParticipant[]; note: string }
  | { applied: false; note: string }

/**
 * Apply a queued keep-list to the roster of a freshly forming Continuous pass,
 * narrowing-style: the outcome only filters which seats join the pass — it
 * never rewrites per-seat round state and never reorders, so excluded seats
 * look exactly like seats excluded by assignment-aware narrowing and the pass
 * dispatches in normal roster order. The queuing authority always stays
 * admitted when the pass contains it (authority runs every pass; the selector
 * resolver deliberately refuses self-selection). Fail-open: a queue that no
 * longer resolves leaves the roster untouched and reports why.
 */
export function applyQueuedAuthorityRosterSelection(input: {
  queued: QueuedAuthorityRosterSelection
  roster: readonly EnsembleParticipant[]
  participants: readonly EnsembleParticipant[]
  displayName: (participant: EnsembleParticipant) => string
}): QueuedAuthorityRosterSelectionOutcome {
  const { queued } = input
  const provenance = `${queued.authorityLabel} selection queued during pass ${queued.queuedAtPass}`
  const resolution = resolveAuthoritySelection({
    participantIds: queued.participantIds,
    participantRoles: queued.participantRoles,
    participants: input.participants,
    pendingParticipants: input.roster,
    callerParticipantId: queued.callerParticipantId
  })
  if (!resolution.ok) {
    const detail =
      resolution.error === 'not_pending_selector'
        ? `"${resolution.selector}" is not in this pass`
        : resolution.error === 'ambiguous_selector'
          ? `"${resolution.selector}" is ambiguous`
          : resolution.error === 'unknown_selector'
            ? `"${resolution.selector}" no longer resolves to a participant`
            : 'no selectors were provided'
    return {
      applied: false,
      note: `${provenance} could not be applied (${detail}); continuing with the standard pass.`
    }
  }
  const keptIds = new Set(resolution.selected.map((participant) => participant.id))
  keptIds.add(queued.callerParticipantId)
  const roster = input.roster.filter((participant) => keptIds.has(participant.id))
  const excluded = input.roster.filter((participant) => !keptIds.has(participant.id))
  const keptNames = roster.map(input.displayName).join(', ')
  if (excluded.length === 0) {
    return {
      applied: true,
      roster,
      note: `${provenance} applied: it already matches this pass (${keptNames}).`
    }
  }
  return {
    applied: true,
    roster,
    note: `${provenance} applied: keeping ${keptNames}; not dispatching ${excluded
      .map(input.displayName)
      .join(', ')} this pass.`
  }
}
