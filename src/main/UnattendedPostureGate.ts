// MAIN-process "unattended posture gate". Pure logic — the safe-posture decision
// for a run that fires with NO human present (a scheduled-task / workflow
// occurrence). The impure caller (ComposerService.composeRun) applies the result.
//
// WHY THIS EXISTS
// ---------------
// A workflow created while the composer sat in 'auto_edit' bakes auto_edit into
// WorkflowDefinition.template.approvalMode; materialize copies it into the
// ScheduledTask, the renderer re-applies it, and ComposerService signs it — so an
// unattended run silently auto-accepts every file edit (claudePermissionModeForApproval
// maps every non-plan mode -> acceptEdits). capRequestedApprovalMode CANNOT stop
// this: its "trusted" ceiling is the scheduled chat's OWN persisted auto_edit
// metadata (a poisoned floor → the cap is a no-op), and the no-appRunId cap is
// bypassed because scheduled runs carry an appRunId.
//
// FIX: when ComposerService composes an UNATTENDED run (scheduledTaskId present) it
// FORCES the posture derived here — NOT capped against the poisoned chat ceiling.
// Fail-closed default (no explicit, current elevation ack) is 'plan' (read-only,
// prompt-or-deny). An explicit ack on the WorkflowDefinition can authorize a higher
// mode, but the result NEVER rises above what the user actually requested.
//
// NOTE (P2 follow-on): the elevation ack is NOT YET created / stored / verified.
// Until the opt-in UI + an HMAC-bound ack land, callers pass `undefined` and every
// unattended run clamps to 'plan'. When wiring the ack, VERIFY its provenance
// (an HMAC over {workflowId, workspacePath, level, acknowledgedApprovalMode}, the
// way RunPermissionPosture signs postures) BEFORE trusting `ack.level` — a plain
// JSON ack is forgeable by a local workflows.json edit and must not be a security
// boundary on its own. This module deliberately treats the ack as a capability
// the impure caller has already authenticated.

import { approvalModeRank, coerceApprovalMode } from './RunPermissionPosture'

export type UnattendedElevationLevel = 'safe' | 'default' | 'full_access'

export interface UnattendedElevationAck {
  level: UnattendedElevationLevel
  /** ISO timestamp the user confirmed the elevation (Tier-4-style "are you sure"). */
  acknowledgedAt: string
  /** The template approvalMode the ack was confirmed against. Editing the workflow's
   * mode after acking invalidates it (see isUnattendedElevationAckCurrent). */
  acknowledgedApprovalMode: string
  /** P2: HMAC binding the ack to {workflowId, workspacePath, level, mode}. Until a
   * caller verifies it, the ack is forgeable; an unsigned/unverified ack must be
   * treated as absent (→ safe). */
  signature?: string
}

/** Fail-closed safe posture for an unattended run: read-only / prompt-or-deny. */
export const UNATTENDED_SAFE_APPROVAL_MODE = 'plan'

/**
 * The approval mode an unattended occurrence may run with. Fail-closed:
 *   - no ack, level 'safe', or an unknown level  → 'plan' (the safe floor)
 *   - level 'default'      → cap the request at 'default' (auto_edit → default)
 *   - level 'full_access'  → cap the request at 'auto_edit'
 * NEVER raises: a requested 'plan'/'default' is preserved even under a full_access
 * ack — the ceiling only ever LOWERS an over-elevated request. An unrecognized
 * requested mode collapses to 'default' (coerceApprovalMode) before capping, so an
 * unknown string can never sneak past as an auto-approve.
 */
export function resolveUnattendedApprovalMode(
  ack: UnattendedElevationAck | undefined,
  requested: string | undefined
): string {
  const requestedSafe = coerceApprovalMode(requested) || 'default'
  if (!ack || ack.level === 'safe') return UNATTENDED_SAFE_APPROVAL_MODE
  const ceiling =
    ack.level === 'full_access' ? 'auto_edit' : ack.level === 'default' ? 'default' : null
  if (!ceiling) return UNATTENDED_SAFE_APPROVAL_MODE // unknown level → fail closed
  return approvalModeRank(requestedSafe) > approvalModeRank(ceiling) ? ceiling : requestedSafe
}

/**
 * An elevation ack only authorizes the exact mode it was confirmed against. If the
 * workflow's template approvalMode changed after the ack — or the ack's level no
 * longer covers that mode — the ack is stale and must be treated as absent (→ safe).
 * Pure STRUCTURAL check only; cryptographic provenance (HMAC) is a separate step
 * the impure caller performs before passing the ack in.
 */
export function isUnattendedElevationAckCurrent(
  ack: UnattendedElevationAck | undefined,
  templateApprovalMode: string | undefined
): boolean {
  if (!ack || ack.level === 'safe') return false
  if (ack.acknowledgedApprovalMode !== templateApprovalMode) return false
  const templateSafe = coerceApprovalMode(templateApprovalMode) || 'default'
  // The ack's ceiling must actually authorize the template mode it claims.
  const resolved = resolveUnattendedApprovalMode(ack, templateSafe)
  return resolved === templateSafe && resolved !== UNATTENDED_SAFE_APPROVAL_MODE
}
