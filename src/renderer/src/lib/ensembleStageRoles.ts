import type { EnsembleStageRole } from '../../../main/store/types'

/**
 * Shared copy for the stage-role pickers (participant chip popover +
 * Settings → Roster editor). Semantics live in the orchestrator (spike 4,
 * docs/ensemble-posture-fanout-preamble-design.md): scouts join the
 * round-start parallel read pass, workers always take a serial
 * implementation turn, reviewers wait until every non-reviewer finishes and
 * then run (as a parallel review wave when eligible). No stage = the
 * pre-stage behavior, inferred purely from the seat's permissions.
 */
export const ENSEMBLE_STAGE_ROLE_OPTIONS: ReadonlyArray<{
  id: EnsembleStageRole
  label: string
  description: string
}> = [
  {
    id: 'scout',
    label: 'Scout — investigates at round start',
    description:
      'Joins the parallel read-only pass at the start of the round and reports findings for the workers.'
  },
  {
    id: 'worker',
    label: 'Worker — serial implementation turn',
    description:
      'Always takes a serial turn, even when its permissions would qualify it for the read-only fan-out pass.'
  },
  {
    id: 'reviewer',
    label: 'Reviewer — runs after the others finish',
    description:
      'Waits until every non-reviewer has spoken, then reviews what changed (parallel review wave when at least two eligible reviewers remain).'
  }
]

export const ENSEMBLE_STAGE_ROLE_HINT =
  'Staged fan-out: scouts investigate at round start, workers take serial implementation turns, reviewers wait for the others and then verify the work. Leave unset to schedule purely by permissions.'

export function normalizeEnsembleStageRole(value: unknown): EnsembleStageRole | undefined {
  return value === 'scout' || value === 'worker' || value === 'reviewer' ? value : undefined
}
