/**
 * Pure App Drive permission / identity / audit / secret / takeover disclosure.
 *
 * This module describes the authority boundary that already exists for native
 * Tier 4 (exact chat/run/launch/process-birth) and the non-authority-expanding
 * session chrome semantics (pause / takeover / stop) for the vertical slice.
 *
 * It deliberately:
 * - does not mint, broaden, or persist control authority
 * - does not treat bundle ID / title / application name as authority
 * - does not invent durable app-keyed approvals
 * - does not mutate NativeWindowLeaseRegistry or the Approval Ledger
 * - does not call native actuation bridges
 * - is a disclosure / admission helper — not a mutable session store
 *   (AppDriveSession owns process-local lifecycle mutation)
 *
 * Session/Coordinator wiring and dock UI belong to peer lanes.
 */

export const APP_DRIVE_AUTHORITY_MODEL_ID = 'appdrive-authority-disclosure-v1' as const

/** Drive mode honesty label for shipped native control chrome. */
export const APP_DRIVE_SHIPPED_DRIVE_MODE = 'foreground' as const

export type AppDriveShippedDriveMode = typeof APP_DRIVE_SHIPPED_DRIVE_MODE

/**
 * Canonical session lifecycle literals shared with AppDriveSession.
 * Display labels such as "Viewing" / "Driving" are derived elsewhere from
 * observation vs control presence — they are not lifecycle states.
 */
export const APP_DRIVE_SESSION_LIFECYCLE_STATES = [
  'idle',
  'active',
  'paused',
  'takeover',
  'stopped'
] as const

export type AppDriveSessionLifecycleState = (typeof APP_DRIVE_SESSION_LIFECYCLE_STATES)[number]

/**
 * Fields that constitute native control authority today.
 * Bundle ID, title, and application name are intentionally absent.
 */
export interface AppDriveAuthorityBinding {
  readonly chatId: string
  readonly runId: string
  readonly launchAttemptId: string
  /** LaunchAttempt PID recorded at grant time. */
  readonly expectedPid: number
  /** Exact selected window process PID. */
  readonly selectedPid: number
  /**
   * Canonical kernel/process-birth receipt
   * (`procBSDInfo:<micros>` / `nsRunningApplication:<micros>`).
   */
  readonly processStartedAt: string
  readonly windowId: number
}

/**
 * Display / sticky metadata only. Never authorize from these fields.
 */
export interface AppDriveDisplayIdentity {
  readonly bundleId?: string | null
  readonly applicationName?: string | null
  readonly windowTitle?: string | null
}

export type AppDriveConsentLayer =
  | 'screen_watch_observation'
  | 'view_and_control'
  | 'accessibility_os_trust'
  | 'per_click_confirmation'

export type AppDriveConsentApprover = 'user'

/**
 * Consent is always human-minted. Agent / Boss / Captain cannot approve.
 * Persistence is process-local lease only — never durable app trust.
 */
export interface AppDriveConsentDisclosure {
  readonly layer: AppDriveConsentLayer
  readonly approvedBy: AppDriveConsentApprover
  readonly persistence: 'attachment' | 'process_local_lease' | 'os_settings' | 'one_shot'
  readonly mintsControlAuthority: boolean
  readonly durableAppKeyedApproval: false
}

export const APP_DRIVE_CONSENT_LAYERS: readonly AppDriveConsentDisclosure[] = [
  {
    layer: 'screen_watch_observation',
    approvedBy: 'user',
    persistence: 'attachment',
    mintsControlAuthority: false,
    durableAppKeyedApproval: false
  },
  {
    layer: 'view_and_control',
    approvedBy: 'user',
    persistence: 'process_local_lease',
    mintsControlAuthority: true,
    durableAppKeyedApproval: false
  },
  {
    layer: 'accessibility_os_trust',
    approvedBy: 'user',
    persistence: 'os_settings',
    mintsControlAuthority: false,
    durableAppKeyedApproval: false
  },
  {
    layer: 'per_click_confirmation',
    approvedBy: 'user',
    persistence: 'one_shot',
    mintsControlAuthority: false,
    durableAppKeyedApproval: false
  }
] as const

export type AppDriveAllowedVerb = 'observe' | 'inspect' | 'click' | 'fill'

export const APP_DRIVE_ALLOWED_VERBS: readonly AppDriveAllowedVerb[] = [
  'observe',
  'inspect',
  'click',
  'fill'
] as const

