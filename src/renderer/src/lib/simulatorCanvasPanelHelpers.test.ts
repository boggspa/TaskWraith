import { describe, expect, it } from 'vitest'
import {
  SIMULATOR_FRAME_STALE_MS,
  claimControlFailureMessage,
  isSimulatorFrameStale,
  shouldAcceptSimulatorScreenshotFrame,
  shouldOpenMeshFromChatRehydrate
} from './simulatorCanvasPanelHelpers'

describe('isSimulatorFrameStale', () => {
  it('is false when there is no frame or capturedAt is unparseable', () => {
    expect(isSimulatorFrameStale(null, 10_000)).toBe(false)
    expect(isSimulatorFrameStale({ capturedAt: 'not-a-date' }, 10_000)).toBe(false)
  })

  it('marks a frame stale once age exceeds 4s', () => {
    const capturedAt = new Date(1_000).toISOString()
    expect(isSimulatorFrameStale({ capturedAt }, 1_000 + SIMULATOR_FRAME_STALE_MS)).toBe(false)
    expect(isSimulatorFrameStale({ capturedAt }, 1_000 + SIMULATOR_FRAME_STALE_MS + 1)).toBe(true)
  })
})

describe('shouldAcceptSimulatorScreenshotFrame', () => {
  it('rejects late frames for a previous udid', () => {
    expect(shouldAcceptSimulatorScreenshotFrame({ udid: 'A' }, 'B')).toBe(false)
    expect(shouldAcceptSimulatorScreenshotFrame({ udid: 'A' }, 'A')).toBe(true)
    expect(shouldAcceptSimulatorScreenshotFrame(null, 'A')).toBe(false)
  })
})

describe('claimControlFailureMessage', () => {
  it('surfaces ok:false with the host error, else a fallback', () => {
    expect(claimControlFailureMessage({ ok: true, token: 't' })).toBeNull()
    expect(claimControlFailureMessage({ ok: false, error: 'held by run' })).toBe('held by run')
    expect(claimControlFailureMessage({ ok: false })).toBe('Could not claim Simulator control.')
  })
})

describe('shouldOpenMeshFromChatRehydrate', () => {
  it('does not override an active simulator surface or pending simulator open', () => {
    expect(
      shouldOpenMeshFromChatRehydrate({
        showSimulator: true,
        chatId: 'chat-1',
        pendingSimulatorChatId: null
      })
    ).toBe(false)
    expect(
      shouldOpenMeshFromChatRehydrate({
        showSimulator: false,
        chatId: 'chat-1',
        pendingSimulatorChatId: 'chat-1'
      })
    ).toBe(false)
    expect(
      shouldOpenMeshFromChatRehydrate({
        showSimulator: false,
        chatId: 'chat-1',
        pendingSimulatorChatId: 'chat-other'
      })
    ).toBe(true)
  })
})
