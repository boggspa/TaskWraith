/**
 * Acceptance invariants for the App Drive Computer Use vertical slice.
 *
 * Locks synthesis-gate honesty against current production seams without
 * wiring dock/session chrome or expanding native input authority.
 * Exact-run/window leases, secret refusal, stale-target/input gates, and
 * per-click audit remain external prerequisites owned by existing Tier 4 code.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { getNativeCapabilitySnapshot } from '../NativeCapabilities'
import {
  APP_DRIVE_CANONICAL_LIFECYCLE_STATES,
  APP_DRIVE_FORBIDDEN_THIS_SLICE,
  APP_DRIVE_SHIPPED_UI_MODES,
  assertNoSilentModeFallback,
  describeAppDriveShipBoundary,
  describeNativeHumanArbitrationHonesty,
  isAppDriveModeShippedInUi
} from '../../shared/appDriveComputerUseContract'
import { NATIVE_WINDOW_TARGET_MINIMUM_MACOS_VERSION } from './NativeWindowTargetOwnership'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..')

function readRepo(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('AppDriveSliceAcceptance', () => {
  it('admits only Foreground Drive in shipped UI and forbids silent mode fallback', () => {
    expect([...APP_DRIVE_SHIPPED_UI_MODES]).toEqual(['foreground'])
    expect(isAppDriveModeShippedInUi('foreground')).toBe(true)
    expect(isAppDriveModeShippedInUi('background')).toBe(false)
    expect(isAppDriveModeShippedInUi('isolated')).toBe(false)

    expect(assertNoSilentModeFallback('background', 'foreground')).toMatchObject({
      ok: false,
      code: 'silent_mode_fallback_forbidden'
    })
    expect(assertNoSilentModeFallback('isolated', 'foreground')).toMatchObject({
      ok: false,
      code: 'silent_mode_fallback_forbidden'
    })

    const boundary = describeAppDriveShipBoundary()
    expect(boundary.foregroundAxAuthority).toBe('shipped_tier_4')
    expect(boundary.uiSessionVerticalSlice).toBe('integrated_foreground_ui_session')
    expect(boundary.backgroundDrive).toBe('prototype_only')
    expect(boundary.isolatedDrive).toBe('rfc_only')
  })

  it('refuses target-scoped native pause claims; HID arbitration stays host-global', () => {
    expect(describeNativeHumanArbitrationHonesty()).toEqual({
      sensorScope: 'host_global_hid',
      targetScopedClaimAllowed: false,
      explicitUiControlsAllowed: true
    })
    expect(APP_DRIVE_FORBIDDEN_THIS_SLICE).toContain('automatic_target_scoped_native_pause_claim')
    expect([...APP_DRIVE_CANONICAL_LIFECYCLE_STATES]).toEqual([
      'idle',
      'active',
      'paused',
      'takeover',
      'stopped'
    ])

    const accessibility = readRepo(
      'swift/TaskWraithBridge/Sources/TaskWraithBridgeDaemon/WindowAccessibility.swift'
    )
    expect(accessibility).toMatch(/hidSystemState/)
    expect(accessibility).toMatch(/physically interacting with the Mac/)
    expect(accessibility).toMatch(/deliberately no CGEvent fallback/i)
    expect(accessibility).not.toMatch(/CGEventPostToPid/)
  })

  it('keeps exact-run/window, secret, audit, and Windows gates as external Tier 4 prerequisites', () => {
    expect(NATIVE_WINDOW_TARGET_MINIMUM_MACOS_VERSION).toBe('15.2')

    const ownership = readRepo('src/main/nativeWindow/NativeWindowTargetOwnership.ts')
    expect(ownership).toMatch(/no title, application name, or bundle identifier/)
    expect(ownership).toMatch(/exact PID plus canonical/)

    const driver = readRepo('src/main/canvas/CanvasWindowDriver.ts')
    expect(driver).toMatch(/'secret_field'/)
    expect(driver).toMatch(/'stale_target'/)
    expect(driver).toMatch(/'user_active'/)
    expect(driver).toMatch(/'stale_input_epoch'/)

    const clickAudit = readRepo('src/main/nativeWindow/NativeWindowClickAudit.ts')
    expect(clickAudit).toMatch(/createNativeWindowClickAuditClaim/)

    const coordinator = readRepo('src/main/nativeWindow/NativeWindowCoordinator.ts')
    expect(coordinator).toMatch(/participantId:\s*null/)

    const windows = getNativeCapabilitySnapshot({
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.26100'
    })
    expect(windows.appDrive.available).toBe(false)

    expect(describeAppDriveShipBoundary().externalPrerequisites).toEqual([
      'exact_run_window_lease',
      'secret_field_refusal',
      'stale_target_and_input_epoch_gates',
      'per_click_audit_claim',
      'user_only_consent'
    ])
  })

  it('keeps production TypeScript free of CGEvent productization hooks', () => {
    const mainNative = readRepo('src/main/nativeWindow/NativeWindowCoordinator.ts')
    const windowDriver = readRepo('src/main/canvas/CanvasWindowDriver.ts')
    for (const source of [mainNative, windowDriver]) {
      expect(source).not.toMatch(/CGEventPost/)
      expect(source).not.toMatch(/CGEventPostToPid/)
      expect(source).not.toMatch(/cursor.?warp/i)
    }
    expect(APP_DRIVE_FORBIDDEN_THIS_SLICE).toEqual(
      expect.arrayContaining([
        'cgevent_productization',
        'global_cgevent_post',
        'cursor_warp',
        'silent_background_to_foreground_fallback'
      ])
    )
  })
})