export type AppDriveControlVerb = Extract<AppDriveAllowedVerb, 'click' | 'fill'>

export const APP_DRIVE_CONTROL_VERBS: readonly AppDriveControlVerb[] = ['click', 'fill'] as const

export type AppDriveSessionControlAction = 'pause' | 'resume' | 'takeover' | 'stop'

export type AppDriveHumanArbitrationSensor =
  | 'host_global_hid'
  | 'target_scoped'
  | 'explicit_session_control'

/**
 * Native physical-input idle is host-global today. Product chrome may offer
 * explicit Pause/Takeover/Stop, but must not claim automatic target-scoped pause.
 */
export interface AppDriveHumanArbitrationDisclosure {
  readonly nativeSensor: 'host_global_hid'
  readonly targetScopedAutomaticPauseClaimed: false
  readonly explicitSessionControlsSupported: true
  readonly webCanvasTargetScoped: true
}

export const APP_DRIVE_HUMAN_ARBITRATION: AppDriveHumanArbitrationDisclosure = {
  nativeSensor: 'host_global_hid',
  targetScopedAutomaticPauseClaimed: false,
  explicitSessionControlsSupported: true,
  webCanvasTargetScoped: true
}

/**
 * Inherited secret-field policy from native Tier 4.
 * Disclosure / admission evidence only — does not reenforce or replace the
 * Swift/coordinator secret-field refuse path.
 */
export interface AppDriveSecretPolicyDisclosure {
  readonly evidenceKind: 'inherited_tier4_policy'
  readonly reenforcesNativeEnforcement: false
  readonly secureFieldsRefused: true
  readonly fillSecureFieldsForbidden: true
  readonly captureRefusedWhenSecurePresentOrUnknown: true
  readonly valuesNeverReturned: true
  readonly noRetryOrWorkaround: true
  readonly refusalReason: 'secret_field'
}

export const APP_DRIVE_SECRET_POLICY: AppDriveSecretPolicyDisclosure = {
  evidenceKind: 'inherited_tier4_policy',
  reenforcesNativeEnforcement: false,
  secureFieldsRefused: true,
  fillSecureFieldsForbidden: true,
  captureRefusedWhenSecurePresentOrUnknown: true,
  valuesNeverReturned: true,
  noRetryOrWorkaround: true,
  refusalReason: 'secret_field'
}

/**
 * Inherited click-audit policy: durable intent is opaque hashes only.
 * Disclosure evidence only — does not reenforce NativeWindowClickAudit.
 * No AX text, raw ref, PID, handle, birth receipt, or consent epoch in the event.
 */
export interface AppDriveAuditPolicyDisclosure {
  readonly evidenceKind: 'inherited_tier4_policy'
  readonly reenforcesNativeEnforcement: false
  readonly perClickDurableClaimRequired: true
  readonly durablePayloadAllowsSecrets: false
  readonly durablePayloadAllowsAxText: false
  readonly durablePayloadAllowsRawRef: false
  readonly durablePayloadAllowsPidOrHandle: false
  readonly approvalLedgerJoinedForNativeLease: false
}

export const APP_DRIVE_AUDIT_POLICY: AppDriveAuditPolicyDisclosure = {
  evidenceKind: 'inherited_tier4_policy',
  reenforcesNativeEnforcement: false,
  perClickDurableClaimRequired: true,
  durablePayloadAllowsSecrets: false,
  durablePayloadAllowsAxText: false,
  durablePayloadAllowsRawRef: false,
  durablePayloadAllowsPidOrHandle: false,
  // Tier 4 View & Control is dialog → process-local lease; ledger join is not shipped.
  approvalLedgerJoinedForNativeLease: false
}

export type AppDrivePermissionDisclosureLabel =
  | 'No attachment'
  | 'View only'
  | 'View & Control (current launch only)'

export type AppDriveAuthorityAdmissionCode =
  | 'admitted'
  | 'missing_authority_binding'
  | 'display_identity_is_not_authority'
  | 'persistent_app_approval_forbidden'
  | 'non_user_consent_forbidden'
  | 'session_idle'
  | 'session_paused'
  | 'session_takeover'
  | 'session_stopped'
  | 'verb_not_allowed'
  | 'control_requires_view_and_control'
  | 'secret_field_refused'

export interface AppDriveAuthorityAdmissionOk {
  readonly ok: true
  readonly code: 'admitted'
  readonly driveMode: AppDriveShippedDriveMode
  readonly lifecycle: AppDriveSessionLifecycleState
}

