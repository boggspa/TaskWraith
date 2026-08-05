/**
 * Pure decision logic for the permission-mode ELEVATION warning sheets and the
 * one-per-workspace edit-consent notice.
 *
 * Storage-agnostic on purpose: the caller owns where the "already acknowledged
 * Accept Edits" set is persisted (the AppSettings
 * `approvalModeElevationAcknowledgements` Record) and just passes it in. This
 * module only decides *whether* to warn and at *which tier*, so it is
 * trivially unit-testable. Live callers: the composer permission picker (solo
 * AND ensemble-participant raises, in Composer.tsx; full_access raises route
 * to the TrustedSessionConfirmSheet instead), the side-chat picker, and the
 * first-prompt send gate in App.tsx's handleRun.
 *
 * Tiers (mirrors the Claude / Codex desktop failsafes):
 *  - Tier 1 — the workspace edit-consent notice for Accept Edits ('default'):
 *    a small, reassuring notice shown ONCE PER WORKSPACE (owner directive
 *    2026-08-05). It is deliberately provider/participant-agnostic — one
 *    Continue covers every agent, model, and seat that will ever work in the
 *    workspace, matching the 'agents'-wide workspace grants.
 *  - Tier 2 — raising up to a write-capable preset (`workspace_write` or
 *    `full_access`, both provider `auto_edit`): a larger, stern notice, shown
 *    EVERY time the mode is raised to it (no suppression). Confirming it ALSO
 *    records the workspace consent, so the milder Tier-1 never re-asks a
 *    workspace the user already trusted at a sterner tier.
 * De-escalations (auto_edit → default, default → plan, …) never warn.
 *
 * Legacy compatibility: acks used to be keyed `${workspacePath}|${provider}`.
 * Any such row proves the user consented in that workspace at least once, so
 * it auto-carries — existing workspaces and threads are never re-prompted.
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

/**
 * Stable per-WORKSPACE key for the "seen once" set. No provider component:
 * the consent belongs to the workspace, not to whichever seat asked first.
 */
export function approvalElevationAckKey(workspacePath: string | null | undefined): string {
  return workspacePath && workspacePath.trim() !== '' ? workspacePath : '__global__'
}

/**
 * Has this workspace already been consented? Matches the workspace-only key
 * AND any legacy `${workspacePath}|${provider}` row — a per-provider ack from
 * the old scheme still proves a human said yes here, so it silences the
 * notice for every agent (the exact separator guards against workspace paths
 * that prefix each other).
 */
export function hasApprovalElevationAck(
  acknowledgedDefault: ReadonlySet<string>,
  workspacePath: string | null | undefined
): boolean {
  const key = approvalElevationAckKey(workspacePath)
  if (acknowledgedDefault.has(key)) return true
  const legacyPrefix = `${key}|`
  for (const entry of acknowledgedDefault) {
    if (entry.startsWith(legacyPrefix)) return true
  }
  return false
}

export interface ApprovalElevationDecisionInput {
  from: string
  to: string
  workspacePath: string | null | undefined
  /** Keys that have already acknowledged the workspace notice (new
   * workspace-only keys and/or legacy `ws|provider` rows). */
  acknowledgedDefault: ReadonlySet<string>
}

export interface ApprovalElevationDecision {
  tier: ApprovalElevationTier
  ackKey: string
  /** Both tiers record the workspace consent on confirm; Tier 2 still warns
   * every time regardless (its decision below never consults the ack set). */
  persistAckOnConfirm: boolean
}

/**
 * Decide whether raising the approval mode should prompt a warning sheet.
 * Returns null when no sheet is needed: a de-escalation, a no-op, or a Tier-1
 * elevation in a workspace that has already consented (any agent, ever).
 */
export function decideApprovalElevation(
  input: ApprovalElevationDecisionInput
): ApprovalElevationDecision | null {
  const { from, to, workspacePath, acknowledgedDefault } = input
  if (!isApprovalElevation(from, to)) return null

  const ackKey = approvalElevationAckKey(workspacePath)

  // Tier 2 — landing on a write-capable preset. Always warn; never suppressed.
  if (to === 'auto_edit') {
    return { tier: 2, ackKey, persistAckOnConfirm: true }
  }

  // Tier 1 — landing on Accept Edits. Warn once per workspace, for all agents.
  if (to === 'default') {
    if (hasApprovalElevationAck(acknowledgedDefault, workspacePath)) return null
    return { tier: 1, ackKey, persistAckOnConfirm: true }
  }

  // Any other higher (e.g. an unrecognised mode) — no sheet by default.
  return null
}

export interface FirstSendWorkspaceConsentInput {
  /** Effective approval modes riding this send: the solo run's mode, or every
   * enabled ensemble seat's mode. */
  approvalModes: readonly string[]
  workspacePath: string | null | undefined
  acknowledgedDefault: ReadonlySet<string>
}

/**
 * The owner-specified consent moment (2026-08-05): the FIRST prompt sent into
 * a never-consented workspace at an edit-capable mode raises the one generic
 * Tier-1 notice; after Continue, workspace grants flow autonomously for every
 * agent. Read-only sends (plan-mode ranks) edit nothing and stay silent, and
 * auto_edit-only sends are covered by their own always-on Tier-2 raise flow —
 * Full WS Access / Full Access behavior is unchanged.
 */
export function decideFirstSendWorkspaceConsent(
  input: FirstSendWorkspaceConsentInput
): ApprovalElevationDecision | null {
  const { approvalModes, workspacePath, acknowledgedDefault } = input
  if (!approvalModes.some((mode) => mode === 'default')) return null
  if (hasApprovalElevationAck(acknowledgedDefault, workspacePath)) return null
  return { tier: 1, ackKey: approvalElevationAckKey(workspacePath), persistAckOnConfirm: true }
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
