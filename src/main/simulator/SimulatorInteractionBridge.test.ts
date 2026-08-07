import { describe, expect, it } from 'vitest'
import {
  SIMULATOR_GESTURE_ACTUATION_DEFERRED,
  SIMULATOR_PREVIEW_ONLY_BANNER,
  SIMULATOR_VIEW_CONTROL_REQUIRED
} from '../../shared/simulatorCanvas'
import { SimulatorInteractionBridge } from './SimulatorInteractionBridge'

describe('SimulatorInteractionBridge', () => {
  it('reports preview-only when there is no Screen Watch attachment', () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: false, hasObservation: false })
    })
    expect(bridge.interactionStatus('chat-1')).toEqual({
      canControl: false,
      reason: SIMULATOR_PREVIEW_ONLY_BANNER,
      hasObservation: false
    })
  })

  it('requires View & Control when observation exists without a control lease', () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: false, hasObservation: true })
    })
    expect(bridge.interactionStatus('chat-1')).toEqual({
      canControl: false,
      reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
      hasObservation: true
    })
  })

  it('refuses tap/type/scroll without a control lease and does not record intent', () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: false, hasObservation: true })
    })
    expect(bridge.tap({ chatId: 'chat-1', x: 0.5, y: 0.5 })).toEqual({
      ok: false,
      error: SIMULATOR_VIEW_CONTROL_REQUIRED
    })
    expect(bridge.type({ chatId: 'chat-1', text: 'hello' })).toEqual({
      ok: false,
      error: SIMULATOR_VIEW_CONTROL_REQUIRED
    })
    expect(bridge.scroll({ chatId: 'chat-1', x: 0.5, y: 0.5, deltaX: 0, deltaY: -40 })).toEqual({
      ok: false,
      error: SIMULATOR_VIEW_CONTROL_REQUIRED
    })
    expect(bridge.recordedGestures()).toEqual([])
  })

  it('records intent under a lease but does not claim desktop actuation', () => {
    const bridge = new SimulatorInteractionBridge({
      getControlStatus: () => ({ canControl: true, hasObservation: true }),
      now: () => 1000
    })
    expect(bridge.interactionStatus('chat-1').canControl).toBe(true)

    const tap = bridge.tap({ chatId: 'chat-1', x: 1.5, y: -0.2 })
    expect(tap).toEqual({
      ok: false,
      error: SIMULATOR_GESTURE_ACTUATION_DEFERRED,
      recorded: true
    })
    expect(bridge.type({ chatId: 'chat-1', text: 'hi' }).recorded).toBe(true)
    expect(
      bridge.scroll({ chatId: 'chat-1', x: 0.25, y: 0.75, deltaX: 3, deltaY: -12 }).recorded
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
})