export interface AppDriveAuthorityAdmissionDenied {
  readonly ok: false
  readonly code: Exclude<AppDriveAuthorityAdmissionCode, 'admitted'>
  readonly message: string
}

export type AppDriveAuthorityAdmissionResult =
  | AppDriveAuthorityAdmissionOk
  | AppDriveAuthorityAdmissionDenied

export interface AppDriveAuthorityAdmissionInput {
  readonly binding: AppDriveAuthorityBinding | null | undefined
  readonly displayIdentity?: AppDriveDisplayIdentity | null
  /** True only when a current user-approved View & Control lease exists. */
  readonly hasUserViewAndControlLease: boolean
  /** Consent mint source for the current control lease, when present. */
  readonly leaseApprovedBy?: AppDriveConsentApprover | 'agent' | 'boss' | 'captain' | null
  readonly lifecycle: AppDriveSessionLifecycleState
  readonly verb: AppDriveAllowedVerb | string
  /** When true, the target is a secure/password-like field. */
  readonly targetIsSecureField?: boolean
  /**
   * Caller attempted to treat display identity (bundle/title/name) as the
   * authorization key. Always denied.
   */
  readonly authorizeFromDisplayIdentity?: boolean
  /**
   * Caller requested a durable app-keyed standing approval. Forbidden this slice.
   */
  readonly requestPersistentAppApproval?: boolean
}

const CANONICAL_PROCESS_STARTED_AT_PATTERN =
  /^(?:procBSDInfo|nsRunningApplication):[1-9][0-9]{0,18}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isAppDriveSessionLifecycleState(
  value: unknown
): value is AppDriveSessionLifecycleState {
  return (
    typeof value === 'string' &&
    (APP_DRIVE_SESSION_LIFECYCLE_STATES as readonly string[]).includes(value)
  )
}

/**
 * Structural validation of an authority binding. Display fields are ignored.
 */
export function isValidAppDriveAuthorityBinding(
  binding: AppDriveAuthorityBinding | null | undefined
): binding is AppDriveAuthorityBinding {
  if (!binding || typeof binding !== 'object') return false
  return (
    isNonEmptyString(binding.chatId) &&
    isNonEmptyString(binding.runId) &&
    isNonEmptyString(binding.launchAttemptId) &&
    isPositiveSafeInteger(binding.expectedPid) &&
    isPositiveSafeInteger(binding.selectedPid) &&
    binding.expectedPid === binding.selectedPid &&
    isNonEmptyString(binding.processStartedAt) &&
    CANONICAL_PROCESS_STARTED_AT_PATTERN.test(binding.processStartedAt) &&
    isPositiveSafeInteger(binding.windowId)
  )
}

/**
 * Bundle ID / title / application name may be shown, never used as authority.
 */
export function assertDisplayIdentityIsNotAuthority(
  display: AppDriveDisplayIdentity | null | undefined
): { ok: true } | { ok: false; code: 'display_identity_is_not_authority'; message: string } {
  // Presence of display fields is fine; attempting to authorize from them is not.
  // This helper documents the invariant for callers that only hold display data.
  if (!display) return { ok: true }
  return { ok: true }
}

export function refuseAuthorizeFromDisplayIdentity(): AppDriveAuthorityAdmissionDenied {
  return {
    ok: false,
    code: 'display_identity_is_not_authority',
    message:
      'Bundle ID, application name, and window title are display metadata only; exact chat/run/launch/process-birth binding is the authority.'
  }
}

export function refusePersistentAppApproval(): AppDriveAuthorityAdmissionDenied {
  return {
    ok: false,
    code: 'persistent_app_approval_forbidden',
    message:
      'Durable app-keyed App Drive approvals are not shipped; control authority is a process-local user lease for one exact launch.'
  }
}

/**
 * Honest permission disclosure for dock / status chrome.
 * "Current launch only" means process-local lease — never durable app trust.
 */
export function describeAppDrivePermissionLabel(args: {
  readonly hasObservationAttachment: boolean
  readonly hasUserViewAndControlLease: boolean
}): AppDrivePermissionDisclosureLabel {
  if (args.hasUserViewAndControlLease) return 'View & Control (current launch only)'
  if (args.hasObservationAttachment) return 'View only'
  return 'No attachment'
}

/**
 * Pure transition table for explicit session chrome.
 * This is not a mutable session store — AppDriveSession owns mutation.
 * Idle has no controls until a peer binds an already-granted lease projection.
 */
