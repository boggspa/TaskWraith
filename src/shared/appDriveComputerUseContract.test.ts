import { describe, expect, it } from 'vitest'

import {
  APP_DRIVE_CANONICAL_LIFECYCLE_STATES,
  APP_DRIVE_COMPUTER_USE_CONTRACT_ID,
  APP_DRIVE_EXPLICIT_SESSION_CONTROLS,
  APP_DRIVE_FORBIDDEN_THIS_SLICE,
  APP_DRIVE_INTERFERENCE_HARNESS_METRICS,
  APP_DRIVE_MODE_DEFINITIONS,
  APP_DRIVE_SHIPPED_UI_MODES,
  assertNoSilentModeFallback,
  canClaimBackgroundDriveSupport,
  deriveAppDriveActivityDisplayLabel,
  describeAppDriveLifecycleHonesty,
  describeAppDriveShipBoundary,
  describeNativeHumanArbitrationHonesty,
  getAppDriveModeDefinition,
  isAppDriveCanonicalLifecycleState,
  isAppDriveModeShippedInUi
} from './appDriveComputerUseContract'

describe('appDriveComputerUseContract', () => {
  it('locks the three-mode taxonomy and ship statuses from the synthesis gate', () => {
    expect(APP_DRIVE_COMPUTER_USE_CONTRACT_ID).toBe('appdrive-computer-use-v1')
    expect(APP_DRIVE_MODE_DEFINITIONS.map((entry) => entry.mode)).toEqual([
      'foreground',
      'background',
      'isolated'
    ])

    expect(getAppDriveModeDefinition('foreground').shipStatus).toBe('ship_ui_on_existing_authority')
    expect(getAppDriveModeDefinition('background').shipStatus).toBe('prototype_rfc_only')
    expect(getAppDriveModeDefinition('isolated').shipStatus).toBe('rfc_only')

    expect(APP_DRIVE_SHIPPED_UI_MODES).toEqual(['foreground'])
    expect(isAppDriveModeShippedInUi('foreground')).toBe(true)
    expect(isAppDriveModeShippedInUi('background')).toBe(false)
    expect(isAppDriveModeShippedInUi('isolated')).toBe(false)
  })

  it('forbids non-disruptive claims and silent mode fallbacks', () => {
    for (const entry of APP_DRIVE_MODE_DEFINITIONS) {
      expect(entry.mayClaimNonDisruptiveControl).toBe(false)
    }

    expect(getAppDriveModeDefinition('background').requiresInterferenceHarness).toBe(true)
    expect(getAppDriveModeDefinition('isolated').independentGuestHid).toBe(true)
    expect(getAppDriveModeDefinition('isolated').definition).toMatch(/VM/)
    expect(getAppDriveModeDefinition('isolated').definition).toMatch(/taskwraith-isolated-instance/)

    expect(assertNoSilentModeFallback('background', 'background')).toEqual({ ok: true })
    expect(assertNoSilentModeFallback('background', 'foreground')).toEqual({
      ok: false,
      code: 'silent_mode_fallback_forbidden',
      message: expect.stringContaining('Silent fallback')
    })

    expect(
      canClaimBackgroundDriveSupport({
        interferenceHarnessPassedForApp: false,
        zeroHostInterferenceProven: true
      })
    ).toBe(false)
    expect(
      canClaimBackgroundDriveSupport({
        interferenceHarnessPassedForApp: true,
        zeroHostInterferenceProven: true
      })
    ).toBe(true)
  })

  it('keeps native arbitration honest and lists explicit session controls only', () => {
    expect(describeNativeHumanArbitrationHonesty()).toEqual({
      sensorScope: 'host_global_hid',
      targetScopedClaimAllowed: false,
      explicitUiControlsAllowed: true
    })

    expect([...APP_DRIVE_EXPLICIT_SESSION_CONTROLS]).toEqual([
      'pause',
      'resume',
      'takeover',
      'stop'
    ])

    expect(APP_DRIVE_FORBIDDEN_THIS_SLICE).toEqual(
      expect.arrayContaining([
        'cgevent_productization',
        'global_cgevent_post',
        'cursor_warp',
        'clipboard_typing',
        'persistent_app_keyed_approvals',
        'agent_triggered_permission_prompts',
        'silent_background_to_foreground_fallback',
        'automatic_target_scoped_native_pause_claim'
      ])
    )

    expect(APP_DRIVE_INTERFERENCE_HARNESS_METRICS).toEqual([
      'focus',
      'frontmost_app',
      'host_cursor',
      'keyboard_target',
      'clipboard_hash',
      'activation',
      'target_success',
      'target_scoped_human_arbitration'
    ])
  })

  it('locks canonical lifecycle literals and Viewing/Driving as display labels only', () => {
    expect([...APP_DRIVE_CANONICAL_LIFECYCLE_STATES]).toEqual([
      'idle',
      'active',
      'paused',
      'takeover',
      'stopped'
    ])
    expect(isAppDriveCanonicalLifecycleState('active')).toBe(true)
    expect(isAppDriveCanonicalLifecycleState('viewing')).toBe(false)
    expect(isAppDriveCanonicalLifecycleState('driving')).toBe(false)

    expect(describeAppDriveLifecycleHonesty()).toEqual({
      canonicalStates: APP_DRIVE_CANONICAL_LIFECYCLE_STATES,
      viewingDrivingAreDisplayLabelsOnly: true,
      forbiddenLifecycleLiterals: ['viewing', 'driving']
    })

    expect(
      deriveAppDriveActivityDisplayLabel({
        lifecycle: 'active',
        hasObservationAttachment: true,
        hasControlLease: true
      })
    ).toBe('Driving')
    expect(
      deriveAppDriveActivityDisplayLabel({
        lifecycle: 'active',
        hasObservationAttachment: true,
        hasControlLease: false
      })
    ).toBe('Viewing')
    expect(
      deriveAppDriveActivityDisplayLabel({
        lifecycle: 'paused',
        hasObservationAttachment: true,
        hasControlLease: true
      })
    ).toBe('Idle')

    expect(describeAppDriveShipBoundary()).toEqual({
      foregroundAxAuthority: 'shipped_tier_4',
      uiSessionVerticalSlice: 'candidate_until_boss_wiring',
      backgroundDrive: 'prototype_only',
      isolatedDrive: 'rfc_only',
      externalPrerequisites: [
        'exact_run_window_lease',
        'secret_field_refusal',
        'stale_target_and_input_epoch_gates',
        'per_click_audit_claim',
        'user_only_consent'
      ]
    })
  })
})
