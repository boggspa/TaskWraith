import type { EnsembleStageRole } from '../../../main/store/types'

/**
 * Shared copy for the stage-role pickers (participant chip popover +
 * Settings → Roster editor). Semantics live in the orchestrator (spike 4,
 * the staged fan-out design; permission-agnostic since
 * 2026-08-04): a stage is a pure dispatch role any seat can hold on any
 * permission preset. Scouts join the round-start parallel pass, workers
 * always take a serial implementation turn, reviewers wait until every
 * non-reviewer finishes and then run (as a parallel review wave), and
 * background seats run only when explicitly delegated or @mentioned. Wave
 * lanes always dispatch under the read-clamped ("Ask") lane posture; a
 * seat's own preset governs its serial turns. No stage = the pre-stage
 * behavior, inferred purely from the seat's permissions.
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
      'Joins the parallel pass at the start of the round (any permission preset) and reports findings for the workers; scout lanes run read-clamped.'
  },
  {
    id: 'worker',
    label: 'Worker — serial implementation turn',
    description:
      'Always takes a serial turn under its own permissions, even when they would qualify it for the round-start fan-out pass.'
  },
  {
    id: 'reviewer',
    label: 'Reviewer — runs after the others finish',
    description:
      'Waits until every non-reviewer has spoken, then reviews what changed (parallel read-clamped review wave when at least two reviewers remain).'
  },
  {
    id: 'background',
    label: 'BG — async, only when delegated',
    description:
      'Skips ordinary round rotation and runs in a detached background lane only when explicitly @mentioned or delegated; cannot own Boss/Captain/synthesizer authority.'
  }
]

export const ENSEMBLE_STAGE_ROLE_HINT =
  'Staged fan-out: scouts investigate first, workers take serial implementation turns, reviewers verify last, and BG seats run asynchronously only when explicitly delegated. Leave unset to schedule purely by permissions.'

export function normalizeEnsembleStageRole(value: unknown): EnsembleStageRole | undefined {
  return value === 'scout' ||
    value === 'worker' ||
    value === 'reviewer' ||
    value === 'background'
    ? value
    : undefined
}
