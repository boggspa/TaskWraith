import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type {
  CanvasWindowActionTargetTelemetry,
  CanvasWindowClickAuthorization,
  CanvasWindowClickAuthorizationRequest,
  CanvasWindowClickRequest,
  CanvasWindowNativeBridge
} from './CanvasWindowDriver'
import {
  CanvasWindowDriverFactory,
  CanvasWindowDriverFactoryError,
  type CanvasWindowClickAuditClaim,
  type CanvasWindowClickAuditClaimRequest,
  type CanvasWindowClickConfirmation,
  type CanvasWindowCoordinatorPort,
  type CanvasWindowDriverFactoryDaemon
} from './CanvasWindowDriverFactory'
import type {
  NativeWindowCoordinatorCanvasAccess,
  NativeWindowCoordinatorCanvasLeaseIdentity,
  NativeWindowCoordinatorCanvasOwner
} from '../nativeWindow/NativeWindowCoordinator'

const OWNER: NativeWindowCoordinatorCanvasOwner = {
  chatId: 'chat-a',
  runId: 'run-a',
  launchAttemptId: 'attempt-a',
  provider: 'codex',
  participantId: null
}

const LEASE: NativeWindowCoordinatorCanvasLeaseIdentity = {
  chatId: OWNER.chatId,
  runId: OWNER.runId,
  attemptId: OWNER.launchAttemptId,
  pid: 4242,
  expectedPid: 4242,
  ownership: 'exact',
  windowId: 8181,
  processStartedAt: 'procBSDInfo:1774843200123456',
  instanceEpoch: 'instance-epoch-a',
  consentEpoch: 'control-consent-a',
  generation: 7
}

const ACCESS: NativeWindowCoordinatorCanvasAccess = {
  lease: LEASE,
  attachment: {
    handleID: 'private-handle-a',
    scopeID: 'private-scope-a',
    chatID: OWNER.chatId,
    consentEpoch: 3,
    generation: LEASE.generation
  },
  target: {
    pid: LEASE.pid,
    windowID: LEASE.windowId,
    bundleID: 'com.example.target',
    processLaunchTimeMicros: 1_774_843_200_123_456,
    expectedBounds: { x: 120, y: 80, width: 800, height: 600 }
  },
  protectedHostPIDs: [111, 222]
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

type DaemonCall = {
  method: string
  params: unknown
}

class FakeCoordinator implements CanvasWindowCoordinatorPort {
  current: NativeWindowCoordinatorCanvasLeaseIdentity | null = { ...LEASE }
  access: NativeWindowCoordinatorCanvasAccess = ACCESS
  readonly resolveCalls: Array<{ owner: NativeWindowCoordinatorCanvasOwner; verb: string }> = []
  readonly actionCalls: Array<{ owner: NativeWindowCoordinatorCanvasOwner; verb: string }> = []

  resolveLeaseForCanvas(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb: 'observe' | 'inspect' = 'observe'
  ): NativeWindowCoordinatorCanvasAccess {
    this.assertOwner(owner)
    this.resolveCalls.push({ owner, verb })
    if (!this.current) throw new Error('lease revoked')
    return { ...this.access, lease: this.current }
  }

  currentCanvasLeaseIdentity(
    owner: NativeWindowCoordinatorCanvasOwner
  ): NativeWindowCoordinatorCanvasLeaseIdentity | null {
    this.assertOwner(owner)
    return this.current ? { ...this.current } : null
  }

  consumeCanvasActionStep(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb: 'click' | 'fill'
  ): NativeWindowCoordinatorCanvasAccess {
    this.assertOwner(owner)
    this.actionCalls.push({ owner, verb })
    if (!this.current) throw new Error('lease revoked')
    return { ...this.access, lease: this.current }
  }
  assertAppDriveActionAllowed(
    owner: NativeWindowCoordinatorCanvasOwner,
    _verb: 'click' | 'fill'
  ): void {
    this.assertOwner(owner)
  }

  recordAppDriveActionTarget(
    owner: NativeWindowCoordinatorCanvasOwner,
    _target: CanvasWindowActionTargetTelemetry
  ): void {
    this.assertOwner(owner)
  }

  private assertOwner(owner: NativeWindowCoordinatorCanvasOwner): void {
    if (
      owner.chatId !== OWNER.chatId ||
      owner.runId !== OWNER.runId ||
      owner.launchAttemptId !== OWNER.launchAttemptId ||
      owner.provider !== OWNER.provider ||
      (owner.participantId ?? null) !== OWNER.participantId
    ) {
      throw new Error('wrong owner')
    }
  }
}

class FakeDaemon implements CanvasWindowDriverFactoryDaemon {
  readonly calls: DaemonCall[] = []
  readonly handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`No response configured for ${method}`)
    return (await handler(params)) as T
  }
}