export function applyAppDriveSessionControl(args: {
  readonly current: AppDriveSessionLifecycleState
  readonly action: AppDriveSessionControlAction
}):
  | { ok: true; next: AppDriveSessionLifecycleState }
  | { ok: false; code: 'invalid_session_transition'; message: string } {
  const { current, action } = args
  if (current === 'idle') {
    return {
      ok: false,
      code: 'invalid_session_transition',
      message:
        'No App Drive session is bound; Pause/Takeover/Stop require an active current-launch binding.'
    }
  }
  if (current === 'stopped') {
    return {
      ok: false,
      code: 'invalid_session_transition',
      message: 'A stopped App Drive session cannot accept further session controls.'
    }
  }
  switch (action) {
    case 'pause':
      if (current === 'paused') return { ok: true, next: 'paused' }
      if (current === 'takeover') {
        return {
          ok: false,
          code: 'invalid_session_transition',
          message: 'Leave takeover with Resume or Stop, not Pause.'
        }
      }
      return { ok: true, next: 'paused' }
    case 'takeover':
      return { ok: true, next: 'takeover' }
    case 'resume':
      if (current === 'paused' || current === 'takeover') return { ok: true, next: 'active' }
      if (current === 'active') return { ok: true, next: 'active' }
      return {
        ok: false,
        code: 'invalid_session_transition',
        message: 'Resume is only valid from paused or takeover.'
      }
    case 'stop':
      return { ok: true, next: 'stopped' }
    default:
      return {
        ok: false,
        code: 'invalid_session_transition',
        message: `Unknown App Drive session control: ${String(action)}`
      }
  }
}

function isAllowedVerb(verb: string): verb is AppDriveAllowedVerb {
  return (APP_DRIVE_ALLOWED_VERBS as readonly string[]).includes(verb)
}

function isControlVerb(verb: AppDriveAllowedVerb): verb is AppDriveControlVerb {
  return (APP_DRIVE_CONTROL_VERBS as readonly string[]).includes(verb)
}

/**
 * Pure admission helper for disclosure / session chrome.
 * Does not replace NativeWindowLeaseRegistry validation; peers must still
 * revalidate the exact lease before any native call. Secret/audit constants
 * here are inherited evidence labels — the native refuse paths remain authoritative.
 */
export function evaluateAppDriveAuthorityAdmission(
  input: AppDriveAuthorityAdmissionInput
): AppDriveAuthorityAdmissionResult {
  if (input.requestPersistentAppApproval) {
    return refusePersistentAppApproval()
  }
  if (input.authorizeFromDisplayIdentity) {
    return refuseAuthorizeFromDisplayIdentity()
  }
  if (!isAppDriveSessionLifecycleState(input.lifecycle)) {
    return {
      ok: false,
      code: 'session_idle',
      message:
        'App Drive lifecycle is unknown; treat as idle and refuse until a known state is bound.'
    }
  }
  if (input.lifecycle === 'idle') {
    return {
      ok: false,
      code: 'session_idle',
      message:
        'No Foreground Drive session is bound; attach and approve View & Control for the current launch before acting.'
    }
  }
  if (!isValidAppDriveAuthorityBinding(input.binding)) {
    return {
      ok: false,
      code: 'missing_authority_binding',
      message:
        'App Drive control requires an exact chat/run/launchAttempt/PID/process-birth/window binding.'
    }
  }
  if (input.leaseApprovedBy != null && input.leaseApprovedBy !== 'user') {
    return {
      ok: false,
      code: 'non_user_consent_forbidden',
      message:
        'Native App Drive control consent is user-only; agents and ensemble leads cannot mint it.'
    }
  }
  if (!isAllowedVerb(input.verb)) {
    return {
      ok: false,
      code: 'verb_not_allowed',
      message: `Verb "${input.verb}" is outside the shipped native App Drive verb set.`
    }
  }
  const verb = input.verb
  if (input.lifecycle === 'stopped') {
    return {
      ok: false,
      code: 'session_stopped',
      message: 'App Drive session is stopped; attach and approve View & Control again to continue.'
    }
  }
  if (input.lifecycle === 'paused' && isControlVerb(verb)) {
    return {
      ok: false,
      code: 'session_paused',
      message:
        'App Drive is paused; Resume before click/fill. Observation may still be allowed by the lease.'
    }
  }
  if (input.lifecycle === 'takeover' && isControlVerb(verb)) {
    return {
      ok: false,
      code: 'session_takeover',
      message:
        'Human takeover is active; agent click/fill is refused until Resume. This is explicit UI state, not target-scoped HID.'
    }
  }
  if (isControlVerb(verb) && !input.hasUserViewAndControlLease) {
    return {
      ok: false,
      code: 'control_requires_view_and_control',
      message:
        'click/fill require a current user-approved View & Control lease for this exact launch.'
    }
  }
  if (input.targetIsSecureField === true && isControlVerb(verb)) {
    return {
      ok: false,
      code: 'secret_field_refused',
      message:
        'Secure fields are human-only (inherited Tier 4 evidence). Do not retry or work around this refusal; native enforcement remains authoritative.'
    }
  }

  // Observe/inspect remain admissible under pause/takeover for status UI; the
  // live lease registry remains the final executor gate.
  return {
    ok: true,
    code: 'admitted',
    driveMode: APP_DRIVE_SHIPPED_DRIVE_MODE,
    lifecycle: input.lifecycle
  }
}

