import { describe, expect, it } from 'vitest'
import {
  consumeMeshCanvasOpenRequest,
  getPendingMeshCanvasOpenRequest,
  requestMeshCanvasOpen,
  subscribeMeshCanvasOpenRequests
} from './meshCanvasLaunch'

describe('meshCanvasLaunch', () => {
  it('keeps a chat-owned request until the Mesh Canvas dock consumes it', () => {
    const notifications: number[] = []
    const unsubscribe = subscribeMeshCanvasOpenRequests(() => notifications.push(1))
    requestMeshCanvasOpen('chat-mesh')
    const request = getPendingMeshCanvasOpenRequest()

    expect(request).toMatchObject({ chatId: 'chat-mesh' })
    consumeMeshCanvasOpenRequest(request!.id)
    expect(getPendingMeshCanvasOpenRequest()).toBeNull()
    expect(notifications).toHaveLength(2)
    unsubscribe()
  })
})
