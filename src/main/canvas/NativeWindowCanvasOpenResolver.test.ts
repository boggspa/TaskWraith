import { describe, expect, it } from 'vitest'

import type { LaunchAttempt } from '../launch/types'
import type {
  NativeWindowCoordinatorCanvasAccess,
  NativeWindowCoordinatorCanvasOwner,
  NativeWindowCoordinatorRendererStatus
} from '../nativeWindow/NativeWindowCoordinator'
import {
  resolveNativeWindowCanvasOpenTarget,
  type NativeWindowCanvasOpenCoordinator,
  type NativeWindowCanvasOpenObservation,
  type NativeWindowCanvasOpenResolverInput,
  type NativeWindowCanvasOpenTargetIssuer
} from './NativeWindowCanvasOpenResolver'

function attempt(overrides: Partial<LaunchAttempt> = {}): LaunchAttempt {
  const targetSnapshot: LaunchAttempt['targetSnapshot'] = {
    id: 'target-a',
    label: 'Target A',
    workspacePath: '/workspace',
    source: 'package-script',
    kind: 'run',
    platform: 'macos',
    confidence: 1,
    evidence: [],
    blockers: []
  }
  return {
    schemaVersion: 1,
    id: 'attempt-a',
    targetId: targetSnapshot.id,
    targetLabel: targetSnapshot.label,
    targetSource: targetSnapshot.source,
    targetKind: targetSnapshot.kind,
    targetSnapshot,
    targetSnapshotHash: 'target-hash',
    provider: 'codex',
    workspacePath: '/workspace',
    cwd: '/workspace',
    commandRaw: 'npm run dev',
    argv: ['npm', 'run', 'dev'],
    pid: 102,
    pgid: 101,
    processStartedAt: 'procBSDInfo:1774843200123456',
    status: 'running',
    startedAt: '2026-07-28T03:00:00.000Z',
    updatedAt: '2026-07-28T03:00:00.000Z',
    outputTail: '',
    outputTailBytes: 0,
    outputTruncated: false,
    chatId: 'chat-a',
    runId: 'run-a',
    ...overrides
  }
}

const OWNER: NativeWindowCoordinatorCanvasOwner = {
  chatId: 'chat-a',
  runId: 'run-a',
  launchAttemptId: 'attempt-a',
  provider: 'codex',
  participantId: null
}

function observation(
  overrides: Partial<NativeWindowCanvasOpenObservation> = {}
): NativeWindowCanvasOpenObservation {
  return {
    chatID: OWNER.chatId,
    windowMeta: {
      pid: 102,
      windowID: 42,
      processStartedAt: 'procBSDInfo:1774843200123456'
    },
    ...overrides
  }
}

function status(
  overrides: Partial<NativeWindowCoordinatorRendererStatus> = {}
): NativeWindowCoordinatorRendererStatus {
  return {
    pickerPending: false,
    observation: {
      chatId: OWNER.chatId,
      generation: 7,
      attachedAt: '2026-07-28T03:00:00.000Z',
      window: {
        title: 'A window title this resolver must not inspect',
        bundleID: 'com.example.target',
        applicationName: 'Example Target',
        identityQuality: 'exact'
      }
    },
    control: {
      chatId: OWNER.chatId,
      runId: OWNER.runId,
      provider: OWNER.provider,
      participantId: null,
      launchAttemptId: OWNER.launchAttemptId,
      approvedAt: 1,
      approvedBy: 'user',
      trustState: 'user-approved',
      allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
      expiresAt: 60_000,
      stepBudget: 2,
      stepsUsed: 0,
      stepsRemaining: 2,
      mode: 'foreground',
      lifecycle: 'active',
      canAdmitActions: true,
      virtualCursor: null
    },
    ...overrides
  }
}

