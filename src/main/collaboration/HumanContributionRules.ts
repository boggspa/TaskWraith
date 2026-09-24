// Phase 2 (P2a) — durable, host-owned contribution rules for human-collaboration
// shares (the Phase 2 collaboration contract §4).
//
// The Phase 1 share `mode` ('readOnly' | 'comments') conflated three concepts:
// projection access, contribution access, and provider influence. This module
// makes them explicit as a share-scoped rules object while keeping default
// behavior byte-identical to Phase 1: a share with no persisted rules derives
// them from its `mode`, and the derived rules encode exactly what that mode
// already allowed.
//
// AUTHORITY: rules are only ever created/updated by HOST-side APIs (store /
// ChatService / host IPC). Anything arriving from a collaborator frame or the
// renderer is NOT authority — `normalizeContributionRules` is fail-closed and
// `assertSettablePreset` rejects the direct-dispatch tier outright until the
// separately security-reviewed P2c feature exists (spec §3, §4 Tier P2c).
//
// This module is PURE (no fs / no Electron) so it is unit-testable and safely
// importable from both the store and services.

import type { HumanCollaborationMode } from './HumanCollaborationStore'

export type HumanContributionPreset =
  | 'readOnly'
  | 'comments'
  | 'requestHostAction'
  | 'autoDraft'
  | 'directLimited'

export interface HumanContributionRules {
  schemaVersion: 1
  preset: HumanContributionPreset
  viewProjection: boolean
  appendComment: boolean
  requestHostAction: boolean
  createHostDraft: 'never' | 'host-click' | 'auto-draft'
  providerDispatch: 'never' | 'host-send' | 'direct-limited'
  maxContributionBytes: number
  rateLimitProfile: 'comments-v1' | 'direct-low'
  allowedCollaboratorIds?: string[]
  auditLevel: 'summary' | 'detailed'
}

/** Matches ChatService.appendCollaboratorComment's historical bound (8000). */
export const DEFAULT_MAX_CONTRIBUTION_BYTES = 8000
/** Floor so a corrupted/persisted 0 can never make every contribution fail. */
const MIN_CONTRIBUTION_BYTES = 256

/**
 * Presets a host may actually SET today. `directLimited` is deliberately not
 * settable: the P2c direct-dispatch tier requires its own security review,
 * protocol negotiation, signed posture derivation, and adversarial tests before
 * any surface may enable it (spec §3 "Hard No-Gos", §4 Tier P2c). The preset
 * name exists in the type so future work has a stable identifier, but every
 * write path rejects it and normalization degrades it to comments-equivalent.
 */
export const SETTABLE_CONTRIBUTION_PRESETS: readonly HumanContributionPreset[] = [
  'readOnly',
  'comments',
  'requestHostAction',
  'autoDraft'
]

export function assertSettablePreset(preset: string): HumanContributionPreset {
  if (!(SETTABLE_CONTRIBUTION_PRESETS as readonly string[]).includes(preset)) {
    throw new HumanCollaborationDenialError(
      'protocol_unsupported',
      `Contribution preset is not available: ${String(preset).slice(0, 40)}`
    )
  }
  return preset as HumanContributionPreset
}

/** The canonical rules object for each preset. Pure data; never mutated. */
export function contributionRulesForPreset(preset: HumanContributionPreset): HumanContributionRules {
  switch (preset) {
    case 'readOnly':
      return {
        schemaVersion: 1,
        preset: 'readOnly',
        viewProjection: true,
        appendComment: false,
        requestHostAction: false,
        createHostDraft: 'never',
        providerDispatch: 'never',
        maxContributionBytes: DEFAULT_MAX_CONTRIBUTION_BYTES,
        rateLimitProfile: 'comments-v1',
        auditLevel: 'summary'
      }
    case 'requestHostAction':
      return {
        schemaVersion: 1,
        preset: 'requestHostAction',
        viewProjection: true,
        appendComment: true,
        requestHostAction: true,
        createHostDraft: 'host-click',
        providerDispatch: 'never',
        maxContributionBytes: DEFAULT_MAX_CONTRIBUTION_BYTES,
        rateLimitProfile: 'comments-v1',
        auditLevel: 'summary'
      }
    case 'autoDraft':
      return {
        schemaVersion: 1,
        preset: 'autoDraft',
        viewProjection: true,
        appendComment: true,
        requestHostAction: true,
        createHostDraft: 'auto-draft',
        providerDispatch: 'never',
        maxContributionBytes: DEFAULT_MAX_CONTRIBUTION_BYTES,
        rateLimitProfile: 'comments-v1',
        auditLevel: 'summary'
      }
    // 'directLimited' (not settable) and 'comments' both land here; the former
    // is degraded to the comments-equivalent shape so a persisted/forged
    // direct-tier object can never grant dispatch (providerDispatch stays
    // 'never' until P2c exists).
    case 'directLimited':
    case 'comments':
    default:
      return {
        schemaVersion: 1,
        preset: 'comments',
        viewProjection: true,
        appendComment: true,
        requestHostAction: false,
        createHostDraft: 'host-click',
        providerDispatch: 'never',
        maxContributionBytes: DEFAULT_MAX_CONTRIBUTION_BYTES,
        rateLimitProfile: 'comments-v1',
        auditLevel: 'summary'
      }
  }
}

