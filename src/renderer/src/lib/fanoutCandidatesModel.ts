import type { FanoutWorktreeCandidate } from '../../../main/store/types'

/**
 * Pure view-model helpers for the fan-out candidates ("Compare") dock
 * surface. Exported separately from the component so behaviour is testable
 * without a DOM (the repo has no jsdom — renderToStaticMarkup only).
 */

export type FanoutCandidateGroup = 'awaiting' | 'running' | 'resolved'

export interface FanoutCandidateGroups {
  awaiting: FanoutWorktreeCandidate[]
  running: FanoutWorktreeCandidate[]
  resolved: FanoutWorktreeCandidate[]
}

/**
 * Adjudication order: settled candidates (the ones needing a decision) first,
 * newest round first; still-running lanes next; resolved history last.
 */
export function groupFanoutCandidates(
  candidates: readonly FanoutWorktreeCandidate[]
): FanoutCandidateGroups {
  const byNewest = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return {
    awaiting: byNewest.filter((candidate) => candidate.status === 'settled'),
    running: byNewest.filter((candidate) => candidate.status === 'active'),
    resolved: byNewest.filter(
      (candidate) => candidate.status === 'promoted' || candidate.status === 'discarded'
    )
  }
}

export function fanoutCandidateStatusLabel(candidate: FanoutWorktreeCandidate): string {
  switch (candidate.status) {
    case 'active':
      return 'Running'
    case 'settled':
      return candidate.runStatus === 'failed'
        ? 'Ready · run failed'
        : candidate.runStatus === 'cancelled'
          ? 'Ready · run stopped'
          : 'Ready to review'
    case 'promoted':
      return 'Promoted'
    case 'discarded':
      return 'Discarded'
  }
}

export function fanoutCandidateTitle(candidate: FanoutWorktreeCandidate): string {
  const seat = candidate.participantLabel || candidate.participantId
  return candidate.model ? `${seat} · ${candidate.model}` : seat
}

export function formatFanoutDiffStat(diffStat: FanoutWorktreeCandidate['diffStat']): string | null {
  if (!diffStat) return null
  if (diffStat.files === 0) return 'No changes'
  const files = `${diffStat.files} file${diffStat.files === 1 ? '' : 's'}`
  return `${files} · +${diffStat.insertions} −${diffStat.deletions}`
}

/** Candidates the surface should badge/alert on: decisions waiting. */
export function countAwaitingFanoutCandidates(
  candidates: readonly FanoutWorktreeCandidate[]
): number {
  return candidates.filter((candidate) => candidate.status === 'settled').length
}

export function fanoutCandidateCanResolve(candidate: FanoutWorktreeCandidate): boolean {
  return candidate.status === 'settled'
}
