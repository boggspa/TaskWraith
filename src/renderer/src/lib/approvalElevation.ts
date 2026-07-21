/**
 * Pure decision logic for the permission-mode ELEVATION warning sheets.
 *
 * Storage-agnostic on purpose: the caller owns where the "already acknowledged
 * Default approval" set is persisted (an AppSettings map keyed by
 * workspace+provider) and just passes it in. This module only decides *whether*
 * to warn and at *which tier*, so it is trivially unit-testable. Live callers:
 * the composer permission picker (solo AND ensemble-participant raises, in
 * Composer.tsx; full_access raises route to the TrustedSessionConfirmSheet
 * instead), and the side-chat picker (MainAppLayout.tsx).
 *
 * Tiers (mirrors the Claude / Codex desktop failsafes):
 *  - Tier 1 — raising up to Default Approval ('default'): a small, reassuring
 *    notice, shown ONCE per (workspace, provider).
 *  - Tier 2 — raising up to a write-capable preset (`workspace_write` or
 *    `full_access`, both provider `auto_edit`): a larger, stern notice, shown
 *    EVERY time the mode is raised to it (no suppression).
 * De-escalations (auto_edit → default, default → plan, …) never warn.
 */

export type ApprovalElevationTier = 1 | 2

/** Ordered risk rank of each approval mode; unknown modes sort lowest (safe). */
const APPROVAL_MODE_RANK: Readonly<Record<string, number>> = {
  plan: 0,
  default: 1,
  auto_edit: 2
}

export function approvalModeRank(mode: string): number {
  return APPROVAL_MODE_RANK[mode] ?? 0
}

/** True when `to` is a strictly higher-risk mode than `from`. */
export function isApprovalElevation(from: string, to: string): boolean {
  return approvalModeRank(to) > approvalModeRank(from)
}

/** Stable per-(workspace, provider) key for the Tier-1 "seen once" set. */
export function approvalElevationAckKey(
  workspacePath: string | null | undefined,
  provider: string
): string {
  const ws = workspacePath && workspacePath.trim() !== '' ? workspacePath : '__global__'
  return `${ws}|${provider}`
}

export interface ApprovalElevationDecisionInput {
  from: string
  to: string
  provider: string
  workspacePath: string | null | undefined
  /** Keys (from approvalElevationAckKey) that have already acknowledged Tier 1. */
  acknowledgedDefault: ReadonlySet<string>
}

export interface ApprovalElevationDecision {
  tier: ApprovalElevationTier
  ackKey: string
  /** Tier 1 records an ack on confirm; Tier 2 warns every time (no persistence). */
  persistAckOnConfirm: boolean
}

/**
 * Decide whether raising the approval mode should prompt a warning sheet.
 * Returns null when no sheet is needed: a de-escalation, a no-op, or a Tier-1
 * elevation already acknowledged for this (workspace, provider).
 */
export function decideApprovalElevation(
  input: ApprovalElevationDecisionInput
): ApprovalElevationDecision | null {
  const { from, to, provider, workspacePath, acknowledgedDefault } = input
  if (!isApprovalElevation(from, to)) return null

  const ackKey = approvalElevationAckKey(workspacePath, provider)

  // Tier 2 — landing on a write-capable preset. Always warn; never suppressed.
  if (to === 'auto_edit') {
    return { tier: 2, ackKey, persistAckOnConfirm: false }
  }

  // Tier 1 — landing on Default Approval. Warn once per (workspace, provider).
  if (to === 'default') {
    if (acknowledgedDefault.has(ackKey)) return null
    return { tier: 1, ackKey, persistAckOnConfirm: true }
  }

  // Any other higher (e.g. an unrecognised mode) — no sheet by default.
  return null
}

/** Return a new ack set with the given key recorded (pure; caller persists it). */
export function withApprovalElevationAck(
  acknowledgedDefault: ReadonlySet<string>,
  ackKey: string
): Set<string> {
  const next = new Set(acknowledgedDefault)
  next.add(ackKey)
  return next
}
