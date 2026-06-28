import type { AgenticServiceId } from './store/types'

/**
 * Pure decision core for Boss Auto Approvals.
 *
 * Extracted from `index.ts`'s `bossmanAutoApprovalMetadata` so the
 * security-critical gate can be unit-tested in isolation (the index.ts
 * wrapper only resolves the live session/chat then delegates here).
 *
 * The gate is intentionally CONSERVATIVE and fail-closed. It returns the
 * ledger metadata to auto-allow ONLY when every guard passes; otherwise it
 * returns `null` so the caller falls through to the real human prompt. It is
 * evaluated AFTER the deny / session-YOLO / explicit-allow branches in
 * `requestAgenticServiceApproval`, so a hard policy deny always wins first and
 * an already-granted allow never reaches here.
 */
export interface BossmanAutoApprovalContext {
  /** The agentic service being requested (shell/file/mcp/…). */
  service: AgenticServiceId
  /** Permission-resolution outcome for the requesting run. Only `'ask'`
   * (the human-prompt band) is eligible — `'deny'`/`'allow'` are handled
   * by earlier branches and must never be auto-resolved here. */
  decision: string
  /** Policy label recorded into the ledger row for review. */
  policy: string
  /** Services that are never auto-allowed by any grant (e.g. canvasEval/RCE). */
  neverAutoAllow: boolean
  /** The requesting run's read-only posture. Read-only is never widened. */
  readOnly: boolean
  /** The request explicitly demanded a human prompt. */
  forcePrompt: boolean
  /** The request touches an out-of-workspace path (external-path escape). */
  hasExternalPathDetection: boolean
  /** The Ensemble's configured Boss participant id (if any). */
  bossmanParticipantId: string | undefined
  /** The opt-in auto-approval consent recorded on the ensemble config. */
  autoApprovals: { enabled?: boolean; mode?: string; confirmedAt?: string } | undefined
  /** All participant ids currently in the roster. */
  participantIds: string[]
  /** The requesting (target) participant — must be a live roster member. */
  targetParticipantId: string | undefined
  targetProvider: string | undefined
  targetRole: string | undefined
  roundId: string | undefined
}

/**
 * Returns ledger metadata when a Boss-managed Ensemble may auto-resolve a
 * single, preset-limited approval for the requesting participant — or `null`
 * to fall through to a human prompt.
 *
 * Hard guarantees (each enforced below, in order):
 *  - never overrides a hard deny (only `decision === 'ask'` is eligible);
 *  - never auto-allows a never-auto-allow service (canvasEval/RCE);
 *  - never widens a read-only run;
 *  - never approves a forced prompt or an external-path escape;
 *  - only the `shellCommands`/`fileChanges` action classes are in scope
 *    (so MCP-tool / sub-thread / canvas grants are NEVER auto-allowed);
 *  - requires explicit, mode-correct user consent;
 *  - requires both Boss and the requesting participant to be live roster
 *    members.
 * The returned grant is always request-scoped (the caller passes `'request'`).
 */
export function evaluateBossmanAutoApproval(
  ctx: BossmanAutoApprovalContext
): Record<string, unknown> | null {
  // Only the human-prompt band is eligible. A hard deny (or an explicit
  // allow) is resolved by the branches that run before this gate.
  if (ctx.decision !== 'ask') return null
  // canvasEval and any other signed-elevated service is off-limits.
  if (ctx.neverAutoAllow) return null
  // A forced prompt or an external-path escape always reaches the human.
  if (ctx.forcePrompt || ctx.hasExternalPathDetection) return null
  // Read-only is a ceiling Boss cannot lift.
  if (ctx.readOnly) return null
  // Only file/shell action classes are in scope. MCP-tool, sub-thread, and
  // canvas grants are deliberately excluded so Boss can never touch the
  // MCP auto-allow surface or YOLO.
  if (ctx.service !== 'shellCommands' && ctx.service !== 'fileChanges') return null

  const { bossmanParticipantId, autoApprovals } = ctx
  // Explicit, current user consent is mandatory.
  if (!bossmanParticipantId || autoApprovals?.enabled !== true) return null
  if (autoApprovals.mode !== 'permission_preset_once') return null
  // Both the Boss and the acting participant must be live roster members —
  // a stale id (replaced/removed mid-round) revokes the grant.
  if (!ctx.participantIds.includes(bossmanParticipantId)) return null
  if (!ctx.targetParticipantId || !ctx.participantIds.includes(ctx.targetParticipantId)) {
    return null
  }

  return {
    policy: ctx.policy,
    mode: autoApprovals.mode,
    confirmedAt: autoApprovals.confirmedAt,
    bossmanParticipantId,
    targetParticipantId: ctx.targetParticipantId,
    targetProvider: ctx.targetProvider,
    targetRole: ctx.targetRole,
    roundId: ctx.roundId,
    actionClass: ctx.service,
    rationale:
      'Boss Auto Approvals enabled by the user; request-scoped approval within participant permission preset and workspace policy.'
  }
}
