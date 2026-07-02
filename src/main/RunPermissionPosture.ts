import { createHmac, timingSafeEqual } from 'node:crypto'
import type { EffectiveRunPermissions } from './store/types'

/**
 * Downgrade-only clamp for a run's permission posture
 * (`approvalMode` + `effectivePermissions`) at the
 * `normalizeAgentRunPayload` trust boundary.
 *
 * WHY THIS EXISTS
 * ---------------
 * `normalizeAgentRunPayload` is NOT a renderer-only boundary. Via
 * `RunCoordinator.dispatch → normalizePayload` it is shared by four
 * payload sources:
 *   - the `run-agent` IPC handler (the renderer round-trips the
 *     main-composed payload back to us — UNTRUSTED: a buggy/compromised
 *     renderer, or the future imported-plan execute path, can tamper the
 *     posture between `compose-run` and `run-agent`);
 *   - EnsembleOrchestrator, sub-thread delegation, and the solo-chat wakeup
 *     service (MAIN-BUILT — these legitimately carry
 *     `approvalMode` / `effectivePermissions` derived from presets, overrides,
 *     inheritance, or persisted chat posture, and are never exposed to the
 *     renderer for mutation before dispatch).
 *
 * A legitimate ensemble `full_access` payload and a tampered renderer one
 * can be byte-for-byte identical, so CONTENT alone cannot distinguish
 * them — only PROVENANCE can. We therefore HMAC-sign the posture in every
 * main-side producer (using the same persisted process secret that signs
 * external path grants) and verify it here. Signatures are also bound to
 * stable run context (`appRunId`, chat id, prompt, provider, scope, runtime
 * profile) so a permissive signature is not a reusable bearer token across
 * unrelated payloads. This mirrors
 * `isMainIssuedExternalPathGrant` for the sibling field in the same
 * function, and complements `preserveExplicitDeny` (which already stops a
 * payload from *un-denying* a global deny) by closing the complementary
 * escalation-via-payload gap.
 *
 * The module is deliberately free of Electron / AppStore coupling so it
 * unit-tests under plain vitest: the secret, the verifier, and the
 * read-only/default re-derivation are all injected by the caller.
 */

/**
 * Ordered risk rank of each approval mode; mirrors
 * src/renderer/src/lib/approvalElevation.ts:21 (that module is
 * renderer-scoped, so main keeps its own copy). Unknown modes sort
 * lowest (safe).
 */
const APPROVAL_MODE_RANK: Readonly<Record<string, number>> = {
  plan: 0,
  default: 1,
  auto_edit: 2
}

const RECOGNIZED_APPROVAL_MODES: ReadonlySet<string> = new Set(Object.keys(APPROVAL_MODE_RANK))

export function approvalModeRank(mode: string | null | undefined): number {
  return mode ? (APPROVAL_MODE_RANK[mode] ?? 0) : 0
}

/**
 * Coerce a free-form approval mode to one of the three recognized
 * values. `undefined`/empty passes through (the provider's own default
 * applies downstream); any other unrecognized string collapses to
 * `'default'` (always-prompt — never an auto-approve), matching the
 * long-standing global-scope coercion in `normalizeAgentRunPayload`.
 */
export function coerceApprovalMode(mode: string | null | undefined): string | undefined {
  if (mode === undefined || mode === null || mode === '') return undefined
  return RECOGNIZED_APPROVAL_MODES.has(mode) ? mode : 'default'
}

/**
 * Deterministic serialization for HMAC signing/verification.
 * Recursively sorts object keys so two semantically-equal postures sign
 * identically regardless of property insertion order (Electron's
 * structured clone across the IPC boundary does not guarantee order).
 * Array element order IS preserved — `effectivePermissions` arrays
 * (externalPathGrants, workspaceGrantServiceIds) are produced in a
 * stable order by `resolveEffectiveRunPermissions`.
 */
