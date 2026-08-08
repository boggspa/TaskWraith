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
// acknowledgedApprovalMode, authorityDigest}. index.ts `resolveUnattendedElevation` RE-VERIFIES the
// HMAC AND isUnattendedElevationAckCurrent on EVERY dispatch before honoring, so
// renderer/persistence edits to either the ack or execution envelope are rejected
// and the run falls back to 'plan'. This protects the renderer trust boundary; a
// same-user attacker able to execute code in MAIN or obtain its process secret is
// outside this capability boundary. This module treats the ack as a capability the
// impure caller has already authenticated.

import { approvalModeRank, coerceApprovalMode } from './RunPermissionPosture'

export type UnattendedElevationLevel = 'safe' | 'default' | 'full_access'

export interface UnattendedElevationAck {
  level: UnattendedElevationLevel
  /** ISO timestamp the user confirmed the elevation (Tier-4-style "are you sure"). */
  acknowledgedAt: string
  /** The template approvalMode the ack was confirmed against. */
  acknowledgedApprovalMode: string
  /** Digest of the complete unattended execution authority envelope confirmed
   * by the user. Legacy acks without this binding fail closed. */
  authorityDigest: string
  /** P2: HMAC binding the ack to workflow identity, level, mode and authority digest. Until a
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
 * workflow's authority digest or template approvalMode changed after the ack — or
 * the ack's level no longer covers that mode — the ack is stale and must be treated as absent (→ safe).
 * Pure STRUCTURAL check only; cryptographic provenance (HMAC) is a separate step
 * the impure caller performs before passing the ack in.
 */
export function isUnattendedElevationAckCurrent(
  ack: UnattendedElevationAck | undefined,
  templateApprovalMode: string | undefined,
  authorityDigest: string
): boolean {
  if (!ack || ack.level === 'safe') return false
  if (!/^[0-9a-f]{64}$/i.test(ack.authorityDigest)) return false
  if (ack.authorityDigest !== authorityDigest) return false
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
 *   - 'safe' / unknown → undefined (caller falls back to the plan no-ask floor).
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
 * Agentic-service overrides applied on EVERY unattended resolve (plan floor and
 * verified elevation). Attended Plan may modal-approve `subThreadDelegation`
 * (2026-08-08), but a scheduled/unattended run must never block on that modal
 * or silently auto-spawn child seats under elevated Accept Edits / Full WS.
 */
export function unattendedSubThreadDelegationOverride(): {
  agenticServices: { subThreadDelegation: 'deny' }
} {
  return { agenticServices: { subThreadDelegation: 'deny' } }
}

/** Structural slice of EffectiveRunPermissions — no store import. */
export type UnattendedSimulatorCanvasEffective = {
  presetId: string
  readOnly: boolean
  agenticServices: { simulatorCanvas: 'ask' | 'workspace' | 'allow' | 'deny' }
  workspaceGrantServiceIds: readonly string[]
}

/**
 * Fork 4B — unattended Simulator Canvas gate (applied AFTER resolve).
 *
 * Unlike `subThreadDelegation` (hard deny on every unattended resolve):
 *   - plan-floor unattended: KEEP ask (timer deny) — no-op
 *   - elevated unattended WITHOUT an explicit simulatorCanvas workspace grant:
 *     force ask so Accept Edits / Full WS cannot silently simctl-mutate
 *   - elevated unattended WITH an explicit simulatorCanvas workspace grant:
 *     allow (session grants still auto-approve at the approval gate when the
 *     signed posture is ask)
 *
 * Global deny is preserved either way.
 */
export function unattendedSimulatorCanvasOverride(
  effective: UnattendedSimulatorCanvasEffective
): { agenticServices: { simulatorCanvas: 'ask' | 'allow' } } | Record<string, never> {
  const policy = effective.agenticServices.simulatorCanvas
  if (policy === 'deny') return {}

  const planFloor =
    effective.readOnly === true ||
    effective.presetId === 'plan' ||
    effective.presetId === 'read_only'
  if (planFloor) return {}

  const hasExplicitGrant = effective.workspaceGrantServiceIds.includes('simulatorCanvas')
  if (hasExplicitGrant) {
    return { agenticServices: { simulatorCanvas: 'allow' } }
  }
  // Elevated without grant: demote preset allow / grant-tier workspace to ask.
  if (policy === 'allow' || policy === 'workspace') {
    return { agenticServices: { simulatorCanvas: 'ask' } }
  }
  return {}
}

/** Merge a fork-4B Simulator Canvas override into already-resolved permissions. */
export function applyUnattendedSimulatorCanvasOverride<T extends UnattendedSimulatorCanvasEffective>(
  effective: T
): T {
  const override = unattendedSimulatorCanvasOverride(effective)
  const next = override.agenticServices?.simulatorCanvas
  if (!next || effective.agenticServices.simulatorCanvas === next) return effective
  return {
    ...effective,
    agenticServices: {
      ...effective.agenticServices,
      simulatorCanvas: next
    }
  }
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
  authorityDigest: string,
  sign: (tuple: {
    workflowId: string
    workspacePath: string
    level: UnattendedElevationLevel
    acknowledgedApprovalMode: string
    authorityDigest: string
  }) => string,
  now: () => string = () => new Date().toISOString()
): UnattendedElevationAck | undefined {
  if (level !== 'default' && level !== 'full_access') return undefined
  if (!/^[0-9a-f]{64}$/i.test(authorityDigest)) return undefined
  const acknowledgedApprovalMode = wf.template.approvalMode
  const signature = sign({
    workflowId: wf.id,
    workspacePath: wf.workspacePath,
    level,
    acknowledgedApprovalMode,
    authorityDigest
  })
  return {
    level,
    acknowledgedAt: now(),
    acknowledgedApprovalMode,
    authorityDigest,
    signature
  }
}
