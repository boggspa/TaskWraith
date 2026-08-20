import { describe, expect, it } from 'vitest'

import type { LaunchAttempt } from '../launch/types'
import { AppDriveSessionReportStore } from '../appDrive/AppDriveSessionReport'
import {
  NativeWindowCoordinator,
  NativeWindowCoordinatorError,
  type NativeWindowCoordinatorConsentDecision,
  type NativeWindowCoordinatorConsentRequest,
  type NativeWindowCoordinatorDaemon,
  type NativeWindowCoordinatorOptions,
  type NativeWindowCoordinatorRendererEvent
} from './NativeWindowCoordinator'

type RpcCall = {
  method: string
  params: unknown
  options?: { timeoutMs?: number }
}

type PickFixture = {
  handleID: string
  generation: number
  windowMeta: Record<string, unknown>
}

class FakeDaemon implements NativeWindowCoordinatorDaemon {
  running = true
  accessibilityTrusted = true
  readonly calls: RpcCall[] = []
  readonly picks: PickFixture[] = []

  status(): { running: boolean } {
    return { running: this.running }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    this.calls.push({ method, params, ...(options ? { options } : {}) })
    if (method === 'attachedWindow.requestPick') {
      const pick = this.picks.shift()
      if (!pick) throw new Error('No picker fixture queued.')
      const scope = params as {
        scopeID: string
        chatID: string
        consentEpoch: number
      }
      return {
        ok: true,
        scopeID: scope.scopeID,
        chatID: scope.chatID,
        consentEpoch: scope.consentEpoch,
        handleID: pick.handleID,
        generation: pick.generation,
        windowMeta: pick.windowMeta
      } as T
    }
    if (method === 'nativeWindow.requestAccessibility') {
      return {
        trusted: this.accessibilityTrusted,
        promptRequested: true,
        recheckRequired: !this.accessibilityTrusted
      } as T
    }
    if (method === 'attachedWindow.detach') {
      return { ok: true, detached: true, ...(params as object) } as T
    }
    if (method === 'nativeWindow.release') {
      return { ok: true } as T
    }
    throw new Error(`Unexpected RPC: ${method}`)
  }
}

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
    pid: 101,
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

function windowMeta(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const pid = typeof overrides.pid === 'number' ? overrides.pid : 101
  const launchTimeMicros =
    typeof overrides.processLaunchTimeMicros === 'number'
      ? overrides.processLaunchTimeMicros
      : 1_774_843_200_123_456
  return {
    windowID: 42,
    title: 'Run-owned window',
    bundleID: 'com.example.target',
    applicationName: 'Example Target',
    pid,
    pgid: 101,
    identityQuality: 'exact',
    processIdentity: {
      pid,
      launchTimeMicros,
      source: 'procBSDInfo',
      processStartedAt: `procBSDInfo:${launchTimeMicros}`
    },
    processStartedAt: `procBSDInfo:${launchTimeMicros}`,
    bounds: { x: 120, y: 80, width: 1280, height: 720 },
    ...overrides
  }
}

interface Harness {
  coordinator: NativeWindowCoordinator
  daemon: FakeDaemon
  attempts: LaunchAttempt[]
  activeRuns: Set<string>
  protectedPids: number[]
  consentRequests: NativeWindowCoordinatorConsentRequest[]
  rendererEvents: NativeWindowCoordinatorRendererEvent[]
  decisions: NativeWindowCoordinatorConsentDecision[]
  reports: AppDriveSessionReportStore
  advanceTime(ms: number): void
}