export function canonicalRunPermissionPosture(
  approvalMode: string | null | undefined,
  effectivePermissions: EffectiveRunPermissions | null | undefined,
  context?: RunPermissionPostureContext | null
): string {
  return stableStringify({
    approvalMode: approvalMode ?? null,
    effectivePermissions: effectivePermissions ?? null,
    context: normalizeRunPermissionPostureContext(context)
  })
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

/**
 * Sign a run permission posture. The signature binds BOTH the approvalMode
 * and the effectivePermissions object as a pair, plus optional run context —
 * signing even when `effectivePermissions` is undefined so the approvalMode is
 * still bound on non-plan runs.
 */
export function signRunPermissionPosture(
  secret: Buffer | string,
  approvalMode: string | null | undefined,
  effectivePermissions: EffectiveRunPermissions | null | undefined,
  context?: RunPermissionPostureContext | null
): string {
  return createHmac('sha256', secret)
    .update(canonicalRunPermissionPosture(approvalMode, effectivePermissions, context))
    .digest('hex')
}

/** Constant-time verification of a posture signature. */
export function verifyRunPermissionPosture(
  secret: Buffer | string,
  approvalMode: string | null | undefined,
  effectivePermissions: EffectiveRunPermissions | null | undefined,
  signature: string | null | undefined,
  context?: RunPermissionPostureContext | null
): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]+$/i.test(signature)) return false
  try {
    const expected = Buffer.from(
      signRunPermissionPosture(secret, approvalMode, effectivePermissions, context),
      'hex'
    )
    const actual = Buffer.from(signature, 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export type RunPostureScope = 'global' | 'workspace'

export interface RunPermissionPostureContext {
  provider?: string | null
  scope?: string | null
  appRunId?: string | null
  appChatId?: string | null
  prompt?: string | null
  workflowMode?: string | null
  runtimeProfileId?: string | null
}

export interface UntrustedRunPosture {
  scope: RunPostureScope
  approvalMode: string | null | undefined
  effectivePermissions: EffectiveRunPermissions | null | undefined
  signature: string | null | undefined
  context?: RunPermissionPostureContext | null
}

export interface ClampRunPostureDeps {
  /** Verify the posture against the main-issued HMAC secret. */
  verify: (
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    signature: string | null | undefined,
    context?: RunPermissionPostureContext | null
  ) => boolean
  /**
   * Re-derive the canonical read-only posture from trusted main-side
   * settings — `resolveEffectiveRunPermissions({ presetId: 'read_only' })`
   * for this run's provider + workspace. Used as the maximal safe
   * downgrade target.
   */
  reDeriveReadOnly: () => EffectiveRunPermissions
  /**
   * Re-derive a non-elevated default posture from current trusted settings.
   * Used when a signed global run carried a workspace/full-access preset: the
   * global boundary may keep prompt-on-action mode, but it must not preserve
   * per-run full-access service overrides.
   */
  reDeriveDefault: () => EffectiveRunPermissions
}

export type RunPostureDowngradeReason =
  | 'invalid-posture-signature'
  | 'invalid-effective-permissions-shape'
  | 'unsigned-effective-permissions'
  | 'unsigned-raised-approval-mode'
  | 'missing-readonly-effective-permissions'
  | 'global-effective-permissions-capped'

export interface ClampedRunPosture {
  approvalMode: string | undefined
  effectivePermissions: EffectiveRunPermissions | undefined
  /** Echoed back only when the posture was trusted; cleared otherwise. */
  signature: string | undefined
  downgraded: boolean
  reason?: RunPostureDowngradeReason
}

function normalizeRunPermissionPostureContext(
  context?: RunPermissionPostureContext | null
): RunPermissionPostureContext | null {
  if (!context) return null
  return {
    provider: normalizeContextString(context.provider),
    scope: normalizeContextString(context.scope),
    appRunId: normalizeContextString(context.appRunId),
    appChatId: normalizeContextString(context.appChatId),
    prompt: normalizeContextString(context.prompt),
    workflowMode: normalizeContextString(context.workflowMode),
    runtimeProfileId: normalizeContextString(context.runtimeProfileId)
  }
}

function normalizeContextString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Coerce a scope-aware approval mode WITHOUT consulting provenance.
 * Global runs can never exceed `'default'` (the long-standing hard rule
 * in `normalizeAgentRunPayload`); workspace runs are coerced to a
 * recognized value.
 */
function coerceScopedApprovalMode(
  scope: RunPostureScope,
  approvalMode: string | null | undefined
): string | undefined {
  if (scope === 'global') return approvalMode === 'plan' ? 'plan' : 'default'
  return coerceApprovalMode(approvalMode)
}

/**
 * Downgrade-only clamp. Trusted (validly-signed) postures pass through
 * byte-for-byte (global scope still capped to ≤ default); everything
 * else is coerced. Unverifiable `effectivePermissions` fail safe to a
 * read-only run. Unsigned payloads without a permission object may still
 * use legacy/default dispatch paths, but they cannot raise themselves to
 * `auto_edit` without a main-issued signature.
 */
export function clampUntrustedRunPosture(
  input: UntrustedRunPosture,
  deps: ClampRunPostureDeps
): ClampedRunPosture {
  const hasSignature = typeof input.signature === 'string' && input.signature.length > 0

  if (hasSignature) {
    if (deps.verify(input.approvalMode, input.effectivePermissions, input.signature, input.context)) {
      // Trusted main-issued posture. Pass through unchanged, except the
      // global-scope cap (identity for a legitimate global posture).
      const approvalMode = coerceScopedApprovalMode(input.scope, input.approvalMode)
      if (input.effectivePermissions && !isEffectiveRunPermissions(input.effectivePermissions)) {
        return forceReadOnly(input.scope, deps, 'invalid-effective-permissions-shape')
      }
      if (approvalMode === 'plan' && input.effectivePermissions?.readOnly !== true) {
        return forceReadOnly(input.scope, deps, 'missing-readonly-effective-permissions')
      }
      if (input.scope === 'global' && input.effectivePermissions?.readOnly === false) {
        return forceDefault(deps, 'global-effective-permissions-capped')
      }
      return {
        approvalMode,
        effectivePermissions: input.effectivePermissions ?? undefined,
        signature: input.signature ?? undefined,
        downgraded: false
      }
    }
    // Signature present but does not verify ⇒ the posture was mutated
    // after signing (tampering, or a paused-provider reroute that forced
    // plan). Fail safe to a read-only run — keeping a raised approvalMode
    // while dropping the object would itself be an escalation.
    return forceReadOnly(input.scope, deps, 'invalid-posture-signature')
  }

  if (input.effectivePermissions) {
    // An `effectivePermissions` object with NO signature. After this
    // hardening every legitimate producer signs, so an unsigned object is
    // never legitimate (a renderer-inflated / imported-untrusted blob).
    return forceReadOnly(input.scope, deps, 'unsigned-effective-permissions')
  }

  // No signature and no effectivePermissions: a legitimate unsigned path
  // (legacy run-gemini or other compatibility dispatch). Coerce the
  // mode, but cap unsigned workspace requests at prompt-on-action. The normal
  // renderer compose-run path signs non-plan postures, so a bare `auto_edit`
  // here is either legacy/untrusted input or a caller that has not gone through
  // a main-side composer.
  const approvalMode = coerceScopedApprovalMode(input.scope, input.approvalMode)
  if (approvalMode === 'plan') {
    return forceReadOnly(input.scope, deps, 'missing-readonly-effective-permissions')
  }
  if (
    input.scope === 'workspace' &&
    approvalModeRank(approvalMode) > approvalModeRank('default')
  ) {
    return {
      approvalMode: 'default',
      effectivePermissions: undefined,
      signature: undefined,
      downgraded: true,
      reason: 'unsigned-raised-approval-mode'
    }
  }

  return {
    approvalMode,
    effectivePermissions: undefined,
    signature: undefined,
    downgraded: false
  }
}

function isEffectiveRunPermissions(value: unknown): value is EffectiveRunPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<EffectiveRunPermissions>
  if (typeof record.presetId !== 'string') return false
  if (typeof record.approvalMode !== 'string') return false
  if (!isAgenticServicesRecord(record.agenticServices)) return false
  if (record.networkAccess !== 'allow' && record.networkAccess !== 'deny') return false
  if (!Array.isArray(record.externalPathGrants)) return false
  if (!Array.isArray(record.workspaceGrantServiceIds)) return false
  if (typeof record.readOnly !== 'boolean') return false
  return true
}

function isAgenticServicesRecord(value: unknown): value is EffectiveRunPermissions['agenticServices'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    isAgenticServicePolicy(record.shellCommands) &&
    isAgenticServicePolicy(record.fileChanges) &&
    isAgenticServicePolicy(record.mcpTools) &&
    isAgenticServicePolicy(record.subThreadDelegation)
  )
}

function isAgenticServicePolicy(value: unknown): boolean {
  return value === 'ask' || value === 'workspace' || value === 'allow' || value === 'deny'
}

function forceReadOnly(
  _scope: RunPostureScope,
  deps: ClampRunPostureDeps,
  reason: RunPostureDowngradeReason
): ClampedRunPosture {
  return {
    approvalMode: 'plan',
    effectivePermissions: deps.reDeriveReadOnly(),
    signature: undefined,
    downgraded: true,
    reason
  }
}

function forceDefault(
  deps: ClampRunPostureDeps,
  reason: RunPostureDowngradeReason
): ClampedRunPosture {
  return {
    approvalMode: 'default',
    effectivePermissions: deps.reDeriveDefault(),
    signature: undefined,
    downgraded: true,
    reason
  }
}
