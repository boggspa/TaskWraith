import { describe, expect, it } from 'vitest'

import {
  APP_DRIVE_ALLOWED_VERBS,
  APP_DRIVE_AUDIT_POLICY,
  APP_DRIVE_AUTHORITY_MODEL_ID,
  APP_DRIVE_CONSENT_LAYERS,
  APP_DRIVE_HUMAN_ARBITRATION,
  APP_DRIVE_SECRET_POLICY,
  APP_DRIVE_SESSION_LIFECYCLE_STATES,
  APP_DRIVE_SHIPPED_DRIVE_MODE,
  applyAppDriveSessionControl,
  describeAppDrivePermissionLabel,
  evaluateAppDriveAuthorityAdmission,
  isAppDriveSessionLifecycleState,
  isValidAppDriveAuthorityBinding,
  projectAppDriveAuthorityDisclosure,
  refuseAuthorizeFromDisplayIdentity,
  refusePersistentAppApproval,
  type AppDriveAuthorityBinding
} from './AppDriveAuthorityModel'

const BINDING: AppDriveAuthorityBinding = {
  chatId: 'chat-a',
  runId: 'run-a',
  launchAttemptId: 'attempt-a',
  expectedPid: 4242,
  selectedPid: 4242,
  processStartedAt: 'procBSDInfo:1774843200123456',
  windowId: 7
}

