import { describe, expect, it, vi } from 'vitest'
import {
  SIMULATOR_GESTURE_ACTUATION_DEFERRED,
  SIMULATOR_PREVIEW_ONLY_BANNER,
  SIMULATOR_VIEW_CONTROL_REQUIRED
} from '../../shared/simulatorCanvas'
import { SIMULATOR_CONTROL_DISABLED_MESSAGE } from '../../shared/simulatorControlSetup'
import { SimulatorInteractionBridge } from './SimulatorInteractionBridge'
import type { IdbClient } from './IdbClient'

function mockIdb(
  overrides: Partial<IdbClient> = {}
): Pick<IdbClient, 'isAvailable' | 'tap' | 'text' | 'swipe'> {
  return {
    isAvailable: () => true,
    tap: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    text: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    swipe: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    ...overrides
  }
}

describe('SimulatorInteractionBridge', () => {
  it('makes user input read-only while Simulator control is disabled', async () => {
    const idb = mockIdb()
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb,
      isSimulatorControlEnabled: () => false
    })

    expect(bridge.interactionStatus('chat-1')).toMatchObject({
      canControl: false,
      actuationReady: false,
      reason: SIMULATOR_CONTROL_DISABLED_MESSAGE,
      controllerLeaseHeld: false
    })
    await expect(bridge.tap({ chatId: 'chat-1', x: 0.5, y: 0.5 })).resolves.toEqual({
      ok: false,
      error: SIMULATOR_CONTROL_DISABLED_MESSAGE
    })
    expect(idb.tap).not.toHaveBeenCalled()
    expect(bridge.recordedGestures()).toEqual([])
  })

  it('reports preview-only when there is no Screen Watch attachment', () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: false, hasObservation: false })
    })
    expect(bridge.interactionStatus('chat-1')).toEqual({
      canControl: false,
      actuationReady: false,
      reason: SIMULATOR_PREVIEW_ONLY_BANNER,
      hasObservation: false,
      idbAvailable: false,
      controllerLeaseHeld: false
    })
  })

  it('requires View & Control when observation exists without a control lease', () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: false, hasObservation: true })
    })
    expect(bridge.interactionStatus('chat-1')).toEqual({
      canControl: false,
      actuationReady: false,
      reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
      hasObservation: true,
      idbAvailable: false,
      controllerLeaseHeld: false
    })
  })

  it('refuses tap/type/scroll without a control lease and does not record intent', async () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: false, hasObservation: true })
    })
    expect(await bridge.tap({ chatId: 'chat-1', x: 0.5, y: 0.5 })).toEqual({
      ok: false,
      error: SIMULATOR_VIEW_CONTROL_REQUIRED
    })
    expect(await bridge.type({ chatId: 'chat-1', text: 'hello' })).toEqual({
      ok: false,
      error: SIMULATOR_VIEW_CONTROL_REQUIRED
    })
    expect(
      await bridge.scroll({ chatId: 'chat-1', x: 0.5, y: 0.5, deltaX: 0, deltaY: -40 })
    ).toEqual({
      ok: false,
      error: SIMULATOR_VIEW_CONTROL_REQUIRED
    })
    expect(bridge.recordedGestures()).toEqual([])
  })

  it('records intent under a lease but stays deferred when idb is missing', async () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb: mockIdb({ isAvailable: () => false }),
      now: () => 1000
    })
    const status = bridge.interactionStatus('chat-1')
    expect(status.canControl).toBe(true)
    expect(status.actuationReady).toBe(false)
    expect(status.idbAvailable).toBe(false)
    expect(status.controllerLeaseHeld).toBe(true)
    expect(status.reason).toBe(SIMULATOR_GESTURE_ACTUATION_DEFERRED)

    const tap = await bridge.tap({ chatId: 'chat-1', x: 1.5, y: -0.2 })
    expect(tap).toEqual({
      ok: false,
      error: SIMULATOR_GESTURE_ACTUATION_DEFERRED,
      recorded: true
    })
    expect((await bridge.type({ chatId: 'chat-1', text: 'hi' })).recorded).toBe(true)
    expect(
      (await bridge.scroll({ chatId: 'chat-1', x: 0.25, y: 0.75, deltaX: 3, deltaY: -12 })).recorded
    ).toBe(true)

    expect(bridge.recordedGestures()).toEqual([
      {
        kind: 'tap',
        chatId: 'chat-1',
        at: 1000,
        payload: { chatId: 'chat-1', x: 1, y: 0 }
      },
      {
        kind: 'type',
        chatId: 'chat-1',
        at: 1000,
        payload: { chatId: 'chat-1', text: 'hi' }
      },
      {
        kind: 'scroll',
        chatId: 'chat-1',
        at: 1000,
        payload: { chatId: 'chat-1', x: 0.25, y: 0.75, deltaX: 3, deltaY: -12 }
      }
    ])
  })

  it('sets actuationReady only when idb is available AND controller lease is held', () => {
    const idb = mockIdb()
    const withLeaseNoIdb = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb: mockIdb({ isAvailable: () => false })
    })
    expect(withLeaseNoIdb.interactionStatus('chat-1').actuationReady).toBe(false)

    const withIdbNoLease = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => false,
      idb
    })
    expect(withIdbNoLease.interactionStatus('chat-1').actuationReady).toBe(false)

    const ready = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb
    })
    expect(ready.interactionStatus('chat-1')).toMatchObject({
      canControl: true,
      actuationReady: true,
      idbAvailable: true,
      controllerLeaseHeld: true
    })
  })

  it('forwards tap/type/scroll through mocked idb when actuationReady', async () => {
    const idb = mockIdb()
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb,
      getActuationTarget: () => ({
        udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        pointWidth: 390,
        pointHeight: 844,
        width: 780,
        height: 1688
      }),
      now: () => 42
    })

    expect(await bridge.tap({ chatId: 'chat-1', x: 0.5, y: 0.25 })).toEqual({
      ok: true,
      recorded: true
    })
    // Tap must use point extents (390×844), not raw PNG pixel dims (780×1688).
    expect(idb.tap).toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 195, 211)
    expect(idb.tap).not.toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 390, 422)

    expect(await bridge.type({ chatId: 'chat-1', text: 'hello' })).toEqual({
      ok: true,
      recorded: true
    })
    expect(idb.text).toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'hello')

    expect(
      await bridge.scroll({ chatId: 'chat-1', x: 0.5, y: 0.5, deltaX: 0, deltaY: -80 })
    ).toEqual({ ok: true, recorded: true })
    // Scroll deltas scale into point space (pixels→points ≈ 0.5): -80 → -40.
    expect(idb.swipe).toHaveBeenCalledWith(
      'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
      195,
      422,
      195,
      462
    )
  })

  it('tap rejects raw PNG pixel extents when only point dims are authoritative', async () => {
    const idb = mockIdb()
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb,
      getActuationTarget: () => ({
        udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        pointWidth: 390,
        pointHeight: 844,
        width: 1170,
        height: 2532
      })
    })
    await bridge.tap({ chatId: 'chat-1', x: 1, y: 1 })
    expect(idb.tap).toHaveBeenCalledWith('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 390, 844)
  })

  it('stays deferred when idb is ready but no session actuation target exists', async () => {
    const idb = mockIdb()
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb,
      getActuationTarget: () => null
    })
    expect(bridge.interactionStatus('chat-1').actuationReady).toBe(true)
    expect(await bridge.tap({ chatId: 'chat-1', x: 0.2, y: 0.3 })).toEqual({
      ok: false,
      error: SIMULATOR_GESTURE_ACTUATION_DEFERRED,
      recorded: true
    })
    expect(idb.tap).not.toHaveBeenCalled()
  })

  it('pre-warms the companion before tap/type/scroll and never blocks on pre-warm failure', async () => {
    const ensureConnected = vi.fn(async (udid: string) => {
      expect(udid).toBe('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
      throw new Error('companion cold')
    })
    const idb = { ...mockIdb(), ensureConnected }
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      hasControllerLease: () => true,
      idb,
      getActuationTarget: () => ({
        udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        pointWidth: 390,
        pointHeight: 844
      })
    })

    await expect(bridge.tap({ chatId: 'chat-1', x: 0.5, y: 0.5 })).resolves.toEqual({
      ok: true,
      recorded: true
    })
    await expect(bridge.type({ chatId: 'chat-1', text: 'hi' })).resolves.toEqual({
      ok: true,
      recorded: true
    })
    await expect(
      bridge.scroll({ chatId: 'chat-1', x: 0.5, y: 0.5, deltaX: 0, deltaY: -10 })
    ).resolves.toEqual({ ok: true, recorded: true })

    expect(ensureConnected).toHaveBeenCalledTimes(3)
    expect(idb.tap).toHaveBeenCalled()
    expect(idb.text).toHaveBeenCalled()
    expect(idb.swipe).toHaveBeenCalled()
  })
})
