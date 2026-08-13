import { describe, expect, it } from 'vitest'
import {
  consumeSimulatorCanvasOpenRequest,
  getPendingSimulatorCanvasOpenRequest,
  isSimulatorCanvasPresentationEvent,
  requestSimulatorCanvasOpen,
  subscribeSimulatorCanvasOpenRequests
} from './simulatorCanvasLaunch'

describe('simulatorCanvasLaunch', () => {
  it('keeps a chat-owned request until the Simulator Canvas dock consumes it', () => {
    const notifications: number[] = []
    const unsubscribe = subscribeSimulatorCanvasOpenRequests(() => notifications.push(1))
    requestSimulatorCanvasOpen('chat-simulator')
    const request = getPendingSimulatorCanvasOpenRequest()

    expect(request).toMatchObject({ chatId: 'chat-simulator' })
    consumeSimulatorCanvasOpenRequest(request!.id)
    expect(getPendingSimulatorCanvasOpenRequest()).toBeNull()
    expect(notifications).toHaveLength(2)
    unsubscribe()
  })

  it('accepts only chat-scoped agent presentation events', () => {
    expect(
      isSimulatorCanvasPresentationEvent(
        { kind: 'agent.presented', chatId: 'chat-a', tool: 'simulator_screenshot' },
        'chat-a'
      )
    ).toBe(true)
    expect(
      isSimulatorCanvasPresentationEvent(
        { kind: 'agent.presented', chatId: 'chat-b', tool: 'simulator_screenshot' },
        'chat-a'
      )
    ).toBe(false)
    expect(
      isSimulatorCanvasPresentationEvent(
        { kind: 'scene.presented', chatId: 'chat-a', tool: 'simulator_screenshot' },
        'chat-a'
      )
    ).toBe(false)
  })
})
