import type { EnsembleParticipant } from './store/types'
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
 * Candidate seat ids for Continuous auto-continue when assign_work was never
 * used: prior directed speakers (answered/yielded/sleeping), fan-out targets,
 * and yield-return stack participants. Callers still add Boss/acting Captain
 * and fail-open to the full roster when the filtered admit set is empty.
 */
export function collectAuthorityDirectedContinuationCandidateIds(input: {
  roundParticipantStatuses?: ReadonlyArray<{ participantId: string; status: string }>
  fannedOutParticipantIds?: Iterable<string>
  fanoutReservedParticipantIds?: Iterable<string>
  yieldReturnParticipantIds?: Iterable<string>
}): string[] {
  const admitted = new Set<string>()
  for (const entry of input.roundParticipantStatuses || []) {
    if (
      entry.status === 'answered' ||
      entry.status === 'yielded' ||
      entry.status === 'sleeping'
    ) {
      admitted.add(entry.participantId)
    }
  }
  for (const id of input.fannedOutParticipantIds || []) {
    if (id) admitted.add(id)
  }
  for (const id of input.fanoutReservedParticipantIds || []) {
    if (id) admitted.add(id)
  }
  for (const id of input.yieldReturnParticipantIds || []) {
    if (id) admitted.add(id)
  }
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