/** Safe renderer/dock disclosure — never includes handles, epochs, or PIDs as secrets. */
export interface AppDriveAuthorityRendererDisclosure {
  readonly modelId: typeof APP_DRIVE_AUTHORITY_MODEL_ID
  readonly driveMode: AppDriveShippedDriveMode
  readonly driveModeLabel: 'Foreground Drive'
  readonly permissionLabel: AppDrivePermissionDisclosureLabel
  readonly authorityKind: 'exact_chat_run_launch_process_birth'
  readonly bundleIdIsAuthority: false
  readonly persistentAppApproval: false
  readonly currentLaunchOnly: true
  readonly approvedBy: AppDriveConsentApprover
  readonly lifecycle: AppDriveSessionLifecycleState
  readonly allowedVerbs: readonly AppDriveAllowedVerb[]
  readonly humanArbitration: AppDriveHumanArbitrationDisclosure
  readonly secretPolicy: AppDriveSecretPolicyDisclosure
  readonly auditPolicy: AppDriveAuditPolicyDisclosure
  readonly displayIdentity: {
    readonly bundleId: string | null
    readonly applicationName: string | null
    readonly windowTitle: string | null
  }
  readonly bindingPresent: boolean
  readonly chatId: string | null
  readonly runId: string | null
  readonly launchAttemptId: string | null
}

export function projectAppDriveAuthorityDisclosure(args: {
  readonly binding: AppDriveAuthorityBinding | null | undefined
  readonly displayIdentity?: AppDriveDisplayIdentity | null
  readonly lifecycle: AppDriveSessionLifecycleState
  readonly hasUserViewAndControlLease: boolean
  /** Observation attachment without control (Screen Watch / view-only). */
  readonly hasObservationAttachment?: boolean
}): AppDriveAuthorityRendererDisclosure {
  const display = args.displayIdentity ?? null
  const bindingOk = isValidAppDriveAuthorityBinding(args.binding)
  const hasObservationAttachment =
    args.hasObservationAttachment === true ||
    args.hasUserViewAndControlLease ||
    bindingOk ||
    Boolean(display?.bundleId || display?.applicationName || display?.windowTitle)
  return {
    modelId: APP_DRIVE_AUTHORITY_MODEL_ID,
    driveMode: APP_DRIVE_SHIPPED_DRIVE_MODE,
    driveModeLabel: 'Foreground Drive',
    permissionLabel: describeAppDrivePermissionLabel({
      hasObservationAttachment,
      hasUserViewAndControlLease: args.hasUserViewAndControlLease
    }),
    authorityKind: 'exact_chat_run_launch_process_birth',
    bundleIdIsAuthority: false,
    persistentAppApproval: false,
    currentLaunchOnly: true,
    approvedBy: 'user',
    lifecycle: args.lifecycle,
    allowedVerbs: APP_DRIVE_ALLOWED_VERBS,
    humanArbitration: APP_DRIVE_HUMAN_ARBITRATION,
    secretPolicy: APP_DRIVE_SECRET_POLICY,
    auditPolicy: APP_DRIVE_AUDIT_POLICY,
    displayIdentity: {
      bundleId: display?.bundleId ?? null,
      applicationName: display?.applicationName ?? null,
      windowTitle: display?.windowTitle ?? null
    },
    bindingPresent: bindingOk,
    chatId: bindingOk ? args.binding!.chatId : null,
    runId: bindingOk ? args.binding!.runId : null,
    launchAttemptId: bindingOk ? args.binding!.launchAttemptId : null
  }
}
