import { describe, expect, it } from 'vitest'
import { SIMULATOR_PREVIEW_ONLY_BANNER, SIMULATOR_VIEW_CONTROL_REQUIRED } from '../../../shared/simulatorCanvas'
import {
  buildScrollGesture,
  buildTapGesture,
  buildTypeGesture,
  canSendSimulatorGestures,
  mapPointerToBezelNorm,
  previewOnlyBannerText
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
        reason: SIMULATOR_PREVIEW_ONLY_BANNER,
        hasObservation: false
      })
    ).toBe(false)
    expect(
      previewOnlyBannerText({
        canControl: false,
        reason: SIMULATOR_VIEW_CONTROL_REQUIRED,
        hasObservation: true
      })
    ).toBe(SIMULATOR_VIEW_CONTROL_REQUIRED)
  })

  it('allows sends only when canControl is true and hides the banner', () => {
    expect(
      canSendSimulatorGestures({
        canControl: true,
        reason: 'deferred',
        hasObservation: true
      })
    ).toBe(true)
    expect(
      previewOnlyBannerText({
        canControl: true,
        reason: 'deferred',
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