function access(
  overrides: Partial<NativeWindowCoordinatorCanvasAccess> = {}
): NativeWindowCoordinatorCanvasAccess {
  return {
    lease: {
      chatId: OWNER.chatId,
      runId: OWNER.runId,
      attemptId: OWNER.launchAttemptId,
      pid: 102,
      expectedPid: 102,
      ownership: 'exact',
      windowId: 42,
      processStartedAt: 'procBSDInfo:1774843200123456',
      instanceEpoch: 'instance-a',
      consentEpoch: 'consent-a',
      generation: 7
    },
    attachment: {
      handleID: 'private-handle',
      scopeID: 'private-scope',
      chatID: OWNER.chatId,
      consentEpoch: 1,
      generation: 7
    },
    target: {
      pid: 102,
      windowID: 42,
      bundleID: 'com.example.target',
      processLaunchTimeMicros: 1_774_843_200_123_456,
      expectedBounds: { x: 1, y: 2, width: 3, height: 4 }
    },
    protectedHostPIDs: [900],
    ...overrides
  }
}

class FakeCoordinator implements NativeWindowCanvasOpenCoordinator {
  currentStatus: NativeWindowCoordinatorRendererStatus | null = status()
  currentObservation: NativeWindowCanvasOpenObservation | null = observation()
  currentAccess: NativeWindowCoordinatorCanvasAccess | null = access()
  throwOnStatus = false
  throwOnObservation = false
  throwOnLease = false
  readonly statusCalls: string[] = []
  readonly observationCalls: string[] = []
  readonly leaseCalls: Array<{ owner: NativeWindowCoordinatorCanvasOwner; verb: string }> = []

  statusForChat(chatId: string): NativeWindowCoordinatorRendererStatus {
    this.statusCalls.push(chatId)
    if (this.throwOnStatus || !this.currentStatus) throw new Error('status unavailable')
    return this.currentStatus
  }

  getObservationForChat(chatId: string): NativeWindowCanvasOpenObservation | null {
    this.observationCalls.push(chatId)
    if (this.throwOnObservation) throw new Error('observation unavailable')
    return this.currentObservation
  }

  resolveLeaseForCanvas(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb: 'observe' | 'inspect' = 'observe'
  ): NativeWindowCoordinatorCanvasAccess {
    this.leaseCalls.push({ owner, verb })
    if (this.throwOnLease || !this.currentAccess) throw new Error('lease unavailable')
    return this.currentAccess
  }
}

class FakeIssuer implements NativeWindowCanvasOpenTargetIssuer {
  readonly owners: NativeWindowCoordinatorCanvasOwner[] = []
  throws = false
  target: { leaseId: string; privateHandle?: string } = {
    leaseId: 'opaque-open-target',
    privateHandle: 'must-not-leave-main'
  }

  issueOpenTarget(owner: NativeWindowCoordinatorCanvasOwner) {
    this.owners.push(owner)
    if (this.throws) throw new Error('lease changed')
    return this.target
  }
}

function input(
  overrides: Partial<NativeWindowCanvasOpenResolverInput> = {}
): NativeWindowCanvasOpenResolverInput {
  return {
    attempt: attempt(),
    context: {
      appChatId: OWNER.chatId,
      appRunId: OWNER.runId,
      workspacePath: '/workspace',
      parentProvider: OWNER.provider
    },
    platform: 'darwin',
    macosVersion: '15.2.1',
    appDriveCapability: { available: true },
    isDaemonRunning: () => true,
    coordinator: new FakeCoordinator(),
    targetIssuer: new FakeIssuer(),
    ...overrides
  }
}

function reason(result: ReturnType<typeof resolveNativeWindowCanvasOpenTarget>): string {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected an unavailable native-window target.')
  return result.reason
}