function owner(
  overrides: Partial<NativeWindowCoordinatorCanvasOwner> = {}
): NativeWindowCoordinatorCanvasOwner {
  return { ...OWNER, ...overrides }
}

function attachmentEcho(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handleID: ACCESS.attachment.handleID,
    scopeID: ACCESS.attachment.scopeID,
    chatID: ACCESS.attachment.chatID,
    consentEpoch: ACCESS.attachment.consentEpoch,
    generation: ACCESS.attachment.generation,
    ...overrides
  }
}

function adoption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return attachmentEcho({
    pid: LEASE.pid,
    title: 'Target window',
    viewport: { width: 800, height: 600 },
    target: ACCESS.target,
    ...overrides
  })
}

function rawObservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return attachmentEcho({
    observationId: 'observation-a',
    inputEpoch: 5,
    snapshot: {
      snapshotID: 'observation-a',
      target: {
        pid: ACCESS.target.pid,
        windowID: ACCESS.target.windowID,
        bundleID: ACCESS.target.bundleID,
        processLaunchTimeMicros: ACCESS.target.processLaunchTimeMicros,
        expectedBounds: ACCESS.target.expectedBounds
      },
      createdAt: '2026-07-28T03:00:00.000Z',
      inputEpoch: 5,
      rootRef: 'root',
      nodes: [
        {
          ref: 'root',
          parentRef: null,
          childRefs: ['field'],
          role: 'AXWindow',
          subrole: null,
          title: 'Target window',
          label: null,
          identifier: null,
          value: 'must-not-leak',
          frame: ACCESS.target.expectedBounds,
          secure: false
        },
        {
          ref: 'field',
          parentRef: 'root',
          childRefs: [],
          role: 'AXTextField',
          subrole: null,
          title: null,
          label: 'Project title',
          identifier: 'project-title',
          value: 'must-not-leak',
          frame: { x: 160, y: 120, width: 320, height: 44 },
          secure: false
        }
      ],
      truncated: false
    },
    ...overrides
  })
}

function renderedObservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return attachmentEcho({
    observationId: 'observation-a',
    inputEpoch: 5,
    tree: {
      url: 'window://native',
      title: 'Target window',
      viewport: { width: 800, height: 600 },
      capturedAt: '2026-07-28T03:00:00.000Z',
      inputEpoch: 5,
      root: {
        ref: 'root',
        role: 'AXWindow',
        tag: 'AXWindow',
        value: 'must-not-leak',
        children: [
          {
            ref: 'field',
            role: 'AXTextField',
            tag: 'AXTextField',
            name: 'Project title',
            value: 'must-not-leak'
          }
        ]
      },
      nodeCount: 2,
      truncated: false
    },
    ...overrides
  })
}

function actionResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return attachmentEcho({
    observationId: 'observation-a',
    inputEpoch: 5,
    actionId: 'action-a',
    result: {
      ok: true,
      found: true,
      executed: true,
      refusalReason: undefined,
      message: 'daemon message must not reach Canvas'
    },
    ...overrides
  })
}

function captureResponse(): Record<string, unknown> {
  const png = Buffer.from(PNG_BASE64, 'base64')
  return attachmentEcho({
    captureSafety: { safe: true, target: ACCESS.target },
    frame: {
      mimeType: 'image/png',
      data: PNG_BASE64,
      width: 1,
      height: 1,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: '2026-07-28T03:00:01.000Z',
      secretsRedacted: 0
    }
  })
}

