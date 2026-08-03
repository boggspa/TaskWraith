/**
 * Pure Computer Use / App Drive mode contract.
 *
 * Encodes the ensemble synthesis decision for App Drive modes without wiring
 * production IPC, leases, or native actuation. Product code may import these
 * labels; it must not invent silent mode fallbacks or claim Background /
 * Isolated support until the acceptance gates below pass.
 */

export const APP_DRIVE_COMPUTER_USE_CONTRACT_ID = 'appdrive-computer-use-v1' as const

export type AppDriveDriveMode = 'foreground' | 'background' | 'isolated'

export type AppDriveModeShipStatus =
  | 'ship_ui_on_existing_authority'
  | 'prototype_rfc_only'
  | 'rfc_only'

export interface AppDriveModeDefinition {
  readonly mode: AppDriveDriveMode
  readonly label: string
  readonly definition: string
  readonly shipStatus: AppDriveModeShipStatus
  readonly mayClaimNonDisruptiveControl: boolean
  readonly requiresInterferenceHarness: boolean
  readonly independentGuestHid: boolean
}

export const APP_DRIVE_MODE_DEFINITIONS: readonly AppDriveModeDefinition[] = [
  {
    mode: 'foreground',
    label: 'Foreground Drive',
    definition:
      'Current native Tier 4: AX-only observe/inspect/click/fill; selected app must be frontmost and its exact window focused and visible. Explicitly disruptive; fail closed; no silent raise/activate/CGEvent fallback.',
    shipStatus: 'ship_ui_on_existing_authority',
    mayClaimNonDisruptiveControl: false,
    requiresInterferenceHarness: false,
    independentGuestHid: false
  },
  {
    mode: 'background',
    label: 'Background Drive',
    definition:
      'Non-disruptive control with zero host cursor, focus, keyboard, clipboard, or activation theft. Not productized until a per-app automated interference harness proves non-theft.',
    shipStatus: 'prototype_rfc_only',
    mayClaimNonDisruptiveControl: false,
    requiresInterferenceHarness: true,
    independentGuestHid: false
  },
  {
    mode: 'isolated',
    label: 'Isolated Drive',
    definition:
      'Real independent guest mouse/keyboard through a VM. Distinct from --taskwraith-isolated-instance profile isolation, which is host state isolation only.',
    shipStatus: 'rfc_only',
    mayClaimNonDisruptiveControl: false,
    requiresInterferenceHarness: true,
    independentGuestHid: true
  }
] as const

/** Modes that may appear in shipped product chrome this vertical slice. */
export const APP_DRIVE_SHIPPED_UI_MODES: readonly AppDriveDriveMode[] = ['foreground']

/** Explicit session controls allowed without expanding desktop authority. */
export const APP_DRIVE_EXPLICIT_SESSION_CONTROLS = ['pause', 'resume', 'takeover', 'stop'] as const

export type AppDriveExplicitSessionControl = (typeof APP_DRIVE_EXPLICIT_SESSION_CONTROLS)[number]

/**
 * Forbidden authority expansions for this mission slice.
 * These remain RFC/prototype until explicit user consent widens desktop authority.
 */
export const APP_DRIVE_FORBIDDEN_THIS_SLICE = [
  'cgevent_productization',
  'global_cgevent_post',
  'cursor_warp',
  'clipboard_typing',
  'persistent_app_keyed_approvals',
  'agent_triggered_permission_prompts',
  'silent_background_to_foreground_fallback',
  'automatic_target_scoped_native_pause_claim'
] as const

export type AppDriveForbiddenThisSlice = (typeof APP_DRIVE_FORBIDDEN_THIS_SLICE)[number]

export const APP_DRIVE_INTERFERENCE_HARNESS_METRICS = [
  'focus',
  'frontmost_app',
  'host_cursor',
  'keyboard_target',
  'clipboard_hash',
  'activation',
  'target_success',
  'target_scoped_human_arbitration'
] as const

export type AppDriveInterferenceHarnessMetric =
  (typeof APP_DRIVE_INTERFERENCE_HARNESS_METRICS)[number]

export interface AppDriveModeLookup {
  readonly mode: AppDriveDriveMode
  readonly definition: AppDriveModeDefinition
}

export function getAppDriveModeDefinition(mode: AppDriveDriveMode): AppDriveModeDefinition {
  const found = APP_DRIVE_MODE_DEFINITIONS.find((entry) => entry.mode === mode)
  if (!found) {
    throw new Error(`Unknown App Drive mode: ${String(mode)}`)
  }
  return found
}

export function isAppDriveModeShippedInUi(mode: AppDriveDriveMode): boolean {
  return (APP_DRIVE_SHIPPED_UI_MODES as readonly string[]).includes(mode)
}

export function assertNoSilentModeFallback(
  requested: AppDriveDriveMode,
  effective: AppDriveDriveMode
): { ok: true } | { ok: false; code: 'silent_mode_fallback_forbidden'; message: string } {
  if (requested === effective) return { ok: true }
  return {
    ok: false,
    code: 'silent_mode_fallback_forbidden',
    message: `Silent fallback from ${requested} to ${effective} is forbidden; modes must be explicit and fail closed.`
  }
}

export function canClaimBackgroundDriveSupport(args: {
  readonly interferenceHarnessPassedForApp: boolean
  readonly zeroHostInterferenceProven: boolean
}): boolean {
  return args.interferenceHarnessPassedForApp && args.zeroHostInterferenceProven
}

export function describeNativeHumanArbitrationHonesty(): {
  readonly sensorScope: 'host_global_hid'
  readonly targetScopedClaimAllowed: false
  readonly explicitUiControlsAllowed: true
} {
  return {
    sensorScope: 'host_global_hid',
    targetScopedClaimAllowed: false,
    explicitUiControlsAllowed: true
  }
}
