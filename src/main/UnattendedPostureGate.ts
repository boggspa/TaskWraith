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
// P2a (WIRED): the elevation ack is minted server-side (the
// set-workflow-unattended-elevation IPC) and HMAC-bound via
// UnattendedElevationSignature over {workflowId, workspacePath, level,
// acknowledgedApprovalMode}. index.ts `resolveUnattendedElevation` RE-VERIFIES the
// HMAC AND isUnattendedElevationAckCurrent on EVERY dispatch before honoring, so a
// plain JSON ack hand-edited into workflows.json (no valid signature) is rejected
// and the run falls back to 'plan'. This module treats the ack as a capability the
// impure caller has already authenticated. (P2b — the opt-in UI — is the remaining
// piece; until then an ack can only be minted via the IPC.)

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

/**
 * DESIGN DECISION (P2): map a verified elevation LEVEL to the permission preset
 * honored at dispatch.
 *   - 'full_access' → 'workspace_write' — auto_edit, workspace-bounded shell/file.
 *     Deliberately NOT the broader 'full_access' preset (no allow-all shell). NOTE:
 *     network egress is NOT denied by the preset itself; the unattended honoring
 *     sites (ComposerService + EnsembleOrchestrator) pass an explicit
 *     networkAccess:'deny' override, so an unattended elevated loop never gets network.
 *   - 'default'     → 'default'.
 *   - 'safe' / unknown → undefined (caller falls back to read-only).
 * One source of truth shared by both honoring sites (ComposerService + the
 * ensemble orchestrator).
 */
export function unattendedElevationPresetId(
  level: UnattendedElevationLevel | string | undefined
): 'workspace_write' | 'default' | undefined {
  if (level === 'full_access') return 'workspace_write'
  if (level === 'default') return 'default'
  return undefined
}

/**
 * The minimal WorkflowDefinition shape buildUnattendedElevationAck needs. Kept
 * structural (no store import) so this module stays Electron-free and its unit
 * tests don't drag the store in.
 */
export interface WorkflowForElevationAck {
  id: string
  workspacePath: string
  template: { approvalMode: string }
}

/**
 * Pure ack builder (no Electron, no HMAC secret). Mints the server-side ack for
 * a workflow at the given level:
 *   - 'safe' / unknown → undefined (revoke — no ack stored).
 *   - 'default' / 'full_access' → a signed ack whose `acknowledgedApprovalMode`
 *     is SERVER-DERIVED from wf.template.approvalMode (NEVER a caller arg, so the
 *     renderer can't influence what mode the ack authorizes). The `sign` closure
 *     (bound to the secret + canonical workspacePath in index.ts) produces the
 *     HMAC over the canonical tuple.
 */
export function buildUnattendedElevationAck(
  wf: WorkflowForElevationAck,
  level: string,
  sign: (tuple: {
    workflowId: string
    workspacePath: string
    level: UnattendedElevationLevel
    acknowledgedApprovalMode: string
  }) => string,
  now: () => string = () => new Date().toISOString()
): UnattendedElevationAck | undefined {
  if (level !== 'default' && level !== 'full_access') return undefined
  const acknowledgedApprovalMode = wf.template.approvalMode
  const signature = sign({
    workflowId: wf.id,
    workspacePath: wf.workspacePath,
    level,
    acknowledgedApprovalMode
  })
  return { level, acknowledgedAt: now(), acknowledgedApprovalMode, signature }
}
