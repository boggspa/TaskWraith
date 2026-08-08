import { describe, expect, it } from 'vitest'
import {
  SIMULATOR_GESTURE_ACTUATION_DEFERRED,
  SIMULATOR_PREVIEW_ONLY_BANNER,
  SIMULATOR_VIEW_CONTROL_REQUIRED
} from '../../../shared/simulatorCanvas'
import {
  buildScrollGesture,
  buildTapGesture,
  buildTypeGesture,
  canSendSimulatorGestures,
  mapPointerToBezelNorm,
  previewOnlyBannerText,
  simulatorControllerBadgeText
} from './simulatorCanvasGestures'

describe('mapPointerToBezelNorm', () => {
  const bezel = { left: 100, top: 200, width: 200, height: 400 }

  it('maps the bezel origin to 0,0', () => {
    expect(mapPointerToBezelNorm(100, 200, bezel)).toEqual({ x: 0, y: 0 })
  })

  it('maps the bezel center to 0.5,0.5', () => {
    expect(mapPointerToBezelNorm(200, 400, bezel)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('clamps points outside the bezel', () => {
    expect(mapPointerToBezelNorm(50, 900, bezel)).toEqual({ x: 0, y: 1 })
    expect(mapPointerToBezelNorm(500, 100, bezel)).toEqual({ x: 1, y: 0 })
  })
})

describe('gesture gate helpers', () => {
  it('blocks sends without canControl and surfaces the preview banner', () => {
    expect(canSendSimulatorGestures(null)).toBe(false)
    expect(
      canSendSimulatorGestures({
        canControl: false,
        actuationReady: false,
        reason: SIMULATOR_PREVIEW_ONLY_BANNER,
        hasObservation: false
      })
    ).toBe(false)
    expect(
      previewOnlyBannerText({
        canControl: false,
        actuationReady: false,
        reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
        hasObservation: true
      })
    ).toBe(SIMULATOR_VIEW_CONTROL_REQUIRED)
  })

  it('keeps gestures disabled and shows deferred reason when canControl but actuation is not ready', () => {
    expect(
      canSendSimulatorGestures({
        canControl: true,
        actuationReady: false,
        reason: SIMULATOR_GESTURE_ACTUATION_DEFERRED,
        hasObservation: true
      })
    ).toBe(false)
    expect(
      previewOnlyBannerText({
        canControl: true,
        actuationReady: false,
        reason: SIMULATOR_GESTURE_ACTUATION_DEFERRED,
        hasObservation: true
      })
    ).toBe(SIMULATOR_GESTURE_ACTUATION_DEFERRED)
  })

  it('allows sends only when canControl and actuationReady are true and hides the banner', () => {
    expect(
      canSendSimulatorGestures({
        canControl: true,
        actuationReady: true,
        reason: '',
        hasObservation: true
      })
    ).toBe(true)
    expect(
      previewOnlyBannerText({
        canControl: true,
        actuationReady: true,
        reason: '',
        hasObservation: true
      })
    ).toBe('')
  })

  it('builds tap/type/scroll payloads for IPC', () => {
    expect(buildTapGesture('chat-1', { x: 0.25, y: 0.75 })).toEqual({
      chatId: 'chat-1',
      x: 0.25,
      y: 0.75
    })
    expect(buildTypeGesture('chat-1', 'hello')).toEqual({ chatId: 'chat-1', text: 'hello' })
    expect(buildScrollGesture('chat-1', { x: 0.5, y: 0.5 }, 2, -10)).toEqual({
      chatId: 'chat-1',
      x: 0.5,
      y: 0.5,
      deltaX: 2,
      deltaY: -10
    })
  })
})

describe('simulatorControllerBadgeText', () => {
  it('shows the agent chip when a run holds the controller lease', () => {
    expect(
      simulatorControllerBadgeText({
        controllerKind: 'run',
        controllerLeaseHeld: true
      })
    ).toBe('Agent is using this device')
  })

  it('shows the human chip when the dock holds control', () => {
    expect(
      simulatorControllerBadgeText({
        controllerKind: 'human',
        controllerLeaseHeld: true
      })
    ).toBe('You control this device')
    expect(
      simulatorControllerBadgeText({
        controllerKind: null,
        controllerLeaseHeld: true
      })
    ).toBe('You control this device')
  })

  it('hides the chip when no controller is held', () => {
    expect(simulatorControllerBadgeText(null)).toBeNull()
    expect(
      simulatorControllerBadgeText({
        controllerKind: null,
        controllerLeaseHeld: false
      })
    ).toBeNull()
  })
})