function createHarness(
  overrides: Partial<
    Omit<
      NativeWindowCoordinatorOptions,
      | 'instanceEpoch'
      | 'daemon'
      | 'getLaunchAttempts'
      | 'isRunActive'
      | 'getHostProtectedPids'
      | 'requestSecondConsent'
    >
  > & {
    attempts?: LaunchAttempt[]
    protectedPids?: number[]
    decisions?: NativeWindowCoordinatorConsentDecision[]
    requestConsent?: (
      request: NativeWindowCoordinatorConsentRequest
    ) => Promise<NativeWindowCoordinatorConsentDecision>
  } = {}
): Harness {
  const daemon = new FakeDaemon()
  const attempts = overrides.attempts ?? [attempt()]
  const activeRuns = new Set(attempts.map((item) => `${item.chatId}:${item.runId}`))
  const protectedPids = overrides.protectedPids ?? [900, 901]
  const consentRequests: NativeWindowCoordinatorConsentRequest[] = []
  const rendererEvents: NativeWindowCoordinatorRendererEvent[] = []
  const decisions = overrides.decisions ?? ['view', 'control']
  let scopeID = 0
  let leaseID = 0
  let consentEpoch = 0
  let now = Date.parse('2026-07-28T03:10:00.000Z')
  let reportID = 0
  let actionID = 0
  const reports = new AppDriveSessionReportStore({
    now: () => now,
    createReportId: () => `report-${++reportID}`,
    createActionId: () => `action-${++actionID}`
  })
  const coordinator = new NativeWindowCoordinator({
    instanceEpoch: 'instance-epoch-a',
    daemon,
    canScreenWatch: overrides.canScreenWatch ?? { available: true },
    canAppDrive: overrides.canAppDrive ?? { available: true },
    macosVersion: overrides.macosVersion ?? '15.2.1',
    getLaunchAttempts: () => attempts,
    isRunActive: (chatId, runId) => activeRuns.has(`${chatId}:${runId}`),
    getHostProtectedPids: () => protectedPids,
    requestSecondConsent: async (request) => {
      consentRequests.push(request)
      if (overrides.requestConsent) return overrides.requestConsent(request)
      return decisions.shift() ?? 'view'
    },
    frameEgressForProvider: (provider) => ({
      provider,
      mayLeaveDevice: true,
      disclosure: `Frames may be sent to ${provider}.`
    }),
    now: () => now,
    createScopeID: () => `scope-${++scopeID}`,
    createLeaseID: () => `lease-${++leaseID}`,
    createControlConsentEpoch: () => `control-consent-${++consentEpoch}`,
    controlLeaseTtlMs: 60_000,
    controlStepBudget: 2,
    pickerTimeoutMs: 90_000,
    appDriveReports: reports,
    notifyRenderer: (event) => rendererEvents.push(event),
    ...overrides
  })
  return {
    coordinator,
    daemon,
    attempts,
    activeRuns,
    protectedPids,
    consentRequests,
    rendererEvents,
    decisions,
    reports,
    advanceTime: (ms) => {
      now += ms
    }
  }
}

function queuePick(
  daemon: FakeDaemon,
  overrides: Partial<PickFixture> & {
    windowMeta?: Record<string, unknown>
  } = {}
): void {
  daemon.picks.push({
    handleID: overrides.handleID ?? 'handle-a',
    generation: overrides.generation ?? 7,
    windowMeta: overrides.windowMeta ?? windowMeta()
  })
}

function owner(
  overrides: Partial<Parameters<NativeWindowCoordinator['resolveLeaseForCanvas']>[0]> = {}
) {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    launchAttemptId: 'attempt-a',
    provider: 'codex',
    ...overrides
  }
}

