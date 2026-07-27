import { describe, expect, it } from 'vitest'
import { MESH_CANVAS_NEEDS_SAVED_CHAT, meshCanvasIssueMessage } from './meshCanvasAvailability'

describe('meshCanvasIssueMessage', () => {
  it('replaces a transient chat-authority transport failure with a recovery action', () => {
    expect(
      meshCanvasIssueMessage(
        new Error(
          "Error invoking remote method 'mesh-scene:list-chat': Error: Mesh Canvas chat authority is unavailable."
        ),
        'fallback'
      )
    ).toBe(MESH_CANVAS_NEEDS_SAVED_CHAT)
  })

  it('preserves a meaningful unrelated failure and falls back for unknown values', () => {
    expect(meshCanvasIssueMessage(new Error('Selected model is malformed.'), 'fallback')).toBe(
      'Selected model is malformed.'
    )
    expect(meshCanvasIssueMessage(undefined, 'fallback')).toBe('fallback')
  })
})