/** Phase 1 migration (spec §4): mode → equivalent rules, behavior unchanged. */
export function deriveContributionRules(mode: HumanCollaborationMode): HumanContributionRules {
  return contributionRulesForPreset(mode === 'comments' ? 'comments' : 'readOnly')
}

/**
 * The legacy mode a rules object implies. Kept in lockstep with
 * `share.mode` when rules change so every Phase 1 gate (store mode checks,
 * projection, handshake context `shareMode`, invite payloads, v1 clients)
 * remains consistent without knowing about rules.
 */
export function contributionModeForRules(rules: HumanContributionRules): HumanCollaborationMode {
  return rules.appendComment ? 'comments' : 'readOnly'
}

/**
 * Fail-closed normalization for a PERSISTED (or otherwise untrusted-shape)
 * rules object. Every enum is whitelisted; anything unexpected degrades to the
 * preset baseline rather than widening. In particular a stored
 * `providerDispatch: 'direct-limited'` is clamped back to 'never' — dispatch
 * authority cannot enter through a JSON file (spec §7).
 */
export function normalizeContributionRules(value: unknown): HumanContributionRules | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const preset: HumanContributionPreset = (
    SETTABLE_CONTRIBUTION_PRESETS as readonly string[]
  ).includes(String(raw.preset))
    ? (String(raw.preset) as HumanContributionPreset)
    : 'comments'
  const base = contributionRulesForPreset(preset)
  const maxBytes =
    typeof raw.maxContributionBytes === 'number' && Number.isFinite(raw.maxContributionBytes)
      ? Math.min(
          DEFAULT_MAX_CONTRIBUTION_BYTES,
          Math.max(MIN_CONTRIBUTION_BYTES, Math.floor(raw.maxContributionBytes))
        )
      : base.maxContributionBytes
  const allowed = Array.isArray(raw.allowedCollaboratorIds)
    ? raw.allowedCollaboratorIds
        .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        .slice(0, 8)
    : undefined
  return {
    ...base,
    // Booleans may only NARROW the preset baseline, never widen it.
    viewProjection: base.viewProjection && raw.viewProjection !== false,
    appendComment: base.appendComment && raw.appendComment !== false,
    requestHostAction: base.requestHostAction && raw.requestHostAction !== false,
    createHostDraft:
      raw.createHostDraft === 'never'
        ? 'never'
        : raw.createHostDraft === 'host-click' && base.createHostDraft === 'auto-draft'
          ? 'host-click'
          : base.createHostDraft,
    // providerDispatch is hard-pinned to the preset baseline ('never' for every
    // settable preset) — persisted values cannot widen it.
    providerDispatch: base.providerDispatch,
    maxContributionBytes: maxBytes,
    auditLevel: raw.auditLevel === 'detailed' ? 'detailed' : 'summary',
    ...(allowed && allowed.length ? { allowedCollaboratorIds: allowed } : {})
  }
}

/**
 * The rules in force for a share: persisted rules when present, else the
 * Phase 1 derivation from `mode`. Callers must treat the result as read-only.
 */
export function effectiveContributionRules(share: {
  mode: HumanCollaborationMode
  contributionRules?: HumanContributionRules
}): HumanContributionRules {
  return share.contributionRules ?? deriveContributionRules(share.mode)
}

// ── Typed denials (spec §5 IPC) ──────────────────────────────────────────────
// Codes ride ALONGSIDE the human-readable message (never replacing it) so the
// existing ~15 message-regex test assertions and any user-facing surfaces keep
// working; new callers can switch on `code` instead of parsing text.

export type HumanCollaborationDenialCode =
  | 'read_only'
  | 'rule_denied'
  | 'quota_exceeded'
  | 'revoked'
  | 'stale_session'
  | 'protocol_unsupported'
  | 'duplicate_contribution'

export class HumanCollaborationDenialError extends Error {
  readonly code: HumanCollaborationDenialCode

  constructor(code: HumanCollaborationDenialCode, message: string) {
    super(message)
    this.name = 'HumanCollaborationDenialError'
    this.code = code
  }
}

/** The typed denial code for an error, if it carries one. */
export function humanCollaborationDenialCode(error: unknown): HumanCollaborationDenialCode | null {
  return error instanceof HumanCollaborationDenialError ? error.code : null
}