describe('NativeWindowCoordinator', () => {
  it('fails before picker state or daemon work when Screen Watch is unavailable', async () => {
    const harness = createHarness({
      canScreenWatch: { available: false, reason: 'Screen recording permission is unavailable.' }
    })

    await expect(harness.coordinator.pick('chat-a')).rejects.toMatchObject({
      code: 'screen-watch-unavailable',
      message: 'Screen recording permission is unavailable.'
    })
    expect(harness.daemon.calls).toEqual([])
    expect(harness.coordinator.statusForChat('chat-a')).toEqual({
      pickerPending: false,
      observation: null,
      control: null
    })
  })

  it('keeps an arbitrary user-picked window as chat-scoped view-only observation', async () => {
    const harness = createHarness({ attempts: [] })
    queuePick(harness.daemon, {
      windowMeta: windowMeta({
        identityQuality: 'bestEffort',
        title: 'Unmanaged document'
      })
    })

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('view')
    expect(result.status).toMatchObject({
      pickerPending: false,
      observation: {
        chatId: 'chat-a',
        generation: 7,
        window: { title: 'Unmanaged document', identityQuality: 'bestEffort' }
      },
      control: null
    })
    expect(harness.consentRequests).toEqual([
      expect.objectContaining({
        kind: 'capture',
        chatId: 'chat-a',
        provider: 'providers participating in this chat',
        frameEgress: expect.objectContaining({
          mayLeaveDevice: true,
          disclosure: expect.stringContaining('chat “chat-a”')
        })
      })
    ])
    expect(harness.coordinator.getObservationForChat('chat-b')).toBeNull()
    expect(harness.coordinator.getObservationForChat('chat-a')?.handleID).toBe('handle-a')

    const pickCall = harness.daemon.calls[0]
    expect(pickCall).toEqual({
      method: 'attachedWindow.requestPick',
      params: {
        scopeID: 'scope-1',
        chatID: 'chat-a',
        consentEpoch: 0,
        protectedOwners: { pids: [900, 901], windowIDs: [] }
      },
      options: { timeoutMs: 90_000 }
    })
  })

  it('does not activate observation or expose capture access while capture consent is pending', async () => {
    let resolveCapture: ((decision: NativeWindowCoordinatorConsentDecision) => void) | undefined
    const harness = createHarness({
      requestConsent: async (request) => {
        if (request.kind !== 'capture') return 'view'
        return new Promise<NativeWindowCoordinatorConsentDecision>((resolve) => {
          resolveCapture = resolve
        })
      }
    })
    queuePick(harness.daemon)

    const pending = harness.coordinator.pick('chat-a')
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.consentRequests).toHaveLength(1)
    expect(harness.consentRequests[0]).toMatchObject({ kind: 'capture' })
    expect(harness.coordinator.getForChat('chat-a')).toBeNull()
    expect(harness.coordinator.statusForChat('chat-a')).toEqual({
      pickerPending: true,
      observation: null,
      control: null
    })

    if (!resolveCapture) throw new Error('Expected capture consent request.')
    resolveCapture('view')

    await expect(pending).resolves.toMatchObject({ outcome: 'view' })
    expect(harness.coordinator.getForChat('chat-a')).not.toBeNull()
  })

  it('names all active chat providers while using the conservative shared egress disclosure', async () => {
    const harness = createHarness({
      attempts: [
        attempt(),
        attempt({
          id: 'attempt-b',
          provider: 'claude',
          runId: 'run-b',
          pid: 102,
          pgid: 102
        })
      ]
    })
    queuePick(harness.daemon)

    await harness.coordinator.pick('chat-a')

    expect(harness.consentRequests[0]).toMatchObject({
      kind: 'capture',
      provider: 'codex, claude',
      frameEgress: {
        provider: 'codex, claude',
        mayLeaveDevice: true,
        disclosure: expect.stringContaining('participating provider')
      }
    })
  })

  it('fails closed and detaches the selected handle when capture consent is cancelled', async () => {
    const harness = createHarness({ decisions: ['cancel'] })
    queuePick(harness.daemon)

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('cancelled')
    expect(result.status.observation).toBeNull()
    expect(harness.consentRequests).toHaveLength(1)
    expect(harness.consentRequests[0]).toMatchObject({ kind: 'capture' })
    expect(
      harness.daemon.calls.find((call) => call.method === 'attachedWindow.detach')?.params
    ).toEqual({
      handleID: 'handle-a',
      scopeID: 'scope-1',
      chatID: 'chat-a',
      consentEpoch: 0,
      generation: 7
    })
  })

  it('collects capture consent before separate control consent and Accessibility trust', async () => {
    const harness = createHarness()
    queuePick(harness.daemon)

    const result = await harness.coordinator.pick('chat-a')
    const access = harness.coordinator.resolveLeaseForCanvas(owner(), 'inspect')

    expect(result.outcome).toBe('control')
    expect(result.status.control).toMatchObject({
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex',
      launchAttemptId: 'attempt-a',
      approvedBy: 'user',
      allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
      stepBudget: 2,
      stepsUsed: 0
    })
    expect(harness.consentRequests).toHaveLength(2)
    const [captureRequest, controlRequest] = harness.consentRequests
    expect(captureRequest).toMatchObject({
      kind: 'capture',
      chatId: 'chat-a',
      provider: 'codex',
      frameEgress: {
        provider: 'codex',
        mayLeaveDevice: true,
        disclosure: 'Frames may be sent to codex.'
      }
    })
    if (!controlRequest || controlRequest.kind === 'capture') {
      throw new Error('Expected a separate control consent request.')
    }
    expect(controlRequest).toMatchObject({
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex',
      frameEgress: {
        provider: 'codex',
        mayLeaveDevice: true,
        disclosure: 'Frames may be sent to codex.'
      },
      allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
      stepBudget: 2,
      expiresInMs: 60_000
    })
    expect(Object.isFrozen(harness.consentRequests[0])).toBe(true)
    expect(Object.isFrozen(harness.consentRequests[0].frameEgress)).toBe(true)
    expect(Object.isFrozen(controlRequest.allowedVerbs)).toBe(true)
    expect(
      harness.daemon.calls.find((call) => call.method === 'nativeWindow.requestAccessibility')
    ).toEqual({
      method: 'nativeWindow.requestAccessibility',
      params: {}
    })
    expect(access).toEqual({
      lease: {
        expectedPid: 101,
        ownership: 'exact',
        chatId: 'chat-a',
        runId: 'run-a',
        attemptId: 'attempt-a',
        pid: 101,
        windowId: 42,
        processStartedAt: 'procBSDInfo:1774843200123456',
        instanceEpoch: 'instance-epoch-a',
        consentEpoch: 'control-consent-1',
        generation: 7
      },
      attachment: {
        handleID: 'handle-a',
        scopeID: 'scope-1',
        chatID: 'chat-a',
        consentEpoch: 0,
        generation: 7
      },
      target: {
        pid: 101,
        windowID: 42,
        bundleID: 'com.example.target',
        processLaunchTimeMicros: 1_774_843_200_123_456,
        expectedBounds: { x: 120, y: 80, width: 1280, height: 720 }
      },
      protectedHostPIDs: [900, 901]
    })

    const driveAccess = harness.coordinator.consumeCanvasActionStep(owner(), 'click')
    expect(driveAccess.driveAction).toMatchObject({
      reportId: 'report-1',
      actionId: 'action-1',
      independentVerificationRequired: false
    })
    harness.coordinator.completeAppDriveAction(owner(), driveAccess.driveAction, {
      executed: true,
      surfaceVerification: 'unknown'
    })
    expect(harness.reports.query({ chatId: 'chat-a' })[0].counts.awaitingVerification).toBe(1)
    harness.coordinator.updateAppDriveSurfaceVerification(
      owner(),
      driveAccess.driveAction,
      'changed'
    )
    expect(harness.reports.query({ chatId: 'chat-a' })[0].counts.verified).toBe(1)
    expect(harness.coordinator.statusForChat('chat-a').control?.stepsUsed).toBe(1)
    expect(harness.coordinator.statusForChat('chat-a').control).toMatchObject({
      mode: 'foreground',
      lifecycle: 'active',
      canAdmitActions: true,
      virtualCursor: null
    })

    await harness.coordinator.controlSession('chat-a', 'pause')
    expect(harness.coordinator.statusForChat('chat-a').control).toMatchObject({
      lifecycle: 'paused',
      canAdmitActions: false
    })
    expect(() => harness.coordinator.consumeCanvasActionStep(owner(), 'click')).toThrow(
      /session is paused/
    )
    expect(harness.coordinator.statusForChat('chat-a').control?.stepsUsed).toBe(1)

    await harness.coordinator.controlSession('chat-a', 'resume')
    harness.coordinator.assertAppDriveActionAllowed(owner(), 'click')
    harness.coordinator.recordAppDriveActionTarget(owner(), {
      verb: 'click',
      x: 0.25,
      y: 0.75,
      label: 'Continue'
    })
    expect(harness.coordinator.statusForChat('chat-a').control?.virtualCursor).toEqual({
      verb: 'click',
      x: 0.25,
      y: 0.75,
      label: 'Continue'
    })

    await harness.coordinator.controlSession('chat-a', 'takeover')
    expect(harness.coordinator.statusForChat('chat-a').control?.virtualCursor).toBeNull()
    expect(() => harness.coordinator.assertAppDriveActionAllowed(owner(), 'fill')).toThrow(
      /taken over/
    )
    await harness.coordinator.controlSession('chat-a', 'stop')
    expect(harness.coordinator.statusForChat('chat-a').control).toBeNull()
    expect(harness.coordinator.statusForChat('chat-a').observation).not.toBeNull()
  })

  it('settles an in-flight native report after user stop revokes live authority', async () => {
    const harness = createHarness()
    queuePick(harness.daemon)
    await harness.coordinator.pick('chat-a')
    const access = harness.coordinator.consumeCanvasActionStep(owner(), 'fill')

    await harness.coordinator.controlSession('chat-a', 'stop')
    expect(() =>
      harness.coordinator.completeAppDriveAction(owner(), access.driveAction, {
        executed: null,
        surfaceVerification: 'unknown',
        refusalCode: 'native_dispatch_error'
      })
    ).not.toThrow()
    expect(harness.reports.query({ chatId: 'chat-a' })[0]).toMatchObject({
      status: 'ended',
      actions: [expect.objectContaining({ status: 'indeterminate' })]
    })
  })

  it('denies cross-chat and cross-run lease resolution', async () => {
    const harness = createHarness()
    queuePick(harness.daemon)
    await harness.coordinator.pick('chat-a')

    expect(() => harness.coordinator.resolveLeaseForCanvas(owner({ chatId: 'chat-b' }))).toThrow(
      NativeWindowCoordinatorError
    )
    expect(() => harness.coordinator.resolveLeaseForCanvas(owner({ runId: 'run-b' }))).toThrow(
      NativeWindowCoordinatorError
    )
    expect(() =>
      harness.coordinator.consumeCanvasActionStep(owner({ launchAttemptId: 'attempt-b' }), 'click')
    ).toThrow(NativeWindowCoordinatorError)
    expect(harness.coordinator.statusForChat('chat-a').control?.stepsUsed).toBe(0)
    expect(harness.coordinator.statusForChat('chat-b')).toEqual({
      pickerPending: false,
      observation: null,
      control: null
    })
  })

  it('does not adopt a same-process launch attempt owned by another chat', async () => {
    const harness = createHarness({
      attempts: [attempt({ chatId: 'chat-b', runId: 'run-b' })]
    })
    queuePick(harness.daemon)

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('view')
    expect(result.status.observation).not.toBeNull()
    expect(result.status.control).toBeNull()
    expect(harness.consentRequests).toHaveLength(1)
    expect(harness.consentRequests[0]).toMatchObject({ kind: 'capture' })
  })

  it('refuses a protected current-host PID without bundle-wide denial', async () => {
    const harness = createHarness({ protectedPids: [101, 900] })
    queuePick(harness.daemon, {
      windowMeta: windowMeta({
        title: 'TaskWraith host',
        bundleID: 'app.taskwraith'
      })
    })

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('view')
    expect(result.status.control).toBeNull()
    expect(result.warning).toContain('protected host process')
    expect(harness.consentRequests).toHaveLength(1)
    expect(harness.consentRequests[0]).toMatchObject({ kind: 'capture' })
  })

  it('rechecks the live protected-host PID set before exposing an attachment to capture tools', async () => {
    const harness = createHarness({ attempts: [] })
    queuePick(harness.daemon)
    await harness.coordinator.pick('chat-a')

    expect(harness.coordinator.getForChat('chat-a')).not.toBeNull()
    harness.protectedPids.push(101)

    expect(harness.coordinator.getForChat('chat-a')).toBeNull()
    expect(harness.coordinator.statusForChat('chat-a')).toMatchObject({
      observation: null,
      warning: expect.stringContaining('protected host process')
    })
    await Promise.resolve()
    expect(
      harness.daemon.calls.find((call) => call.method === 'attachedWindow.detach')?.params
    ).toEqual({
      handleID: 'handle-a',
      scopeID: 'scope-1',
      chatID: 'chat-a',
      consentEpoch: 0,
      generation: 7
    })
    const lastEvent = harness.rendererEvents.at(-1)
    expect(lastEvent).toMatchObject({
      chatId: 'chat-a',
      status: expect.objectContaining({ observation: null })
    })
    expect(JSON.stringify(lastEvent)).not.toContain('"pid"')
  })

  it('keeps a same-PGID child view-only because control requires the exact PID and birth receipt', async () => {
    const harness = createHarness({
      attempts: [attempt({ pid: 100, pgid: 100 })]
    })
    queuePick(harness.daemon, {
      windowMeta: windowMeta({ pid: 102, pgid: 100 })
    })

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('view')
    expect(result.status.control).toBeNull()
    expect(harness.coordinator.currentCanvasLeaseIdentity(owner())).toBeNull()
    // Silence here is what made this look like a broken feature: the user
    // attaches the window, nothing happens, and nothing says why.
    expect(result.warning).toBeTruthy()
  })

  describe('windows owned by a descendant of the launch process', () => {
    const LAUNCH_STARTED_AT = 'procBSDInfo:1774843200123456'
    const WINDOW_MICROS = 1_774_843_200_900_000
    const WINDOW_STARTED_AT = `procBSDInfo:${WINDOW_MICROS}`

    function descendantProof() {
      return {
        rootPid: 101,
        rootProcessStartedAt: LAUNCH_STARTED_AT,
        leafPid: 199,
        leafProcessStartedAt: WINDOW_STARTED_AT,
        depth: 2,
        chain: [
          { pid: 199, ppid: 150, processStartedAt: WINDOW_STARTED_AT },
          { pid: 150, ppid: 101, processStartedAt: 'procBSDInfo:1774843200500000' },
          { pid: 101, ppid: 1, processStartedAt: LAUNCH_STARTED_AT }
        ]
      }
    }

    function descendantHarness(
      resolveProcessAncestry: NativeWindowCoordinatorOptions['resolveProcessAncestry']
    ) {
      const harness = createHarness({ resolveProcessAncestry })
      queuePick(harness.daemon, {
        windowMeta: windowMeta({ pid: 199, processLaunchTimeMicros: WINDOW_MICROS })
      })
      return harness
    }

    it('grants control when the window process is proved to descend from the launch', async () => {
      // `npm run dev` records the npm PID; Electron paints from a grandchild.
      const harness = descendantHarness(async () => descendantProof())

      const result = await harness.coordinator.pick('chat-a')

      expect(result.outcome).toBe('control')
      expect(result.status.control).not.toBeNull()
      expect(harness.coordinator.currentCanvasLeaseIdentity(owner())).toMatchObject({
        pid: 199
      })
    })

    it('asks the resolver for the exact launch and window identities', async () => {
      const requests: unknown[] = []
      const harness = descendantHarness(async (request) => {
        requests.push(request)
        return descendantProof()
      })

      await harness.coordinator.pick('chat-a')

      expect(requests[0]).toMatchObject({
        leafPid: 199,
        leafProcessStartedAt: WINDOW_STARTED_AT,
        rootPid: 101,
        rootProcessStartedAt: LAUNCH_STARTED_AT
      })
    })

    it('stays view-only and says why when descent cannot be proved', async () => {
      const harness = descendantHarness(async () => null)

      const result = await harness.coordinator.pick('chat-a')

      expect(result.outcome).toBe('view')
      expect(result.status.control).toBeNull()
      expect(result.warning).toMatch(/descend/i)
    })

    it('stays view-only when the resolver itself fails', async () => {
      const harness = descendantHarness(async () => {
        throw new Error('daemon gone')
      })

      const result = await harness.coordinator.pick('chat-a')

      expect(result.outcome).toBe('view')
      expect(result.warning).toBeTruthy()
    })

    it('explains that no launch is running rather than failing silently', async () => {
      const harness = createHarness({ attempts: [] })
      queuePick(harness.daemon, { windowMeta: windowMeta({ pid: 199 }) })

      const result = await harness.coordinator.pick('chat-a')

      expect(result.outcome).toBe('view')
      expect(result.warning).toMatch(/no .*launch/i)
    })
  })

  it('keeps observation view-only on older macOS', async () => {
    const harness = createHarness({ macosVersion: '15.1.9' })
    queuePick(harness.daemon)

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('view')
    expect(result.status.observation).not.toBeNull()
    expect(result.status.control).toBeNull()
    expect(result.warning).toContain('macOS 15.2')
    expect(harness.consentRequests).toHaveLength(1)
    expect(harness.consentRequests[0]).toMatchObject({ kind: 'capture' })
  })

  it('never fakes a lease when Accessibility trust is denied', async () => {
    const harness = createHarness()
    harness.daemon.accessibilityTrusted = false
    queuePick(harness.daemon)

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('view')
    expect(result.status.observation).not.toBeNull()
    expect(result.status.control).toBeNull()
    expect(result.warning).toContain('Accessibility permission was not granted')
  })

  it('detaches the newly selected window when separate control consent is cancelled', async () => {
    const harness = createHarness({ decisions: ['view', 'cancel'] })
    queuePick(harness.daemon)

    const result = await harness.coordinator.pick('chat-a')

    expect(result.outcome).toBe('cancelled')
    expect(result.status.observation).toBeNull()
    expect(result.status.control).toBeNull()
    expect(
      harness.daemon.calls.find((call) => call.method === 'attachedWindow.detach')?.params
    ).toEqual({
      handleID: 'handle-a',
      scopeID: 'scope-1',
      chatID: 'chat-a',
      consentEpoch: 0,
      generation: 7
    })
  })

  it('atomically replaces observation and cleans the old full Swift scope', async () => {
    const harness = createHarness({ attempts: [] })
    queuePick(harness.daemon, { handleID: 'handle-a', generation: 7 })
    queuePick(harness.daemon, {
      handleID: 'handle-b',
      generation: 8,
      windowMeta: windowMeta({ windowID: 84, title: 'Replacement' })
    })

    await harness.coordinator.pick('chat-a')
    const result = await harness.coordinator.pick('chat-a')
    const detachCalls = harness.daemon.calls.filter(
      (call) => call.method === 'attachedWindow.detach'
    )

    expect(result.status.observation?.window.title).toBe('Replacement')
    expect(detachCalls).toEqual([
      {
        method: 'attachedWindow.detach',
        params: {
          handleID: 'handle-a',
          scopeID: 'scope-1',
          chatID: 'chat-a',
          consentEpoch: 0,
          generation: 7
        }
      }
    ])
  })

  it('makes a stale renderer detach harmless', async () => {
    const harness = createHarness({ attempts: [] })
    queuePick(harness.daemon, { handleID: 'handle-a', generation: 7 })
    queuePick(harness.daemon, { handleID: 'handle-b', generation: 8 })
    await harness.coordinator.pick('chat-a')
    await harness.coordinator.pick('chat-a')
    const callsBefore = harness.daemon.calls.length

    expect(await harness.coordinator.detach('chat-a', 7)).toBe(false)
    expect(harness.daemon.calls).toHaveLength(callsBefore)
    expect(await harness.coordinator.detach('chat-a', 8)).toBe(true)
    expect(harness.coordinator.statusForChat('chat-a').observation).toBeNull()
  })

  it('implements exact DesktopToolExecutors updates and local fail-closed clear', async () => {
    const harness = createHarness()
    queuePick(harness.daemon)
    await harness.coordinator.pick('chat-a')
    const original = harness.coordinator.getForChat('chat-a')
    if (!original) throw new Error('Expected an attachment.')
    const eventsBeforeUpdate = harness.rendererEvents.length

    const updated = harness.coordinator.updateStreaming(original, {
      fps: 2,
      bufferSeconds: 30,
      frameCount: 4,
      startedAt: '2026-07-28T03:11:00.000Z'
    })
    expect(updated?.streaming?.frameCount).toBe(4)
    expect(harness.coordinator.currentCanvasLeaseIdentity(owner())).not.toBeNull()
    expect(harness.coordinator.updateStreaming(original, null)).toBeNull()
    expect(harness.coordinator.clearExact(original)).toBeNull()

    const projection = harness.coordinator.rendererProjectionForChat('chat-a')
    expect(projection).toMatchObject({
      chatID: 'chat-a',
      generation: 7,
      streaming: { frameCount: 4 }
    })
    expect(projection).not.toHaveProperty('handleID')
    expect(projection?.windowMeta).not.toHaveProperty('pid')
    expect(projection?.windowMeta).not.toHaveProperty('processIdentity')
    expect(harness.rendererEvents.slice(eventsBeforeUpdate)).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        status: expect.objectContaining({
          observation: expect.objectContaining({
            streaming: expect.objectContaining({ frameCount: 4 })
          })
        })
      })
    ])

    if (!updated) throw new Error('Expected an updated attachment.')
    const rpcCount = harness.daemon.calls.length
    const eventsBeforeClear = harness.rendererEvents.length
    expect(harness.coordinator.clearExact(updated)).toBe(updated)
    expect(harness.coordinator.getForChat('chat-a')).toBeNull()
    expect(harness.coordinator.currentCanvasLeaseIdentity(owner())).toBeNull()
    expect(
      harness.daemon.calls.slice(rpcCount).some((call) => call.method === 'attachedWindow.detach')
    ).toBe(false)
    expect(harness.rendererEvents.slice(eventsBeforeClear)).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        status: expect.objectContaining({ observation: null, control: null })
      })
    ])
  })

  it('revokes control on run and launch terminal transitions while preserving observation', async () => {
    const harness = createHarness({ decisions: ['view', 'control', 'view', 'control'] })
    queuePick(harness.daemon)
    await harness.coordinator.pick('chat-a')

    expect(await harness.coordinator.onRunTerminal('chat-a', 'run-a')).toBe(true)
    expect(harness.coordinator.statusForChat('chat-a')).toMatchObject({
      observation: expect.any(Object),
      control: null
    })
    expect(
      harness.daemon.calls.find((call) => call.method === 'nativeWindow.release')?.params
    ).toEqual({
      handleID: 'handle-a',
      scopeID: 'scope-1',
      chatID: 'chat-a',
      consentEpoch: 0,
      generation: 7
    })

    queuePick(harness.daemon, { handleID: 'handle-b', generation: 8 })
    await harness.coordinator.pick('chat-a')
    harness.attempts[0] = attempt({ status: 'stopped' })
    expect(await harness.coordinator.onLaunchSnapshot(harness.attempts)).toBe(true)
    expect(harness.coordinator.statusForChat('chat-a').control).toBeNull()
    expect(harness.coordinator.statusForChat('chat-a').observation).not.toBeNull()
  })

  it('expires only control authority and releases the AX adoption', async () => {
    const harness = createHarness()
    queuePick(harness.daemon)
    await harness.coordinator.pick('chat-a')
    harness.advanceTime(60_001)

    expect(await harness.coordinator.sweepExpired()).toBe(true)
    expect(harness.coordinator.statusForChat('chat-a')).toMatchObject({
      observation: expect.any(Object),
      control: null
    })
    expect(harness.daemon.calls.some((call) => call.method === 'nativeWindow.release')).toBe(true)
  })

  it('clears both observation and control when the daemon is gone', async () => {
    const harness = createHarness()
    queuePick(harness.daemon)
    await harness.coordinator.pick('chat-a')
    harness.daemon.running = false

    await harness.coordinator.onDaemonGone()

    expect(harness.coordinator.statusForChat('chat-a')).toMatchObject({
      observation: null,
      control: null,
      warning: expect.stringContaining('native bridge stopped')
    })
  })

  it('omits every handle, scope, consent, process receipt, group, and bounds field from renderer status', async () => {
    const harness = createHarness()
    queuePick(harness.daemon, {
      handleID: 'private-handle',
      windowMeta: windowMeta({
        pgid: 45454,
        processStartedAt: 'procBSDInfo:1774843200123456',
        bounds: { x: 7654, y: 8765, width: 9876, height: 6789 }
      })
    })
    await harness.coordinator.pick('chat-a')

    const status = harness.coordinator.statusForChat('chat-a')
    const event = harness.rendererEvents.at(-1)
    const serialized = JSON.stringify(status)
    const serializedEvent = JSON.stringify(event)

    for (const privateField of [
      'handleID',
      'scopeID',
      'consentEpoch',
      'windowID',
      'leaseId',
      'processIdentity',
      'processStartedAt',
      'pid',
      'expectedPid',
      'selectedPid',
      'pgid',
      'bounds',
      'private-handle',
      'control-consent-1',
      'procBSDInfo'
    ]) {
      expect(serialized).not.toContain(privateField)
      expect(serializedEvent).not.toContain(privateField)
    }
    expect(Object.isFrozen(status)).toBe(true)
    expect(Object.isFrozen(status.observation)).toBe(true)
    expect(Object.isFrozen(status.control)).toBe(true)
  })
})