describe('AppDriveAuthorityModel', () => {
  it('uses the canonical idle|active|paused|takeover|stopped lifecycle', () => {
    expect([...APP_DRIVE_SESSION_LIFECYCLE_STATES]).toEqual([
      'idle',
      'active',
      'paused',
      'takeover',
      'stopped'
    ])
    expect(isAppDriveSessionLifecycleState('idle')).toBe(true)
    expect(isAppDriveSessionLifecycleState('driving')).toBe(false)
    expect(isAppDriveSessionLifecycleState('viewing')).toBe(false)
  })

  it('treats exact chat/run/launch/process-birth as the only valid binding', () => {
    expect(isValidAppDriveAuthorityBinding(BINDING)).toBe(true)
    expect(
      isValidAppDriveAuthorityBinding({
        ...BINDING,
        expectedPid: 1,
        selectedPid: 2
      })
    ).toBe(false)
    expect(
      isValidAppDriveAuthorityBinding({
        ...BINDING,
        processStartedAt: 'not-a-receipt'
      })
    ).toBe(false)
    expect(isValidAppDriveAuthorityBinding(null)).toBe(false)
  })

  it('never treats bundle ID as authority and forbids persistent app approvals', () => {
    const fromDisplay = refuseAuthorizeFromDisplayIdentity()
    expect(fromDisplay.ok).toBe(false)
    expect(fromDisplay.code).toBe('display_identity_is_not_authority')

    const persistent = refusePersistentAppApproval()
    expect(persistent.ok).toBe(false)
    expect(persistent.code).toBe('persistent_app_approval_forbidden')

    const denied = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      lifecycle: 'active',
      verb: 'click',
      authorizeFromDisplayIdentity: true,
      displayIdentity: { bundleId: 'com.example.app' }
    })
    expect(denied).toEqual(fromDisplay)

    const noPersist = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      lifecycle: 'active',
      verb: 'click',
      requestPersistentAppApproval: true
    })
    expect(noPersist).toEqual(persistent)
  })

  it('covers idle, view-only, and current-launch permission semantics', () => {
    expect(
      describeAppDrivePermissionLabel({
        hasObservationAttachment: false,
        hasUserViewAndControlLease: false
      })
    ).toBe('No attachment')
    expect(
      describeAppDrivePermissionLabel({
        hasObservationAttachment: true,
        hasUserViewAndControlLease: false
      })
    ).toBe('View only')
    expect(
      describeAppDrivePermissionLabel({
        hasObservationAttachment: true,
        hasUserViewAndControlLease: true
      })
    ).toBe('View & Control (current launch only)')

    const idleClick = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      leaseApprovedBy: 'user',
      lifecycle: 'idle',
      verb: 'click'
    })
    expect(idleClick.ok).toBe(false)
    if (!idleClick.ok) expect(idleClick.code).toBe('session_idle')

    const idleObserve = evaluateAppDriveAuthorityAdmission({
      binding: null,
      hasUserViewAndControlLease: false,
      lifecycle: 'idle',
      verb: 'observe'
    })
    expect(idleObserve.ok).toBe(false)
    if (!idleObserve.ok) expect(idleObserve.code).toBe('session_idle')

    const viewOnlyObserve = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: false,
      lifecycle: 'active',
      verb: 'observe'
    })
    expect(viewOnlyObserve).toEqual({
      ok: true,
      code: 'admitted',
      driveMode: APP_DRIVE_SHIPPED_DRIVE_MODE,
      lifecycle: 'active'
    })

    const viewOnlyClick = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: false,
      leaseApprovedBy: 'user',
      lifecycle: 'active',
      verb: 'click'
    })
    expect(viewOnlyClick.ok).toBe(false)
    if (!viewOnlyClick.ok) expect(viewOnlyClick.code).toBe('control_requires_view_and_control')

    const viewOnlyDisclosure = projectAppDriveAuthorityDisclosure({
      binding: BINDING,
      displayIdentity: { bundleId: 'com.example.app', applicationName: 'Example' },
      lifecycle: 'active',
      hasUserViewAndControlLease: false,
      hasObservationAttachment: true
    })
    expect(viewOnlyDisclosure.permissionLabel).toBe('View only')
    expect(viewOnlyDisclosure.currentLaunchOnly).toBe(true)
    expect(viewOnlyDisclosure.persistentAppApproval).toBe(false)
    expect(viewOnlyDisclosure.bundleIdIsAuthority).toBe(false)

    const currentLaunch = projectAppDriveAuthorityDisclosure({
      binding: BINDING,
      displayIdentity: { bundleId: 'com.example.app' },
      lifecycle: 'active',
      hasUserViewAndControlLease: true
    })
    expect(currentLaunch.permissionLabel).toBe('View & Control (current launch only)')
    expect(currentLaunch.currentLaunchOnly).toBe(true)
    expect(currentLaunch.persistentAppApproval).toBe(false)
  })

  it('requires user-only consent and a View & Control lease for control verbs', () => {
    const agentMint = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      leaseApprovedBy: 'boss',
      lifecycle: 'active',
      verb: 'click'
    })
    expect(agentMint.ok).toBe(false)
    if (!agentMint.ok) expect(agentMint.code).toBe('non_user_consent_forbidden')

    const noLease = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: false,
      leaseApprovedBy: 'user',
      lifecycle: 'active',
      verb: 'fill'
    })
    expect(noLease.ok).toBe(false)
    if (!noLease.ok) expect(noLease.code).toBe('control_requires_view_and_control')

    const observeWithoutControl = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: false,
      lifecycle: 'active',
      verb: 'observe'
    })
    expect(observeWithoutControl).toEqual({
      ok: true,
      code: 'admitted',
      driveMode: APP_DRIVE_SHIPPED_DRIVE_MODE,
      lifecycle: 'active'
    })
  })

  it('labels secret/audit constants as inherited evidence, not reenforcement', () => {
    expect(APP_DRIVE_SECRET_POLICY).toMatchObject({
      evidenceKind: 'inherited_tier4_policy',
      reenforcesNativeEnforcement: false,
      secureFieldsRefused: true,
      fillSecureFieldsForbidden: true,
      captureRefusedWhenSecurePresentOrUnknown: true,
      valuesNeverReturned: true,
      noRetryOrWorkaround: true,
      refusalReason: 'secret_field'
    })
    expect(APP_DRIVE_AUDIT_POLICY).toMatchObject({
      evidenceKind: 'inherited_tier4_policy',
      reenforcesNativeEnforcement: false,
      perClickDurableClaimRequired: true,
      durablePayloadAllowsSecrets: false,
      durablePayloadAllowsAxText: false,
      durablePayloadAllowsRawRef: false,
      durablePayloadAllowsPidOrHandle: false,
      approvalLedgerJoinedForNativeLease: false
    })

    const secretClick = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      leaseApprovedBy: 'user',
      lifecycle: 'active',
      verb: 'click',
      targetIsSecureField: true
    })
    expect(secretClick.ok).toBe(false)
    if (!secretClick.ok) {
      expect(secretClick.code).toBe('secret_field_refused')
      expect(secretClick.message).toMatch(/inherited Tier 4 evidence/i)
    }
  })

  it('models explicit pause/takeover/stop without claiming target-scoped HID', () => {
    expect(APP_DRIVE_HUMAN_ARBITRATION).toEqual({
      nativeSensor: 'host_global_hid',
      targetScopedAutomaticPauseClaimed: false,
      explicitSessionControlsSupported: true,
      webCanvasTargetScoped: true
    })

    expect(applyAppDriveSessionControl({ current: 'idle', action: 'pause' }).ok).toBe(false)
    expect(applyAppDriveSessionControl({ current: 'active', action: 'pause' })).toEqual({
      ok: true,
      next: 'paused'
    })
    expect(applyAppDriveSessionControl({ current: 'paused', action: 'resume' })).toEqual({
      ok: true,
      next: 'active'
    })
    expect(applyAppDriveSessionControl({ current: 'active', action: 'takeover' })).toEqual({
      ok: true,
      next: 'takeover'
    })
    expect(applyAppDriveSessionControl({ current: 'takeover', action: 'resume' })).toEqual({
      ok: true,
      next: 'active'
    })
    expect(applyAppDriveSessionControl({ current: 'active', action: 'stop' })).toEqual({
      ok: true,
      next: 'stopped'
    })
    expect(applyAppDriveSessionControl({ current: 'stopped', action: 'resume' }).ok).toBe(false)

    const pausedClick = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      leaseApprovedBy: 'user',
      lifecycle: 'paused',
      verb: 'click'
    })
    expect(pausedClick.ok).toBe(false)
    if (!pausedClick.ok) expect(pausedClick.code).toBe('session_paused')

    const takeoverFill = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      leaseApprovedBy: 'user',
      lifecycle: 'takeover',
      verb: 'fill'
    })
    expect(takeoverFill.ok).toBe(false)
    if (!takeoverFill.ok) expect(takeoverFill.code).toBe('session_takeover')

    const pausedObserve = evaluateAppDriveAuthorityAdmission({
      binding: BINDING,
      hasUserViewAndControlLease: true,
      leaseApprovedBy: 'user',
      lifecycle: 'paused',
      verb: 'observe'
    })
    expect(pausedObserve.ok).toBe(true)
  })

  it('projects honest Foreground Drive disclosure for dock/status consumers', () => {
    const disclosure = projectAppDriveAuthorityDisclosure({
      binding: BINDING,
      displayIdentity: {
        bundleId: 'com.example.app',
        applicationName: 'Example',
        windowTitle: 'QA'
      },
      lifecycle: 'active',
      hasUserViewAndControlLease: true
    })

    expect(disclosure.modelId).toBe(APP_DRIVE_AUTHORITY_MODEL_ID)
    expect(disclosure.driveMode).toBe('foreground')
    expect(disclosure.driveModeLabel).toBe('Foreground Drive')
    expect(disclosure.permissionLabel).toBe('View & Control (current launch only)')
    expect(disclosure.bundleIdIsAuthority).toBe(false)
    expect(disclosure.persistentAppApproval).toBe(false)
    expect(disclosure.currentLaunchOnly).toBe(true)
    expect(disclosure.approvedBy).toBe('user')
    expect(disclosure.allowedVerbs).toEqual([...APP_DRIVE_ALLOWED_VERBS])
    expect(disclosure.displayIdentity.bundleId).toBe('com.example.app')
    expect(disclosure.bindingPresent).toBe(true)
    expect(disclosure.chatId).toBe('chat-a')
    expect(disclosure.humanArbitration.targetScopedAutomaticPauseClaimed).toBe(false)
    expect(disclosure.secretPolicy.reenforcesNativeEnforcement).toBe(false)
    expect(disclosure.auditPolicy.reenforcesNativeEnforcement).toBe(false)

    const idleDisclosure = projectAppDriveAuthorityDisclosure({
      binding: null,
      lifecycle: 'idle',
      hasUserViewAndControlLease: false,
      hasObservationAttachment: false
    })
    expect(idleDisclosure.lifecycle).toBe('idle')
    expect(idleDisclosure.permissionLabel).toBe('No attachment')
    expect(idleDisclosure.bindingPresent).toBe(false)

    const consent = APP_DRIVE_CONSENT_LAYERS.find((layer) => layer.layer === 'view_and_control')
    expect(consent).toMatchObject({
      approvedBy: 'user',
      persistence: 'process_local_lease',
      mintsControlAuthority: true,
      durableAppKeyedApproval: false
    })
  })
})
