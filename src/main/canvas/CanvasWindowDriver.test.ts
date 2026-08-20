import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasFrame } from './canvasTypes'
import {
  CanvasWindowDriver,
  CanvasWindowLeaseError,
  type CanvasWindowActionAdmission,
  type CanvasWindowActionTelemetry,
  type CanvasWindowActResult,
  type CanvasWindowClickAuthorization,
  type CanvasWindowLeaseIdentity,
  type CanvasWindowNativeBridge,
  type CanvasWindowObserveResult
} from './CanvasWindowDriver'

const LEASE: CanvasWindowLeaseIdentity = {
  chatId: 'chat-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  pid: 4242,
  windowId: 8181,
  processStartedAt: '2026-07-28T00:00:00.000Z',
  instanceEpoch: 'instance-epoch-1',
  consentEpoch: 'consent-epoch-1',
  generation: 7
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function captureFrame(overrides: Partial<CanvasFrame> = {}): CanvasFrame {
  const png = Buffer.from(PNG_BASE64, 'base64')
  return {
    mimeType: 'image/png',
    data: PNG_BASE64,
    width: 1,
    height: 1,
    byteLength: png.byteLength,
    hash: createHash('sha256').update(png).digest('hex'),
    capturedAt: '2026-07-28T00:00:01.000Z',
    secretsRedacted: 0,
    ...overrides
  }
}

function tree(
  inputEpoch = 3,
  target: Partial<{
    role: string
    tag: string
    name: string
    secure: boolean
    bbox: [number, number, number, number]
  }> = {}
) {
  return {
    url: 'native://must-not-escape',
    title: 'Example App',
    viewport: { width: 900, height: 700 },
    capturedAt: '2026-07-28T00:00:00.000Z',
    root: {
      ref: 'ax1',
      role: 'window',
      tag: 'AXWindow',
      children: [
        {
          ref: 'ax2',
          role: 'button',
          tag: 'AXButton',
          name: 'Continue',
          bbox: [10, 20, 100, 30] as [number, number, number, number],
          ...target
        }
      ]
    },
    nodeCount: 2,
    truncated: false,
    inputEpoch
  }
}

function observation(
  actionVerification?: CanvasWindowObserveResult['actionVerification']
): CanvasWindowObserveResult {
  return {
    lease: LEASE,
    observationId: 'observation-1',
    inputEpoch: 3,
    tree: tree(),
    ...(actionVerification ? { actionVerification } : {})
  }
}

function actionResult(overrides: Partial<CanvasWindowActResult> = {}): CanvasWindowActResult {
  return {
    lease: LEASE,
    observationId: 'observation-1',
    actionId: 'action-1',
    driveAction: {
      leaseId: 'drive-lease-1',
      reportId: 'drive-report-1',
      actionId: 'drive-action-1',
      independentVerificationRequired: false
    },
    result: {
      ok: true,
      found: true,
      executed: true
    },
    ...overrides
  }
}

function makeHarness(
  options: {
    clickAuthorization?: CanvasWindowClickAuthorization | null
    actionAdmission?: CanvasWindowActionAdmission
    actionTelemetry?: CanvasWindowActionTelemetry
  } = {}
) {
  let currentLease: CanvasWindowLeaseIdentity | null = { ...LEASE }
  const defaultClickAuthorization: CanvasWindowClickAuthorization = {
    authorize: vi.fn(async () => ({ receipt: 'test-click-receipt' }))
  }
  const clickAuthorization =
    options.clickAuthorization === undefined
      ? defaultClickAuthorization
      : options.clickAuthorization
  const bridge: CanvasWindowNativeBridge = {
    adopt: vi.fn(async (request) => ({
      lease: request.lease,
      pid: LEASE.pid,
      title: 'Example App',
      viewport: { width: 900, height: 700 }
    })),
    observe: vi.fn(async () => observation()),
    capture: vi.fn(async (request) => ({
      lease: request.lease,
      frame: captureFrame()
    })),
    inspect: vi.fn(async (request) => ({
      lease: request.lease,
      observationId: request.observationId,
      detail: {
        found: true,
        ref: request.ref,
        tag: 'AXButton',
        role: 'button',
        text: 'Continue',
        bbox: [10, 20, 100, 30] as [number, number, number, number]
      }
    })),
    click: vi.fn(async () => actionResult()),
    fill: vi.fn(async () => actionResult()),
    release: vi.fn(async (request) => ({
      lease: request.lease,
      released: true
    }))
  }
  const driver = new CanvasWindowDriver({
    lease: LEASE,
    authority: {
      current: () => currentLease
    },
    bridge,
    ...(options.actionAdmission ? { actionAdmission: options.actionAdmission } : {}),
    ...(options.actionTelemetry ? { actionTelemetry: options.actionTelemetry } : {}),
    ...(clickAuthorization ? { clickAuthorization } : {})
  })
  return {
    driver,
    bridge,
    clickAuthorization,
    setCurrentLease: (lease: CanvasWindowLeaseIdentity | null) => {
      currentLease = lease
    }
  }
}

async function openAndObserve(harness = makeHarness()): Promise<ReturnType<typeof makeHarness>> {
  await harness.driver.open({ driver: 'window' })
  await harness.driver.observe()
  return harness
}

describe('CanvasWindowDriver', () => {
  it('adopts only through the exact immutable run/attempt/process/consent binding', async () => {
    const { driver, bridge } = makeHarness()
    const opened = await driver.open({ driver: 'window' })

    expect(opened).toEqual({
      url: expect.stringMatching(/^window:\/\/managed\/[a-f0-9]{20}$/),
      title: 'Example App',
      viewport: { width: 900, height: 700 }
    })
    expect(bridge.adopt).toHaveBeenCalledTimes(1)
    const request = vi.mocked(bridge.adopt).mock.calls[0][0]
    expect(request.lease).toEqual(LEASE)
    expect(Object.isFrozen(request.lease)).toBe(true)
  })

  it('does not accept a generic Canvas open route', async () => {
    const { driver, bridge } = makeHarness()
    await expect(driver.open({ driver: 'web', url: 'http://localhost' })).rejects.toThrow(
      /main-owned window driver route/
    )
    expect(bridge.adopt).not.toHaveBeenCalled()
  })

  it.each<
    [keyof CanvasWindowLeaseIdentity, CanvasWindowLeaseIdentity[keyof CanvasWindowLeaseIdentity]]
  >([
    ['chatId', 'chat-2'],
    ['runId', 'run-2'],
    ['attemptId', 'attempt-2'],
    ['pid', 5252],
    ['windowId', 9191],
    ['processStartedAt', '2026-07-28T00:01:00.000Z'],
    ['instanceEpoch', 'instance-epoch-2'],
    ['consentEpoch', 'consent-epoch-2'],
    ['generation', 8]
  ])('fails before native adoption when live %s authority mismatches', async (field, value) => {
    const harness = makeHarness()
    harness.setCurrentLease({ ...LEASE, [field]: value })

    await expect(harness.driver.open({ driver: 'window' })).rejects.toBeInstanceOf(
      CanvasWindowLeaseError
    )
    expect(harness.bridge.adopt).not.toHaveBeenCalled()
  })

  it('releases a capability when the native adoption response is confused-deputy mismatched', async () => {
    const harness = makeHarness()
    vi.mocked(harness.bridge.adopt).mockResolvedValueOnce({
      lease: { ...LEASE, runId: 'other-run' },
      pid: LEASE.pid,
      title: 'Wrong',
      viewport: { width: 100, height: 100 }
    })

    await expect(harness.driver.open({ driver: 'window' })).rejects.toBeInstanceOf(
      CanvasWindowLeaseError
    )
    expect(harness.bridge.release).toHaveBeenCalledWith({ lease: LEASE })
  })

  it('releases the exact lease when native adoption has an indeterminate transport outcome', async () => {
    const harness = makeHarness()
    vi.mocked(harness.bridge.adopt).mockRejectedValueOnce(new Error('response lost'))

    await expect(harness.driver.open({ driver: 'window' })).rejects.toThrow(/response lost/)
    expect(harness.bridge.release).toHaveBeenCalledWith({ lease: LEASE })
  })

  it('returns structured observations with an explicit id and hides native URLs', async () => {
    const { driver, bridge } = makeHarness()
    const opened = await driver.open({ driver: 'window' })
    const observed = await driver.observe()

    expect(bridge.observe).toHaveBeenCalledWith({ lease: LEASE })
    expect(observed.observationId).toBe('observation-1')
    expect(observed.inputEpoch).toBe(3)
    expect(observed.url).toBe(opened.url)
    expect(observed.url).not.toContain('native://')
  })

  it('returns only a lease-echoed, content-validated PNG frame', async () => {
    const { driver, bridge } = makeHarness()
    await driver.open({ driver: 'window' })

    const frame = await driver.screenshot()

    expect(bridge.capture).toHaveBeenCalledWith({ lease: LEASE })
    expect(frame).toEqual(captureFrame())
    expect(frame.hash).toBe(
      createHash('sha256').update(Buffer.from(frame.data, 'base64')).digest('hex')
    )
  })

  it.each<[string, Partial<CanvasFrame>, RegExp]>([
    ['base64', { data: 'not-base64' }, /base64/],
    ['dimensions', { width: 2 }, /dimensions/],
    ['byte length', { byteLength: 1 }, /byteLength/],
    ['hash', { hash: '0'.repeat(64) }, /hash/],
    ['capture time', { capturedAt: 'July 28' }, /timestamp/]
  ])('refuses a captured PNG with invalid %s metadata', async (_label, overrides, message) => {
    const harness = makeHarness()
    await harness.driver.open({ driver: 'window' })
    vi.mocked(harness.bridge.capture).mockResolvedValueOnce({
      lease: LEASE,
      frame: captureFrame(overrides)
    })

    await expect(harness.driver.screenshot()).rejects.toThrow(message)
  })

  it('rejects a capture response from a substituted lease', async () => {
    const harness = makeHarness()
    await harness.driver.open({ driver: 'window' })
    vi.mocked(harness.bridge.capture).mockResolvedValueOnce({
      lease: { ...LEASE, windowId: LEASE.windowId + 1 },
      frame: captureFrame()
    })

    await expect(harness.driver.screenshot()).rejects.toBeInstanceOf(CanvasWindowLeaseError)
  })

  it('inspects AX refs only and binds the request to the current observation', async () => {
    const harness = await openAndObserve()
    const detail = await harness.driver.inspect({
      ref: 'ax2',
      expectedObservationId: 'observation-1'
    })

    expect(detail).toMatchObject({ found: true, ref: 'ax2', role: 'button' })
    expect(harness.bridge.inspect).toHaveBeenCalledWith({
      lease: LEASE,
      observationId: 'observation-1',
      inputEpoch: 3,
      ref: 'ax2'
    })

    await expect(
      harness.driver.inspect({ ref: 'ax2', expectedObservationId: 'old-observation' })
    ).rejects.toThrow(/not bound to the current observation/)
    await expect(
      harness.driver.inspect({
        selector: '#continue',
        expectedObservationId: 'observation-1'
      })
    ).rejects.toThrow(/ref/)
    expect(harness.bridge.inspect).toHaveBeenCalledTimes(1)
  })

  it('requires observation id + input epoch and refuses selector/pixel fallbacks', async () => {
    const harness = await openAndObserve()
    const base = {
      kind: 'click' as const,
      ref: 'ax2',
      expectedInputEpoch: 3
    }

    await expect(harness.driver.click(base)).rejects.toThrow(/not bound to the current observation/)
    await expect(
      harness.driver.click({
        ...base,
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 2
      })
    ).rejects.toThrow(/exact inputEpoch/)
    await expect(
      harness.driver.click({
        ...base,
        ref: undefined,
        selector: '#continue',
        expectedObservationId: 'observation-1'
      })
    ).rejects.toThrow(/ref/)
    await expect(
      harness.driver.click({
        ...base,
        x: 10,
        y: 20,
        expectedObservationId: 'observation-1'
      })
    ).rejects.toThrow(/pixel coordinates are refused/)
    expect(harness.bridge.click).not.toHaveBeenCalled()
  })

  it('refuses a paused App Drive session before authorization or native dispatch', async () => {
    const assertCanAdmit = vi.fn(() => {
      throw new Error('Foreground Drive session is paused')
    })
    const harness = await openAndObserve(makeHarness({ actionAdmission: { assertCanAdmit } }))
    await expect(
      harness.driver.click({
        kind: 'click',
        ref: 'ax2',
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })
    ).rejects.toThrow(/session is paused/)
    expect(assertCanAdmit).toHaveBeenCalledWith('click')
    expect(harness.clickAuthorization?.authorize).not.toHaveBeenCalled()
    expect(harness.bridge.click).not.toHaveBeenCalled()
  })

  it('projects only a normalized display target before native dispatch', async () => {
    const recordTarget = vi.fn()
    const harness = await openAndObserve(makeHarness({ actionTelemetry: { recordTarget } }))
    await harness.driver.click({
      kind: 'click',
      ref: 'ax2',
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    })
    expect(recordTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: 'click',
        x: 60 / 900,
        y: 35 / 700
      })
    )
  })

  it('reports dispatch honestly but never calls it verified until a matching re-observe', async () => {
    const harness = await openAndObserve()
    const action = {
      kind: 'click' as const,
      ref: 'ax2',
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    }

    const result = await harness.driver.click(action)
    expect(result).toMatchObject({
      ok: true,
      found: true,
      executed: true,
      verified: 'unknown',
      ref: 'ax2'
    })
    expect(result.message).toMatch(/Re-observe/)
    expect(harness.bridge.click).toHaveBeenCalledWith({
      lease: LEASE,
      observationId: 'observation-1',
      inputEpoch: 3,
      ref: 'ax2',
      clickReceipt: 'test-click-receipt'
    })

    await expect(harness.driver.click(action)).rejects.toThrow(/Re-observe/)
    expect(harness.bridge.click).toHaveBeenCalledTimes(1)

    vi.mocked(harness.bridge.observe).mockResolvedValueOnce(
      observation({ actionId: 'action-1', verified: 'changed' })
    )
    const verified = await harness.driver.observe()
    expect(verified.lastActionVerification).toEqual({
      actionId: 'action-1',
      verified: 'changed'
    })

    vi.mocked(harness.bridge.click).mockResolvedValueOnce(actionResult({ actionId: 'action-2' }))
    await expect(harness.driver.click(action)).resolves.toMatchObject({
      executed: true,
      verified: 'unknown'
    })
  })

  it.each([
    'Delete',
    'Remove',
    'Send',
    'Publish',
    'Transfer',
    'Pay',
    'Payment',
    'Purchase',
    'Approve',
    'Authorize',
    'Checkout',
    'Cancel Subscription',
    'Account Security'
  ])(
    'passes %s wording as an advisory hint to the content-bound click authorization',
    async (name) => {
      const authorize = vi.fn(async () => null)
      const harness = makeHarness({ clickAuthorization: { authorize } })
      vi.mocked(harness.bridge.observe).mockResolvedValueOnce({
        ...observation(),
        tree: tree(3, { name: `${name} item` })
      })
      await openAndObserve(harness)

      const result = await harness.driver.click({
        kind: 'click',
        ref: 'ax2',
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })

      expect(result).toMatchObject({
        ok: false,
        found: true,
        executed: false,
        verified: 'unknown',
        refusalReason: 'consequential_confirmation_required'
      })
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: {
            chatId: LEASE.chatId,
            runId: LEASE.runId,
            attemptId: LEASE.attemptId,
            consentEpoch: LEASE.consentEpoch,
            generation: LEASE.generation
          },
          observationId: 'observation-1',
          inputEpoch: 3,
          ref: 'ax2',
          consequentialHint: true,
          semanticSummary: expect.stringContaining(name)
        })
      )
      expect(harness.bridge.click).not.toHaveBeenCalled()
    }
  )

  it('requires an injected one-use authorization for every native click', async () => {
    const harness = makeHarness({ clickAuthorization: null })
    await openAndObserve(harness)

    await expect(
      harness.driver.click({
        kind: 'click',
        ref: 'ax2',
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })
    ).resolves.toMatchObject({
      executed: false,
      refusalReason: 'consequential_confirmation_required'
    })
    expect(harness.bridge.click).not.toHaveBeenCalled()
  })

  it('binds the one-use authorization to the exact observed target before dispatch', async () => {
    const authorize = vi.fn<CanvasWindowClickAuthorization['authorize']>(async () => ({
      receipt: 'opaque-click-receipt'
    }))
    const harness = makeHarness({ clickAuthorization: { authorize } })
    vi.mocked(harness.bridge.observe).mockResolvedValueOnce({
      ...observation(),
      tree: tree(3, { role: 'AXConfirmButton', name: 'Continue' })
    })
    await openAndObserve(harness)

    await expect(
      harness.driver.click({
        kind: 'click',
        ref: 'ax2',
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })
    ).resolves.toMatchObject({
      executed: true,
      verified: 'unknown'
    })
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          chatId: LEASE.chatId,
          runId: LEASE.runId,
          attemptId: LEASE.attemptId,
          consentEpoch: LEASE.consentEpoch,
          generation: LEASE.generation
        },
        observationId: 'observation-1',
        inputEpoch: 3,
        ref: 'ax2',
        consequentialHint: true,
        semanticSummary: 'AXConfirmButton — AXButton — Continue'
      })
    )
    const authorizationRequest = vi.mocked(authorize).mock.calls[0]![0]
    expect(authorizationRequest).not.toHaveProperty('lease')
    expect(authorizationRequest).not.toHaveProperty('target')
    expect(authorizationRequest).not.toHaveProperty('pid')
    expect(authorizationRequest).not.toHaveProperty('windowId')
    expect(harness.bridge.click).toHaveBeenCalledWith(
      expect.objectContaining({ clickReceipt: 'opaque-click-receipt' })
    )
  })

  it('keeps the action gate closed when post-action observation verifies another action', async () => {
    const harness = await openAndObserve()
    const action = {
      kind: 'click' as const,
      ref: 'ax2',
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    }
    await harness.driver.click(action)
    vi.mocked(harness.bridge.observe)
      .mockResolvedValueOnce(observation({ actionId: 'different-action', verified: 'changed' }))
      .mockResolvedValueOnce(observation({ actionId: 'action-1', verified: 'unchanged' }))

    await expect(harness.driver.observe()).rejects.toThrow(/did not verify/)
    await expect(harness.driver.click(action)).rejects.toThrow(/Re-observe/)
    await expect(harness.driver.observe()).resolves.toMatchObject({
      lastActionVerification: {
        actionId: 'action-1',
        verified: 'unchanged'
      }
    })
  })

  it('passes fill text only to the native bridge and keeps it out of the result', async () => {
    const harness = makeHarness()
    vi.mocked(harness.bridge.observe).mockResolvedValueOnce({
      ...observation(),
      tree: tree(3, { role: 'AXTextField', tag: 'AXTextField', name: 'Project title' })
    })
    await openAndObserve(harness)
    const value = 'ordinary private form data'
    const result = await harness.driver.fill({
      kind: 'fill',
      ref: 'ax2',
      value,
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    })

    expect(harness.bridge.fill).toHaveBeenCalledWith({
      lease: LEASE,
      observationId: 'observation-1',
      inputEpoch: 3,
      ref: 'ax2',
      value
    })
    expect(JSON.stringify(result)).not.toContain(value)
    expect(result.verified).toBe('unknown')
  })

  it('refuses fill for a non-secure target that is not a standard text control', async () => {
    const harness = await openAndObserve()
    const value = 'must-not-cross-non-text-control'

    await expect(
      harness.driver.fill({
        kind: 'fill',
        ref: 'ax2',
        value,
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })
    ).resolves.toMatchObject({
      executed: false,
      refusalReason: 'not_fillable'
    })
    expect(harness.bridge.fill).not.toHaveBeenCalled()
  })

  it('refuses an observed secure field without passing its value to the bridge', async () => {
    const harness = makeHarness()
    vi.mocked(harness.bridge.observe).mockResolvedValueOnce({
      ...observation(),
      tree: tree(3, { role: 'AXSecureTextField', tag: 'AXSecureTextField', name: 'Password' })
    })
    await openAndObserve(harness)
    const value = 'must-not-cross-native-boundary'

    const result = await harness.driver.fill({
      kind: 'fill',
      ref: 'ax2',
      value,
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    })

    expect(result).toMatchObject({
      ok: false,
      found: true,
      executed: false,
      refusalReason: 'secret_field'
    })
    expect(result.message).toMatch(/Do not retry or work around/)
    expect(JSON.stringify(result)).not.toContain(value)
    expect(harness.bridge.fill).not.toHaveBeenCalled()
  })

  it('uses raw secure metadata to refuse both native fill and click before bridge dispatch', async () => {
    const harness = makeHarness()
    vi.mocked(harness.bridge.observe).mockResolvedValueOnce({
      ...observation(),
      tree: tree(3, {
        role: 'AXTextField',
        tag: 'AXTextField',
        name: 'Sign-in field',
        secure: true
      })
    })
    await openAndObserve(harness)

    const fill = await harness.driver.fill({
      kind: 'fill',
      ref: 'ax2',
      value: 'must-not-cross-native-boundary',
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    })
    const click = await harness.driver.click({
      kind: 'click',
      ref: 'ax2',
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    })

    expect(fill.refusalReason).toBe('secret_field')
    expect(click.refusalReason).toBe('secret_field')
    expect(harness.bridge.fill).not.toHaveBeenCalled()
    expect(harness.bridge.click).not.toHaveBeenCalled()
  })

  it('treats a native secure-field refusal as terminal and suppresses native message content', async () => {
    const harness = makeHarness()
    vi.mocked(harness.bridge.observe).mockResolvedValueOnce({
      ...observation(),
      tree: tree(3, { role: 'AXTextField', tag: 'AXTextField', name: 'Project title' })
    })
    await openAndObserve(harness)
    const value = 'private-value-never-returned'
    vi.mocked(harness.bridge.fill).mockResolvedValueOnce(
      actionResult({
        result: {
          ok: false,
          found: true,
          executed: false,
          refusalReason: 'secret_field',
          message: `native accidentally echoed ${value}`
        }
      })
    )

    const result = await harness.driver.fill({
      kind: 'fill',
      ref: 'ax2',
      value,
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    })

    expect(result).toMatchObject({
      ok: false,
      executed: false,
      refusalReason: 'secret_field'
    })
    expect(result.message).toMatch(/terminal/)
    expect(JSON.stringify(result)).not.toContain(value)

    vi.mocked(harness.bridge.observe).mockResolvedValueOnce(
      observation({ actionId: 'action-1', verified: 'unchanged' })
    )
    await harness.driver.observe()
    await expect(
      harness.driver.fill({
        kind: 'fill',
        ref: 'ax2',
        value: 'second-attempt',
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })
    ).resolves.toMatchObject({
      executed: false,
      refusalReason: 'secret_field'
    })
    expect(harness.bridge.fill).toHaveBeenCalledTimes(1)
  })

  it('suppresses fill text from bridge exceptions', async () => {
    const harness = makeHarness()
    vi.mocked(harness.bridge.observe).mockResolvedValueOnce({
      ...observation(),
      tree: tree(3, { role: 'AXTextField', tag: 'AXTextField', name: 'Project title' })
    })
    await openAndObserve(harness)
    const value = 'private-value-in-error'
    vi.mocked(harness.bridge.fill).mockRejectedValueOnce(new Error(`bridge echoed ${value}`))

    let caught: unknown
    try {
      await harness.driver.fill({
        kind: 'fill',
        ref: 'ax2',
        value,
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).toMatch(/indeterminate outcome/)
    expect(String(caught)).not.toContain(value)
  })

  it('fails closed on lease revocation before every native operation', async () => {
    const harness = await openAndObserve()
    harness.setCurrentLease(null)

    await expect(
      harness.driver.inspect({
        ref: 'ax2',
        expectedObservationId: 'observation-1'
      })
    ).rejects.toBeInstanceOf(CanvasWindowLeaseError)
    expect(harness.bridge.inspect).not.toHaveBeenCalled()
  })

  it('invalidates the observation after an indeterminate native action failure', async () => {
    const harness = await openAndObserve()
    vi.mocked(harness.bridge.click).mockRejectedValueOnce(new Error('bridge pipe closed'))
    const action = {
      kind: 'click' as const,
      ref: 'ax2',
      expectedObservationId: 'observation-1',
      expectedInputEpoch: 3
    }

    await expect(harness.driver.click(action)).rejects.toThrow(/bridge pipe closed/)
    await expect(harness.driver.click(action)).rejects.toThrow(/close and re-adopt/)
    await expect(harness.driver.observe()).rejects.toThrow(/close and re-adopt/)
    expect(harness.bridge.observe).toHaveBeenCalledTimes(1)
  })

  it('fails honest when native says ok without dispatch', async () => {
    const harness = await openAndObserve()
    vi.mocked(harness.bridge.click).mockResolvedValueOnce(
      actionResult({
        result: {
          ok: true,
          found: true,
          executed: false,
          refusalReason: 'stale_target'
        }
      })
    )

    await expect(
      harness.driver.click({
        kind: 'click',
        ref: 'ax2',
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 3
      })
    ).resolves.toMatchObject({
      ok: false,
      found: true,
      executed: false,
      refusalReason: 'stale_target',
      verified: 'unknown'
    })
  })

  it('keeps all other Canvas capabilities fail-closed', async () => {
    const { driver } = makeHarness()
    await driver.open({ driver: 'window' })

    await expect(driver.network()).rejects.toThrow(/screenshot\/observe\/inspect\/click\/fill only/)
    await expect(driver.console()).rejects.toThrow(/screenshot\/observe\/inspect\/click\/fill only/)
    await expect(driver.resize({ width: 100, height: 100 })).rejects.toThrow(
      /screenshot\/observe\/inspect\/click\/fill only/
    )
    await expect(driver.annotate([])).rejects.toThrow(
      /screenshot\/observe\/inspect\/click\/fill only/
    )
    await expect(driver.sketchDocument()).rejects.toThrow(
      /screenshot\/observe\/inspect\/click\/fill only/
    )
    await expect(driver.sketchUpdate({} as never)).rejects.toThrow(
      /screenshot\/observe\/inspect\/click\/fill only/
    )
    await expect(driver.evaluate({ script: '1 + 1' })).rejects.toThrow(
      /screenshot\/observe\/inspect\/click\/fill only/
    )
    await expect(driver.reload()).rejects.toThrow(/screenshot\/observe\/inspect\/click\/fill only/)
  })

  it('returns a typed refusal for richer verbs that native Foreground Drive does not ship', async () => {
    const { driver, bridge } = makeHarness()
    await driver.open({ driver: 'window' })
    await expect(driver.act({ kind: 'key', ref: 'ax2', key: 'Enter' })).resolves.toMatchObject({
      ok: false,
      action: 'key',
      executed: false,
      refusalReason: 'unsupported_action'
    })
    expect(bridge.click).not.toHaveBeenCalled()
    expect(bridge.fill).not.toHaveBeenCalled()
  })

  it('releases the exact adopted capability once on close', async () => {
    const { driver, bridge, setCurrentLease } = makeHarness()
    await driver.open({ driver: 'window' })
    // Release must remain possible after the authority is revoked; it names the
    // old exact identity and cannot release a replacement generation.
    setCurrentLease(null)

    await driver.close()
    await driver.close()
    expect(bridge.release).toHaveBeenCalledTimes(1)
    expect(bridge.release).toHaveBeenCalledWith({ lease: LEASE })
  })

  it('fails close on an unconfirmed release and retries the exact lease once asked again', async () => {
    const { driver, bridge } = makeHarness()
    await driver.open({ driver: 'window' })
    vi.mocked(bridge.release)
      .mockResolvedValueOnce({ lease: LEASE, released: false })
      .mockResolvedValueOnce({ lease: LEASE, released: true })

    await expect(driver.close()).rejects.toThrow(/did not confirm capability release/)
    expect(bridge.release).toHaveBeenCalledTimes(1)

    await expect(driver.close()).resolves.toBeUndefined()
    expect(bridge.release).toHaveBeenCalledTimes(2)
    expect(bridge.release).toHaveBeenLastCalledWith({ lease: LEASE })
  })
})