function setupDriver(
  daemon: FakeDaemon,
  coordinator = new FakeCoordinator(),
  options: {
    clickConfirmation?: CanvasWindowClickConfirmation | null
    clickAuditClaim?: CanvasWindowClickAuditClaim | null
    now?: () => number
    createClickReceipt?: () => string
    clickReceiptTtlMs?: number
  } = {}
) {
  let nextTarget = 0
  let nextReceipt = 0
  const clickConfirmation =
    options.clickConfirmation === undefined
      ? { confirm: async () => true }
      : options.clickConfirmation
  const clickAuditClaim =
    options.clickAuditClaim === undefined ? { claim: () => undefined } : options.clickAuditClaim
  const factory = new CanvasWindowDriverFactory({
    coordinator,
    daemon,
    createTargetId: () => `opaque-target-${++nextTarget}`,
    createClickReceipt:
      options.createClickReceipt ?? (() => `opaque-click-receipt-${++nextReceipt}`),
    ...(options.now ? { now: options.now } : {}),
    ...(options.clickReceiptTtlMs ? { clickReceiptTtlMs: options.clickReceiptTtlMs } : {}),
    ...(clickConfirmation ? { clickConfirmation } : {}),
    ...(clickAuditClaim ? { clickAuditClaim } : {})
  })
  const target = factory.issueOpenTarget(OWNER)
  return {
    coordinator,
    factory,
    driver: factory.takeDriver(OWNER, target),
    clickConfirmation,
    clickAuditClaim
  }
}

async function open(driver: ReturnType<CanvasWindowDriverFactory['takeDriver']>): Promise<void> {
  await driver.open({ driver: 'window' })
}

function errorCode(error: unknown): string | undefined {
  return error instanceof CanvasWindowDriverFactoryError ? error.code : undefined
}

type ClickDriverInternals = {
  readonly bridge: CanvasWindowNativeBridge
  readonly clickAuthorization: CanvasWindowClickAuthorization
}

function clickInternals(
  driver: ReturnType<CanvasWindowDriverFactory['takeDriver']>
): ClickDriverInternals {
  return driver as unknown as ClickDriverInternals
}

function clickAuthorizationRequest(
  overrides: Partial<CanvasWindowClickAuthorizationRequest> = {}
): CanvasWindowClickAuthorizationRequest {
  return {
    scope: {
      chatId: LEASE.chatId,
      runId: LEASE.runId,
      attemptId: LEASE.attemptId,
      consentEpoch: LEASE.consentEpoch,
      generation: LEASE.generation
    },
    observationId: 'observation-a',
    inputEpoch: 5,
    ref: 'field',
    semanticSummary: 'AXTextField — AXTextField — Project title',
    consequentialHint: false,
    ...overrides
  }
}

async function mintClickReceipt(
  driver: ReturnType<CanvasWindowDriverFactory['takeDriver']>,
  overrides: Partial<CanvasWindowClickAuthorizationRequest> = {}
): Promise<string> {
  const receipt = await clickInternals(driver).clickAuthorization.authorize(
    clickAuthorizationRequest(overrides)
  )
  if (!receipt) throw new Error('Expected a click receipt.')
  return receipt.receipt
}

