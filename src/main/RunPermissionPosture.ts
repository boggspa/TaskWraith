import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  parseResolvedProjectReferenceContext,
  serializeResolvedProjectReferenceContext
} from '../shared/projectReferenceContext'
import type {
  AgenticServiceId,
  EffectiveRunPermissions,
  RunPermissionPostureSnapshot
} from './store/types'
import { isRecord, optionalString } from './settings/MainSanitizers'

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

/**
 * Execution-graph templates are durable permission ceilings, not runnable
 * capabilities. Their tagged signatures are verified only by the graph
 * authority helper and are deliberately rejected by the generic dispatch
 * verifier below.
 *
 * A claimed graph attempt receives a different tag. The generic dispatch
 * verifier accepts that tag only after binding the HMAC to the exact attempt
 * context, including its canonical workspace path and appRunId.
 */
export const EXECUTION_GRAPH_TEMPLATE_POSTURE_SIGNATURE_PREFIX = 'tw-eg-template-v1:'
export const EXECUTION_GRAPH_ATTEMPT_POSTURE_SIGNATURE_PREFIX = 'tw-eg-attempt-v1:'
export const EXECUTION_GRAPH_TEMPLATE_POSTURE_DOMAIN =
  'taskwraith.execution-graph.template-permission.v1'
export const EXECUTION_GRAPH_ATTEMPT_POSTURE_DOMAIN =
  'taskwraith.execution-graph.attempt-permission.v1'

function taggedSignatureHex(signature: string, prefix: string): string | undefined {
  if (!signature.startsWith(prefix)) return undefined
  const value = signature.slice(prefix.length)
  return /^[0-9a-f]{64}$/i.test(value) ? value : undefined
}

export function isExecutionGraphAttemptPermissionPostureSignature(
  signature: string | null | undefined
): boolean {
  return (
    typeof signature === 'string' &&
    taggedSignatureHex(signature, EXECUTION_GRAPH_ATTEMPT_POSTURE_SIGNATURE_PREFIX) !== undefined
  )
}