describe('NativeWindowCanvasOpenResolver', () => {
  it('issues only an opaque target for the exact launch PID and birth receipt', () => {
    const coordinator = new FakeCoordinator()
    const issuer = new FakeIssuer()
    const result = resolveNativeWindowCanvasOpenTarget(input({ coordinator, targetIssuer: issuer }))

    expect(result).toEqual({ ok: true, target: { leaseId: 'opaque-open-target' } })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.ok ? result.target : null)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('must-not-leave-main')
    expect(issuer.owners).toEqual([OWNER])
    expect(coordinator.leaseCalls).toEqual([{ owner: OWNER, verb: 'observe' }])
  })

  it('fails before attachment access on non-macOS or macOS below 15.2', () => {
    const coordinator = new FakeCoordinator()
    const issuer = new FakeIssuer()

    expect(
      reason(
        resolveNativeWindowCanvasOpenTarget(
          input({ platform: 'linux', coordinator, targetIssuer: issuer })
        )
      )
    ).toBe('not-native-macos-launch')
    expect(
      reason(
        resolveNativeWindowCanvasOpenTarget(
          input({ macosVersion: '15.1.9', coordinator, targetIssuer: issuer })
        )
      )
    ).toBe('not-native-macos-launch')
    expect(coordinator.statusCalls).toEqual([])
    expect(issuer.owners).toEqual([])
  })

  it('fails before attachment access without a running daemon or current AppDrive capability', () => {
    const coordinator = new FakeCoordinator()
    const issuer = new FakeIssuer()

    expect(
      reason(
        resolveNativeWindowCanvasOpenTarget(
          input({ appDriveCapability: { available: false }, coordinator, targetIssuer: issuer })
        )
      )
    ).toBe('native-bridge-unavailable')
    expect(
      reason(
        resolveNativeWindowCanvasOpenTarget(
          input({ isDaemonRunning: () => false, coordinator, targetIssuer: issuer })
        )
      )
    ).toBe('native-bridge-unavailable')
    expect(coordinator.statusCalls).toEqual([])
    expect(issuer.owners).toEqual([])
  })

  it('rejects any non-exact active attempt owner or process identity before issuing a target', () => {
    const cases: Array<Partial<NativeWindowCanvasOpenResolverInput>> = [
      { context: { ...input().context, appChatId: 'chat-b' } },
      { context: { ...input().context, appRunId: 'run-b' } },
      { context: { ...input().context, parentProvider: 'claude' } },
      { context: { ...input().context, workspacePath: '/other-workspace' } },
      { attempt: attempt({ status: 'stopping' }) },
      { attempt: attempt({ pid: 0 }) },
      { attempt: attempt({ processStartedAt: undefined }) }
    ]

    for (const overrides of cases) {
      const issuer = new FakeIssuer()
      expect(
        reason(resolveNativeWindowCanvasOpenTarget(input({ ...overrides, targetIssuer: issuer })))
      ).toBe('target-unavailable')
      expect(issuer.owners).toEqual([])
    }

    const coordinator = new FakeCoordinator()
    coordinator.currentObservation = observation({
      windowMeta: {
        pid: 202,
        windowID: 42,
        processStartedAt: 'procBSDInfo:1774843200123456'
      }
    })
    expect(reason(resolveNativeWindowCanvasOpenTarget(input({ coordinator })))).toBe(
      'target-unavailable'
    )

    const reusedPid = new FakeCoordinator()
    reusedPid.currentObservation = observation({
      windowMeta: {
        pid: 102,
        windowID: 42,
        processStartedAt: 'procBSDInfo:1774843200999999'
      }
    })
    expect(reason(resolveNativeWindowCanvasOpenTarget(input({ coordinator: reusedPid })))).toBe(
      'target-unavailable'
    )
  })

  it('issues a target for a window owned by a proved descendant of the launch', () => {
    // The lease records the descent that was verified during the consented
    // pick; the window PID legitimately differs from the launch PID here.
    const coordinator = new FakeCoordinator()
    const windowPid = 202
    coordinator.currentObservation = observation({
      windowMeta: {
        pid: windowPid,
        windowID: 42,
        processStartedAt: 'procBSDInfo:1774843200999999'
      }
    })
    coordinator.currentAccess = access({
      lease: {
        ...access().lease,
        pid: windowPid,
        expectedPid: 102,
        ownership: 'descendant',
        processStartedAt: 'procBSDInfo:1774843200999999'
      }
    })

    const issuer = new FakeIssuer()
    const result = resolveNativeWindowCanvasOpenTarget(input({ coordinator, targetIssuer: issuer }))

    expect(result.ok).toBe(true)
    expect(issuer.owners).toHaveLength(1)
  })

  it('refuses a descendant lease that points at a different launch process', () => {
    const coordinator = new FakeCoordinator()
    coordinator.currentObservation = observation({
      windowMeta: {
        pid: 202,
        windowID: 42,
        processStartedAt: 'procBSDInfo:1774843200999999'
      }
    })
    coordinator.currentAccess = access({
      lease: {
        ...access().lease,
        pid: 202,
        // Not this attempt's PID.
        expectedPid: 999,
        ownership: 'descendant',
        processStartedAt: 'procBSDInfo:1774843200999999'
      }
    })

    expect(reason(resolveNativeWindowCanvasOpenTarget(input({ coordinator })))).toBe(
      'target-unavailable'
    )
  })

  it('does not use a process group as native-control eligibility', () => {
    const exactPidWithDifferentGroup = attempt({ pgid: 999 })
    expect(
      resolveNativeWindowCanvasOpenTarget(input({ attempt: exactPidWithDifferentGroup }))
    ).toEqual({ ok: true, target: { leaseId: 'opaque-open-target' } })

    const sameGroupWrongPid = new FakeCoordinator()
    sameGroupWrongPid.currentObservation = observation({
      windowMeta: {
        pid: 101,
        windowID: 42,
        processStartedAt: 'procBSDInfo:1774843200123456'
      }
    })
    expect(
      reason(resolveNativeWindowCanvasOpenTarget(input({ coordinator: sameGroupWrongPid })))
    ).toBe('target-unavailable')
  })

  it('distinguishes missing observation from view-only attachment state', () => {
    const missing = new FakeCoordinator()
    missing.currentStatus = status({ observation: null, control: null })
    expect(reason(resolveNativeWindowCanvasOpenTarget(input({ coordinator: missing })))).toBe(
      'attachment-required'
    )

    const viewOnly = new FakeCoordinator()
    viewOnly.currentStatus = status({ control: null })
    expect(reason(resolveNativeWindowCanvasOpenTarget(input({ coordinator: viewOnly })))).toBe(
      'view-control-not-approved'
    )
  })

  it('rejects stale control owners, stale leases, and issuer failures without returning an attachment', () => {
    const controls = [
      { runId: 'run-b' },
      { provider: 'claude' },
      { launchAttemptId: 'attempt-b' },
      { participantId: 'participant-a' }
    ]
    for (const controlOverrides of controls) {
      const badControl = new FakeCoordinator()
      const issuer = new FakeIssuer()
      badControl.currentStatus = status({
        control: { ...status().control!, ...controlOverrides }
      })
      expect(
        reason(
          resolveNativeWindowCanvasOpenTarget(
            input({ coordinator: badControl, targetIssuer: issuer })
          )
        )
      ).toBe('attachment-stale')
      expect(issuer.owners).toEqual([])
    }

    const badLease = new FakeCoordinator()
    badLease.currentAccess = access({
      lease: { ...access().lease, processStartedAt: 'reused-pid' }
    })
    expect(reason(resolveNativeWindowCanvasOpenTarget(input({ coordinator: badLease })))).toBe(
      'attachment-stale'
    )

    const issuer = new FakeIssuer()
    issuer.throws = true
    expect(reason(resolveNativeWindowCanvasOpenTarget(input({ targetIssuer: issuer })))).toBe(
      'attachment-stale'
    )
  })
})