describe('CanvasWindowDriverFactory', () => {
  it('issues no sensitive target data and consumes exact owner targets only once', () => {
    let now = 1_000
    const coordinator = new FakeCoordinator()
    const factory = new CanvasWindowDriverFactory({
      coordinator,
      daemon: new FakeDaemon(),
      now: () => now,
      createTargetId: () => 'opaque-target-a',
      targetTtlMs: 20
    })

    const target = factory.issueOpenTarget(OWNER)
    expect(target).toEqual({ leaseId: 'opaque-target-a' })
    expect(JSON.stringify(target)).not.toContain(ACCESS.attachment.handleID)
    expect(JSON.stringify(target)).not.toContain(LEASE.consentEpoch)

    expect(() => factory.takeDriver(owner({ chatId: 'chat-b' }), target)).toThrow(
      CanvasWindowDriverFactoryError
    )
    try {
      factory.takeDriver(owner({ chatId: 'chat-b' }), target)
    } catch (error) {
      expect(errorCode(error)).toBe('target-owner-mismatch')
    }
    expect(factory.pendingTargetCount()).toBe(1)

    const driver = factory.takeDriver(OWNER, target)
    expect(driver.kind).toBe('window')
    expect(factory.pendingTargetCount()).toBe(0)
    expect(() => factory.takeDriver(OWNER, target)).toThrow(CanvasWindowDriverFactoryError)

    const expiring = factory.issueOpenTarget(OWNER)
    now += 21
    try {
      factory.takeDriver(OWNER, expiring)
    } catch (error) {
      expect(errorCode(error)).toBe('target-expired')
    }
  })

  it('deletes a target before revalidation so a stale lease cannot be replayed', () => {
    const coordinator = new FakeCoordinator()
    const factory = new CanvasWindowDriverFactory({
      coordinator,
      daemon: new FakeDaemon(),
      createTargetId: () => 'opaque-target-a'
    })
    const target = factory.issueOpenTarget(OWNER)
    coordinator.current = { ...LEASE, runId: 'run-replaced' }

    expect(() => factory.takeDriver(OWNER, target)).toThrow(CanvasWindowDriverFactoryError)
    expect(factory.pendingTargetCount()).toBe(0)
    expect(() => factory.takeDriver(OWNER, target)).toThrow(CanvasWindowDriverFactoryError)
  })

  it('lets CanvasService consume only the chat/run bound inside the private target', () => {
    const factory = new CanvasWindowDriverFactory({
      coordinator: new FakeCoordinator(),
      daemon: new FakeDaemon(),
      createTargetId: () => 'opaque-target-a'
    })
    const target = factory.issueOpenTarget(OWNER)

    expect(() =>
      factory.takeDriverForCanvasContext({ chatId: 'chat-b', runId: OWNER.runId }, target)
    ).toThrow(CanvasWindowDriverFactoryError)
    expect(factory.pendingTargetCount()).toBe(1)

    expect(
      factory.takeDriverForCanvasContext({ chatId: OWNER.chatId, runId: OWNER.runId }, target).kind
    ).toBe('window')
    expect(factory.pendingTargetCount()).toBe(0)
  })

  it('refuses mismatched daemon lease, observation, and action echoes', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () =>
      adoption({ lease: { ...LEASE, runId: 'other' } })
    )
    daemon.handlers.set('nativeWindow.release', () => attachmentEcho({ released: true }))
    let harness = setupDriver(daemon)
    await expect(open(harness.driver)).rejects.toBeInstanceOf(CanvasWindowDriverFactoryError)

    const observedDaemon = new FakeDaemon()
    observedDaemon.handlers.set('nativeWindow.adopt', () => adoption())
    observedDaemon.handlers.set('nativeWindow.observe', () =>
      rawObservation({ lease: { ...LEASE, attemptId: 'other-attempt' } })
    )
    harness = setupDriver(observedDaemon)
    await open(harness.driver)
    await expect(harness.driver.observe()).rejects.toBeInstanceOf(CanvasWindowDriverFactoryError)

    const actionDaemon = new FakeDaemon()
    actionDaemon.handlers.set('nativeWindow.adopt', () => adoption())
    actionDaemon.handlers.set('nativeWindow.observe', () => rawObservation())
    actionDaemon.handlers.set('nativeWindow.click', () =>
      actionResponse({ observationId: 'other' })
    )
    harness = setupDriver(actionDaemon)
    await open(harness.driver)
    await harness.driver.observe()
    await expect(
      harness.driver.click({
        kind: 'click',
        ref: 'field',
        expectedObservationId: 'observation-a',
        expectedInputEpoch: 5
      })
    ).rejects.toBeInstanceOf(CanvasWindowDriverFactoryError)
    expect(harness.coordinator.actionCalls).toHaveLength(1)
  })

  it('rejects malformed and cyclic Codable AX graphs before they reach Canvas', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    const cyclic = rawObservation()
    const snapshot = cyclic.snapshot as Record<string, unknown>
    const nodes = snapshot.nodes as Array<Record<string, unknown>>
    nodes[1]!.childRefs = ['root']
    daemon.handlers.set('nativeWindow.observe', () => cyclic)
    const { driver } = setupDriver(daemon)
    await open(driver)

    await expect(driver.observe()).rejects.toMatchObject({ code: 'native-protocol' })
  })

  it('accepts the daemon rendered-tree wire shape while dropping all AX values', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.observe', () => renderedObservation())
    const { driver } = setupDriver(daemon)
    await open(driver)

    const tree = await driver.observe()
    expect(tree.root.tag).toBe('AXWindow')
    expect(JSON.stringify(tree)).not.toContain('must-not-leak')
  })

  it('preserves raw AX secure metadata so local fill and click refuse before bridge dispatch', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    const raw = rawObservation()
    const nodes = (raw.snapshot as Record<string, unknown>).nodes as Array<Record<string, unknown>>
    nodes[1]!.secure = true
    daemon.handlers.set('nativeWindow.observe', () => raw)
    const { driver } = setupDriver(daemon)
    await open(driver)

    const tree = await driver.observe()
    expect(tree.root.children?.[0]).toMatchObject({ ref: 'field', secure: true })

    const fill = await driver.fill({
      kind: 'fill',
      ref: 'field',
      value: 'must-not-cross-bridge',
      expectedObservationId: 'observation-a',
      expectedInputEpoch: 5
    })
    const click = await driver.click({
      kind: 'click',
      ref: 'field',
      expectedObservationId: 'observation-a',
      expectedInputEpoch: 5
    })
    expect(fill.refusalReason).toBe('secret_field')
    expect(click.refusalReason).toBe('secret_field')
    expect(daemon.calls.filter((call) => call.method === 'nativeWindow.fill')).toHaveLength(0)
    expect(daemon.calls.filter((call) => call.method === 'nativeWindow.click')).toHaveLength(0)
  })

  it('fails closed when factory wiring omits the native-click confirmation consumer', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.observe', () => rawObservation())
    const { driver } = setupDriver(daemon, new FakeCoordinator(), {
      clickConfirmation: null
    })
    await open(driver)
    await driver.observe()

    await expect(
      driver.click({
        kind: 'click',
        ref: 'field',
        expectedObservationId: 'observation-a',
        expectedInputEpoch: 5
      })
    ).resolves.toMatchObject({
      executed: false,
      refusalReason: 'consequential_confirmation_required'
    })
    expect(daemon.calls.filter((call) => call.method === 'nativeWindow.click')).toHaveLength(0)
  })

  it.each([
    ['lease replacement', { ...LEASE, generation: 8 }],
    ['lease expiry', null]
  ] as Array<[string, NativeWindowCoordinatorCanvasLeaseIdentity | null]>)(
    'mints no receipt when %s occurs during the confirmation modal',
    async (_label, nextLease) => {
      const daemon = new FakeDaemon()
      const coordinator = new FakeCoordinator()
      const auditClaims: CanvasWindowClickAuditClaimRequest[] = []
      let resolveConfirmation: ((confirmed: boolean) => void) | undefined
      const confirmation = new Promise<boolean>((resolve) => {
        resolveConfirmation = resolve
      })
      daemon.handlers.set('nativeWindow.adopt', () => adoption())
      daemon.handlers.set('nativeWindow.observe', () => rawObservation())
      daemon.handlers.set('nativeWindow.click', () => actionResponse())
      const { driver } = setupDriver(daemon, coordinator, {
        clickConfirmation: { confirm: () => confirmation },
        clickAuditClaim: { claim: (request) => auditClaims.push(request) }
      })
      await open(driver)
      await driver.observe()

      const click = driver.click({
        kind: 'click',
        ref: 'field',
        expectedObservationId: 'observation-a',
        expectedInputEpoch: 5
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(resolveConfirmation).toBeTypeOf('function')
      coordinator.current = nextLease
      resolveConfirmation!(true)

      await expect(click).resolves.toMatchObject({
        executed: false,
        refusalReason: 'consequential_confirmation_required'
      })
      expect(auditClaims).toHaveLength(0)
      expect(coordinator.actionCalls).toHaveLength(0)
      expect(daemon.calls.filter((call) => call.method === 'nativeWindow.click')).toHaveLength(0)
    }
  )

  it('keeps click confirmation safe, then claims its strict intent audit before the daemon RPC', async () => {
    const daemon = new FakeDaemon()
    const confirmations: CanvasWindowClickAuthorizationRequest[] = []
    const auditClaims: CanvasWindowClickAuditClaimRequest[] = []
    const dispatchOrder: string[] = []
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.observe', () => rawObservation())
    daemon.handlers.set('nativeWindow.click', () => {
      dispatchOrder.push('rpc')
      return actionResponse()
    })
    const { driver, coordinator } = setupDriver(daemon, new FakeCoordinator(), {
      clickConfirmation: {
        confirm: async (request) => {
          confirmations.push(request)
          return true
        }
      },
      clickAuditClaim: {
        claim: (request) => {
          dispatchOrder.push('audit')
          auditClaims.push(request)
        }
      },
      createClickReceipt: () => 'opaque-click-receipt-safe'
    })
    await open(driver)
    await driver.observe()

    await expect(
      driver.click({
        kind: 'click',
        ref: 'field',
        expectedObservationId: 'observation-a',
        expectedInputEpoch: 5
      })
    ).resolves.toMatchObject({ executed: true })

    expect(confirmations).toEqual([
      {
        scope: {
          chatId: OWNER.chatId,
          runId: OWNER.runId,
          attemptId: OWNER.launchAttemptId,
          consentEpoch: LEASE.consentEpoch,
          generation: LEASE.generation
        },
        observationId: 'observation-a',
        inputEpoch: 5,
        ref: 'field',
        semanticSummary: 'AXTextField — AXTextField — Project title',
        consequentialHint: false
      }
    ])
    const confirmation = confirmations[0]!
    expect(confirmation).not.toHaveProperty('lease')
    expect(confirmation).not.toHaveProperty('pid')
    expect(confirmation).not.toHaveProperty('windowId')
    expect(confirmation).not.toHaveProperty('processStartedAt')
    expect(confirmation).not.toHaveProperty('handleID')
    expect(JSON.stringify(confirmation)).not.toContain(ACCESS.attachment.handleID)

    expect(auditClaims).toEqual([
      expect.objectContaining({
        scope: confirmation.scope,
        ref: 'field',
        expectedObservationId: 'observation-a',
        inputEpoch: 5,
        previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ])
    expect(auditClaims[0]!).not.toHaveProperty('semanticSummary')
    expect(auditClaims[0]!).not.toHaveProperty('clickReceipt')
    expect(dispatchOrder).toEqual(['audit', 'rpc'])
    expect(coordinator.actionCalls).toEqual([{ owner: OWNER, verb: 'click' }])
    const daemonClick = daemon.calls.find((call) => call.method === 'nativeWindow.click')
    expect(daemonClick?.params).not.toHaveProperty('clickReceipt')
    expect(JSON.stringify(daemonClick?.params)).not.toContain('opaque-click-receipt-safe')
  })

  it.each([
    ['ref', { ref: 'other-field' }],
    ['observation', { observationId: 'other-observation' }],
    ['input epoch', { inputEpoch: 6 }],
    ['lease window', { lease: { ...LEASE, windowId: 9191 } }],
    ['lease generation', { lease: { ...LEASE, generation: 8 } }]
  ] as Array<[string, Partial<CanvasWindowClickRequest>]>)(
    'burns a receipt and performs no native action when its %s changes',
    async (_label, change) => {
      const daemon = new FakeDaemon()
      daemon.handlers.set('nativeWindow.adopt', () => adoption())
      daemon.handlers.set('nativeWindow.observe', () => rawObservation())
      daemon.handlers.set('nativeWindow.click', () => actionResponse())
      const { driver, coordinator } = setupDriver(daemon)
      await open(driver)
      await driver.observe()
      const receipt = await mintClickReceipt(driver)
      const bridge = clickInternals(driver).bridge
      const exactRequest: CanvasWindowClickRequest = {
        lease: LEASE,
        observationId: 'observation-a',
        inputEpoch: 5,
        ref: 'field',
        clickReceipt: receipt
      }

      await expect(bridge.click({ ...exactRequest, ...change })).rejects.toMatchObject({
        code: 'native-rpc-failed'
      })
      // A failed binding claim consumes the token too; an exact replay cannot
      // turn a rejected confirmation into a later action.
      await expect(bridge.click(exactRequest)).rejects.toMatchObject({
        code: 'native-rpc-failed'
      })
      expect(coordinator.actionCalls).toHaveLength(0)
      expect(daemon.calls.filter((call) => call.method === 'nativeWindow.click')).toHaveLength(0)
    }
  )

  it('accepts a receipt exactly once and never forwards it to the daemon', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.observe', () => rawObservation())
    daemon.handlers.set('nativeWindow.click', () => actionResponse())
    const { driver, coordinator } = setupDriver(daemon)
    await open(driver)
    await driver.observe()
    const receipt = await mintClickReceipt(driver)
    const request: CanvasWindowClickRequest = {
      lease: LEASE,
      observationId: 'observation-a',
      inputEpoch: 5,
      ref: 'field',
      clickReceipt: receipt
    }

    await expect(clickInternals(driver).bridge.click(request)).resolves.toMatchObject({
      actionId: 'action-a'
    })
    await expect(clickInternals(driver).bridge.click(request)).rejects.toMatchObject({
      code: 'native-rpc-failed'
    })
    expect(coordinator.actionCalls).toEqual([{ owner: OWNER, verb: 'click' }])
    const daemonClick = daemon.calls.find((call) => call.method === 'nativeWindow.click')
    expect(daemonClick?.params).not.toHaveProperty('clickReceipt')
    expect(JSON.stringify(daemonClick?.params)).not.toContain(receipt)
  })

  it('expires a click receipt before action budget or daemon dispatch', async () => {
    let now = 1_000
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.observe', () => rawObservation())
    daemon.handlers.set('nativeWindow.click', () => actionResponse())
    const { driver, coordinator } = setupDriver(daemon, new FakeCoordinator(), {
      now: () => now,
      clickReceiptTtlMs: 10
    })
    await open(driver)
    await driver.observe()
    const receipt = await mintClickReceipt(driver)
    now = 1_011

    await expect(
      clickInternals(driver).bridge.click({
        lease: LEASE,
        observationId: 'observation-a',
        inputEpoch: 5,
        ref: 'field',
        clickReceipt: receipt
      })
    ).rejects.toMatchObject({ code: 'native-rpc-failed' })
    expect(coordinator.actionCalls).toHaveLength(0)
    expect(daemon.calls.filter((call) => call.method === 'nativeWindow.click')).toHaveLength(0)
  })

  it('fails closed when the strict audit hook throws or returns a thenable', async () => {
    for (const clickAuditClaim of [
      {
        claim: () => {
          throw new Error('audit unavailable')
        }
      },
      {
        claim: (() => Promise.resolve()) as unknown as CanvasWindowClickAuditClaim['claim']
      }
    ]) {
      const daemon = new FakeDaemon()
      daemon.handlers.set('nativeWindow.adopt', () => adoption())
      daemon.handlers.set('nativeWindow.observe', () => rawObservation())
      daemon.handlers.set('nativeWindow.click', () => actionResponse())
      const { driver, coordinator } = setupDriver(daemon, new FakeCoordinator(), {
        clickAuditClaim
      })
      await open(driver)
      await driver.observe()

      await expect(
        driver.click({
          kind: 'click',
          ref: 'field',
          expectedObservationId: 'observation-a',
          expectedInputEpoch: 5
        })
      ).rejects.toMatchObject({ code: 'native-rpc-failed' })
      expect(coordinator.actionCalls).toHaveLength(0)
      expect(daemon.calls.filter((call) => call.method === 'nativeWindow.click')).toHaveLength(0)
    }
  })

  it('uses exactly one control step and one daemon call, with no retry or value leakage', async () => {
    const daemon = new FakeDaemon()
    const secret = 'do-not-log-this-fill-value'
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.observe', () => rawObservation())
    daemon.handlers.set('nativeWindow.fill', () => {
      throw new Error(`daemon received ${secret}`)
    })
    const { driver, coordinator } = setupDriver(daemon)
    await open(driver)
    const tree = await driver.observe()
    expect(JSON.stringify(tree)).not.toContain('must-not-leak')

    let received: unknown
    try {
      await driver.fill({
        kind: 'fill',
        ref: 'field',
        value: secret,
        expectedObservationId: 'observation-a',
        expectedInputEpoch: 5
      })
    } catch (error) {
      received = error
    }
    expect(String(received)).not.toContain(secret)
    expect(JSON.stringify(received)).not.toContain(secret)
    expect(coordinator.actionCalls).toEqual([{ owner: OWNER, verb: 'fill' }])
    expect(daemon.calls.filter((call) => call.method === 'nativeWindow.fill')).toHaveLength(1)
  })

  it('uses one secure-preflight-and-capture RPC and validates its PNG receipt', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.capture', () => captureResponse())
    const { driver } = setupDriver(daemon)
    await open(driver)

    const frame = await driver.screenshot()
    expect(frame.hash).toMatch(/^[a-f0-9]{64}$/)
    const adoptCall = daemon.calls.find((call) => call.method === 'nativeWindow.adopt')
    expect(adoptCall?.params).toMatchObject({
      ...ACCESS.attachment,
      protectedHostPIDs: ACCESS.protectedHostPIDs
    })
    expect(adoptCall?.params).not.toHaveProperty('target')
    expect(daemon.calls.filter((call) => call.method === 'nativeWindow.capture')).toHaveLength(1)
    expect(daemon.calls.filter((call) => call.method.includes('captureSafety'))).toHaveLength(0)
    const captureCall = daemon.calls.find((call) => call.method === 'nativeWindow.capture')
    expect(captureCall?.params).not.toHaveProperty('target')
  })

  it('drops daemon action messages rather than exposing potentially sensitive AX text', async () => {
    const daemon = new FakeDaemon()
    const sensitiveMessage = 'sensitive value from AX backend'
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    daemon.handlers.set('nativeWindow.observe', () => rawObservation())
    daemon.handlers.set('nativeWindow.click', () =>
      actionResponse({
        result: {
          ok: false,
          found: true,
          executed: false,
          refusalReason: 'not_fillable',
          message: sensitiveMessage
        }
      })
    )
    const { driver } = setupDriver(daemon)
    await open(driver)
    await driver.observe()

    const result = await driver.click({
      kind: 'click',
      ref: 'field',
      expectedObservationId: 'observation-a',
      expectedInputEpoch: 5
    })
    expect(result.message).not.toContain(sensitiveMessage)
    expect(JSON.stringify(result)).not.toContain(sensitiveMessage)
  })

  it('retries native release after a false daemon receipt instead of permanently masking cleanup', async () => {
    const daemon = new FakeDaemon()
    daemon.handlers.set('nativeWindow.adopt', () => adoption())
    let releaseAttempts = 0
    daemon.handlers.set('nativeWindow.release', () => {
      releaseAttempts += 1
      return attachmentEcho({ released: releaseAttempts > 1 })
    })
    const { driver } = setupDriver(daemon)
    await open(driver)

    await expect(driver.close()).rejects.toThrow(/did not confirm capability release/)
    await expect(driver.close()).resolves.toBeUndefined()
    expect(releaseAttempts).toBe(2)
  })
})
