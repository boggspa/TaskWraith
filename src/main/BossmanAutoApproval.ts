import type { AgenticServiceId } from './store/types'
import {
  configuredEnsembleCaptainParticipantIds,
  resolveActingCaptainParticipantId
} from './EnsembleAuthorityResolution'

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
  /** The Ensemble's configured Captain participant id (if any). */
  secondInCommandParticipantId?: string | undefined
  /** Canonical configured Captain ids. The scalar above is legacy-only. */
  captainParticipantIds?: readonly string[]
  /** Captains unavailable for this approval (quota/runtime/round state). */
  unavailableCaptainParticipantIds?: readonly string[]
  /** Whether the primary Boss is currently unavailable for this approval. */
  primaryBossUnavailable?: boolean
  primaryBossUnavailableReason?: string
  /** The opt-in auto-approval consent recorded on the ensemble config. */
  autoApprovals: { enabled?: boolean; mode?: string; confirmedAt?: string } | undefined
  /** All participant ids currently in the roster. */
  participantIds: string[]
  /** Ordered authority projection; falls back to `participantIds` for legacy callers. */
  authorityParticipants?: readonly {
    id: string
    order?: number
    enabled?: boolean
    stageRole?: string
  }[]
  /**
   * Roster ids held by EXTERNAL human collaborators (the People/Shares
   * externals), when the caller can resolve them. Named `externalParticipant*`
   * rather than bare `external*` because `hasExternalPathDetection` above
   * already spends the word "external" on out-of-workspace FILESYSTEM paths;
   * these are seats, in the same id namespace as `participantIds`.
   *
   * Absent or empty means "this caller resolved no externals" and is treated
   * exactly as the pre-external behaviour, so nothing regresses before the
   * callers are updated. That is a migration affordance, not a safety
   * property: every caller that can seat an external MUST populate this, and a
   * present-but-non-array value is refused rather than ignored.
   */
  externalParticipantIds?: readonly string[]
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
 *  - requires a live Boss or Captain authority plus a live requesting
 *    participant;
 *  - never lets an EXTERNAL human collaborator holding Boss/Captain approve
 *    anything for anybody (see the external-authority refusal below).
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
  if (autoApprovals?.enabled !== true) return null
  if (autoApprovals.mode !== 'permission_preset_once') return null
  // Persisted Ensembles require exactly one configured Boss. Captain fallback
  // is availability routing, never a substitute configuration.
  if (!bossmanParticipantId) return null
  // Boss remains primary. Captain only becomes the approval authority when
  // the primary Boss is unavailable, so the backup cannot silently compete
  // with an available Boss.
  const bossIsLive =
    Boolean(bossmanParticipantId) && ctx.participantIds.includes(bossmanParticipantId as string)
  const authorityParticipants =
    ctx.authorityParticipants ?? ctx.participantIds.map((id, order) => ({ id, order }))
  const captainParticipantIds = configuredEnsembleCaptainParticipantIds({
    participants: authorityParticipants,
    bossmanParticipantId,
    captainParticipantIds: ctx.captainParticipantIds,
    secondInCommandParticipantId: ctx.secondInCommandParticipantId
  })
  const secondInCommandParticipantId = captainParticipantIds[0]
  const unavailableCaptainParticipantIds = new Set(ctx.unavailableCaptainParticipantIds || [])
  const actingCaptainParticipantId = resolveActingCaptainParticipantId({
    participants: authorityParticipants,
    bossmanParticipantId,
    captainParticipantIds,
    unavailableParticipantIds: unavailableCaptainParticipantIds
  })
  const authority = bossIsLive && ctx.primaryBossUnavailable !== true
    ? {
        role: 'boss' as const,
        participantId: bossmanParticipantId as string
      }
    : actingCaptainParticipantId && ctx.primaryBossUnavailable === true
      ? {
          role: 'captain' as const,
          participantId: actingCaptainParticipantId
        }
      : null
  if (!authority) return null
  // INVARIANT: an approval authority held by an EXTERNAL human collaborator
  // auto-resolves nothing, for anybody, ever.
  //
  // Externals deliberately never receive approval prompts, so an external Boss
  // — or Captain, on the fallback path above — would see no modal AND silently
  // allow every other seat's shell/file request. That inverts the authority
  // checkpoint's documented contract, which "never changes provider admission
  // or permissions" (`EnsembleAuthorityRoutingCheckpoint`) and reshapes the
  // remaining queue only.
  //
  // The refusal is deliberately independent of roster membership.
  // `participantIds` answers "is this seat live", never "may this seat
  // approve", so an id present in BOTH lists is external and refused: sitting
  // in the roster must not buy back an authority the external half denies.
  // Until callers pass an effective roster, the hole is closed only by
  // REPRESENTATION (externals are not yet members of
  // `chat.ensemble.participants`, so their ids never reach `participantIds`);
  // this makes it a rule instead, ahead of the first caller that seats one.
  if (ctx.externalParticipantIds !== undefined) {
    // Unusable evidence about who is external is NOT the same as no externals:
    // a value that arrives in the wrong shape is refused, not ignored.
    if (!Array.isArray(ctx.externalParticipantIds)) return null
    if (ctx.externalParticipantIds.includes(authority.participantId)) return null
  }
  if (!ctx.targetParticipantId || !ctx.participantIds.includes(ctx.targetParticipantId)) {
    return null
  }

  return {
    policy: ctx.policy,
    mode: autoApprovals.mode,
    confirmedAt: autoApprovals.confirmedAt,
    bossmanParticipantId,
    captainParticipantIds,
    secondInCommandParticipantId,
    approvalAuthorityRole: authority.role,
    approvalAuthorityParticipantId: authority.participantId,
    primaryBossUnavailableReason: ctx.primaryBossUnavailableReason,
    targetParticipantId: ctx.targetParticipantId,
    targetProvider: ctx.targetProvider,
    targetRole: ctx.targetRole,
    roundId: ctx.roundId,
    actionClass: ctx.service,
    rationale:
      'Boss/Captain Auto Approvals enabled by the user; request-scoped approval within participant permission preset and workspace policy.'
  }
}