/** Constant-time verification of a posture signature. */
export function verifyRunPermissionPosture(
  secret: Buffer | string,
  approvalMode: string | null | undefined,
  effectivePermissions: EffectiveRunPermissions | null | undefined,
  signature: string | null | undefined,
  context?: RunPermissionPostureContext | null
): boolean {
  if (typeof signature !== 'string') return false

  // A template proof must never double as a dispatch bearer token, even if an
  // untrusted caller can reproduce every public field from its snapshot.
  if (signature.startsWith(EXECUTION_GRAPH_TEMPLATE_POSTURE_SIGNATURE_PREFIX)) return false

  const graphAttemptHex = taggedSignatureHex(
    signature,
    EXECUTION_GRAPH_ATTEMPT_POSTURE_SIGNATURE_PREFIX
  )
  const signatureHex = graphAttemptHex ?? signature
  if (!/^[0-9a-f]+$/i.test(signatureHex)) return false

  let verificationContext = context
  if (graphAttemptHex) {
    const normalized = normalizeRunPermissionPostureContext(context)
    // These fields are the minimum exact-attempt identity. In particular, an
    // absent appRunId must not recreate the reusable-template vulnerability.
    if (
      !normalized?.provider ||
      normalized.scope !== 'workspace' ||
      !normalized.workspacePath ||
      !normalized.appRunId ||
      !normalized.appChatId ||
      !normalized.prompt ||
      !normalized.workflowMode
    ) {
      return false
    }
    verificationContext = {
      ...normalized,
      authorityDomain: EXECUTION_GRAPH_ATTEMPT_POSTURE_DOMAIN
    }
  }
  try {
    const expected = Buffer.from(
      signRunPermissionPosture(secret, approvalMode, effectivePermissions, verificationContext),
      'hex'
    )
    const actual = Buffer.from(signatureHex, 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export type RunPostureScope = 'global' | 'workspace'

export interface RunPermissionPostureContext {
  provider?: string | null
  scope?: string | null
  /** Canonical path; populated only for domain-separated graph attempts. */
  workspacePath?: string | null
  appRunId?: string | null
  appChatId?: string | null
  prompt?: string | null
  resumeFallbackPrompt?: string | null
  workflowMode?: string | null
  runtimeProfileId?: string | null
  ensembleParticipantId?: string | null
  ensembleLaneId?: string | null
  projectReferenceContextHash?: string | null
  /** Main-owned HMAC domain; never copied from a raw renderer payload. */
  authorityDomain?: string | null
}

/**
 * Build a `RunPermissionPostureContext` from a raw run payload. Pure (no
 * Electron / AppStore coupling), so it lives next to the context type it
 * constructs and the clamp / sign / verify consumers of that type — relocated
 * here from index.ts in M3-1b. Every main-side producer that binds a posture
 * signature to stable run context calls this.
 */
export function runPostureContextFromPayload(payload: {
  provider?: unknown
  scope?: unknown
  appRunId?: unknown
  appChatId?: unknown
  prompt?: unknown
  resumeFallbackPrompt?: unknown
  workflowMode?: unknown
  runtimeProfileId?: unknown
  workspacePath?: unknown
  ensembleRun?: unknown
  projectReferenceContext?: unknown
}): RunPermissionPostureContext {
  const ensembleRun = isRecord(payload.ensembleRun) ? payload.ensembleRun : null
  const resumeFallbackPrompt =
    typeof payload.resumeFallbackPrompt === 'string' ? payload.resumeFallbackPrompt : ''
  return {
    provider: optionalString(payload.provider),
    scope: optionalString(payload.scope),
    workspacePath: optionalString(payload.workspacePath),
    appRunId: optionalString(payload.appRunId),
    appChatId: optionalString(payload.appChatId),
    prompt: typeof payload.prompt === 'string' ? payload.prompt : String(payload.prompt ?? ''),
    ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
    workflowMode: payload.workflowMode === 'plan' ? 'plan' : 'normal',
    runtimeProfileId: optionalString(payload.runtimeProfileId),
    ensembleParticipantId: ensembleRun ? optionalString(ensembleRun.participantId) : null,
    ensembleLaneId: ensembleRun ? optionalString(ensembleRun.laneId) : null,
    projectReferenceContextHash: hashProjectReferenceContext(payload.projectReferenceContext)
  }
}

export function hashProjectReferenceContext(value: unknown): string | null {
  const context = parseResolvedProjectReferenceContext(value)
  return context ? sha256Hex(serializeResolvedProjectReferenceContext(context)) : null
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

export interface RunPermissionPostureSnapshotInput {
  approvalMode?: string | null
  workflowMode?: string | null
  effectivePermissions?: EffectiveRunPermissions | null
  signature?: string | null
  context?: RunPermissionPostureContext | null
}

export function buildRunPermissionPostureSnapshot(
  input: RunPermissionPostureSnapshotInput
): RunPermissionPostureSnapshot {
  const normalizedContext = normalizeRunPermissionPostureContext(input.context)
  const canonical = canonicalRunPermissionPosture(
    input.approvalMode,
    input.effectivePermissions,
    normalizedContext
  )
  const signature = normalizeContextString(input.signature)
  const grants = input.effectivePermissions?.externalPathGrants ?? []
  const externalPathGrantHash = grants.length ? sha256Hex(stableStringify(grants)) : undefined
  const context = snapshotContext(normalizedContext)

  return {
    schemaVersion: 1,
    ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
    ...(input.workflowMode === 'plan' || input.workflowMode === 'normal'
      ? { workflowMode: input.workflowMode }
      : {}),
    ...(input.effectivePermissions
      ? {
          presetId: input.effectivePermissions.presetId,
          readOnly: input.effectivePermissions.readOnly,
          agenticServices: input.effectivePermissions.agenticServices,
          networkAccess: input.effectivePermissions.networkAccess,
          workspaceGrantServiceIds: [...input.effectivePermissions.workspaceGrantServiceIds]
        }
      : {}),
    externalPathGrantCount: grants.length,
    ...(externalPathGrantHash ? { externalPathGrantHash } : {}),
    postureHash: sha256Hex(canonical),
    ...(signature ? { signature } : {}),
    signaturePresent: Boolean(signature),
    ...(context ? { context } : {})
  }
}

function normalizeRunPermissionPostureContext(
  context?: RunPermissionPostureContext | null
): RunPermissionPostureContext | null {
  if (!context) return null
  const resumeFallbackPrompt = normalizeContextString(context.resumeFallbackPrompt)
  const workspacePath = normalizeContextString(context.workspacePath)
  const authorityDomain = normalizeContextString(context.authorityDomain)
  return {
    provider: normalizeContextString(context.provider),
    scope: normalizeContextString(context.scope),
    ...(workspacePath ? { workspacePath } : {}),
    appRunId: normalizeContextString(context.appRunId),
    appChatId: normalizeContextString(context.appChatId),
    prompt: normalizeContextString(context.prompt),
    ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
    workflowMode: normalizeContextString(context.workflowMode),
    runtimeProfileId: normalizeContextString(context.runtimeProfileId),
    ensembleParticipantId: normalizeContextString(context.ensembleParticipantId),
    ensembleLaneId: normalizeContextString(context.ensembleLaneId),
    projectReferenceContextHash: normalizeContextString(context.projectReferenceContextHash),
    ...(authorityDomain ? { authorityDomain } : {})
  }
}

function normalizeContextString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function snapshotContext(
  context: RunPermissionPostureContext | null
): RunPermissionPostureSnapshot['context'] | undefined {
  if (!context) return undefined
  const promptHash = context.prompt ? sha256Hex(context.prompt) : undefined
  const resumeFallbackPromptHash = context.resumeFallbackPrompt
    ? sha256Hex(context.resumeFallbackPrompt)
    : undefined
  const snapshot = {
    ...(context.provider ? { provider: context.provider } : {}),
    ...(context.scope ? { scope: context.scope } : {}),
    ...(context.appRunId ? { appRunId: context.appRunId } : {}),
    ...(context.appChatId ? { appChatId: context.appChatId } : {}),
    ...(context.workflowMode ? { workflowMode: context.workflowMode } : {}),
    ...(context.runtimeProfileId ? { runtimeProfileId: context.runtimeProfileId } : {}),
    ...(context.ensembleParticipantId
      ? { ensembleParticipantId: context.ensembleParticipantId }
      : {}),
    ...(context.ensembleLaneId ? { ensembleLaneId: context.ensembleLaneId } : {}),
    ...(context.projectReferenceContextHash
      ? { projectReferenceContextHash: context.projectReferenceContextHash }
      : {}),
    ...(promptHash ? { promptHash } : {}),
    ...(resumeFallbackPromptHash ? { resumeFallbackPromptHash } : {})
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
    if (
      deps.verify(input.approvalMode, input.effectivePermissions, input.signature, input.context)
    ) {
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
  if (input.scope === 'workspace' && approvalModeRank(approvalMode) > approvalModeRank('default')) {
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

function isAgenticServicesRecord(
  value: unknown
): value is EffectiveRunPermissions['agenticServices'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return EFFECTIVE_RUN_AGENTIC_SERVICE_IDS.every((service) =>
    isAgenticServicePolicy(record[service])
  )
}

// The Record assertion makes this list fail the Node typecheck whenever a new
// AgenticServiceId is added without extending signed-posture validation. A
// correctly HMAC-signed but structurally incomplete map must not pass merely
// because the older four core axes happen to be present.
const EFFECTIVE_RUN_AGENTIC_SERVICE_ID_RECORD = {
  shellCommands: true,
  fileChanges: true,
  externalPublish: true,
  mcpTools: true,
  subThreadDelegation: true,
  canvasInteraction: true,
  sketchCanvas: true,
  meshCanvas: true,
  simulatorCanvas: true,
  canvasEval: true,
  crossThreadRead: true,
  threadMessage: true,
  mediaEditing: true,
  mediaRecording: true,
  webBrowsing: true
} as const satisfies Record<AgenticServiceId, true>

const EFFECTIVE_RUN_AGENTIC_SERVICE_IDS = Object.keys(
  EFFECTIVE_RUN_AGENTIC_SERVICE_ID_RECORD
) as AgenticServiceId[]

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
