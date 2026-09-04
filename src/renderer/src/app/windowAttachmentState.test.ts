import { describe, expect, it } from 'vitest'
import type {
  NativeWindowCoordinatorRendererObservation,
  NativeWindowCoordinatorRendererStatus
} from '../../../main/nativeWindow/NativeWindowCoordinator'
import {
  attachedWindowFromStatus,
  stickyAppWatchStashInput,
  type AttachedWindowSnapshot
} from './windowAttachmentState'

const windowMeta = {
  title: 'Notes',
  bundleID: 'com.apple.Notes',
  applicationName: 'Notes',
  identityQuality: 'exact'
} as const

function statusWith(
  observation: NativeWindowCoordinatorRendererObservation | null
): NativeWindowCoordinatorRendererStatus {
  return { pickerPending: false, observation, control: null }
}

function observationWith(
  overrides: Partial<NativeWindowCoordinatorRendererObservation> = {}
): NativeWindowCoordinatorRendererObservation {
  return {
    chatId: 'chat-1',
    generation: 3,
    attachedAt: '2026-09-04T00:00:00.000Z',
    window: { ...windowMeta },
    ...overrides
  }
}

describe('attachedWindowFromStatus', () => {
  it('returns null when the status carries no observation', () => {
    expect(attachedWindowFromStatus(statusWith(null))).toBeNull()
  })

  it('projects the observation fields through unchanged', () => {
    const snapshot = attachedWindowFromStatus(statusWith(observationWith()))
    expect(snapshot).toEqual({
      chatId: 'chat-1',
      generation: 3,
      windowMeta: { ...windowMeta },
      attachedAt: '2026-09-04T00:00:00.000Z'
    })
    expect(snapshot && 'streaming' in snapshot).toBe(false)
  })

  it('carries streaming through only when the observation has it', () => {
    const streaming = {
      fps: 30,
      bufferSeconds: 5,
      frameCount: 120,
      startedAt: '2026-09-04T00:00:01.000Z'
    }
    const withStreaming = attachedWindowFromStatus(statusWith(observationWith({ streaming })))
    expect(withStreaming?.streaming).toEqual(streaming)
  })
})

describe('stickyAppWatchStashInput', () => {
  it('keeps only the public identity fields and drops private window metadata', () => {
    const attachment: AttachedWindowSnapshot = {
      chatId: 'chat-1',
      generation: 3,
      windowMeta: { ...windowMeta },
      attachedAt: '2026-09-04T00:00:00.000Z',
      streaming: {
        fps: 30,
        bufferSeconds: 5,
        frameCount: 120,
        startedAt: '2026-09-04T00:00:01.000Z'
      }
    }
    expect(stickyAppWatchStashInput(attachment)).toEqual({
      chatId: 'chat-1',
      windowMeta: {
        title: 'Notes',
        bundleID: 'com.apple.Notes',
        applicationName: 'Notes'
      },
      attachedAt: '2026-09-04T00:00:00.000Z',
      wasStreaming: true
    })
  })

  it('marks wasStreaming false when the attachment is not streaming', () => {
    const attachment: AttachedWindowSnapshot = {
      chatId: 'chat-2',
      generation: 1,
      windowMeta: { ...windowMeta },
      attachedAt: '2026-09-04T00:00:00.000Z'
    }
    const input = stickyAppWatchStashInput(attachment)
    expect(input.wasStreaming).toBe(false)
    expect(input).not.toHaveProperty('stashedAt')
  })
})
