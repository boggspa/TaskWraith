import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_LIVE_SNAPSHOT_INTERVAL_MS,
  createRemoteLiveSnapshotScheduler,
  hasStreamingRemoteRunSessions,
  remoteLiveSnapshotDelayMs,
  remoteProjectionSnapshotThrottleMsForStreaming
} from './RemoteBridgePerfTuning'

describe('RemoteBridgePerfTuning', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces live thread snapshot pushes to the trailing edge of the cadence window', () => {
    expect(remoteLiveSnapshotDelayMs(1000, undefined)).toBe(0)
    expect(remoteLiveSnapshotDelayMs(1250, 1000)).toBe(
      REMOTE_LIVE_SNAPSHOT_INTERVAL_MS - 250
    )
    expect(remoteLiveSnapshotDelayMs(1600, 1000)).toBe(0)
  })

  it('keeps the newest trailing live snapshot after a burst', async () => {
    vi.useFakeTimers()
    let nowMs = 1000
    const pushes: Array<{ threadId: string; nowMs: number }> = []
    const scheduler = createRemoteLiveSnapshotScheduler({
      now: () => nowMs,
      push: (threadId) => {
        pushes.push({ threadId, nowMs })
        return true
      }
    })

    scheduler.schedule('thread-a')
    nowMs = 1200
    scheduler.schedule('thread-a')
    scheduler.schedule('thread-a')

    expect(pushes).toEqual([{ threadId: 'thread-a', nowMs: 1000 }])
    nowMs = 1600
    await vi.advanceTimersByTimeAsync(400)

    expect(pushes).toEqual([
      { threadId: 'thread-a', nowMs: 1000 },
      { threadId: 'thread-a', nowMs: 1600 }
    ])
  })

  it('lets agent-exit clear a pending trailing live snapshot', async () => {
    vi.useFakeTimers()
    let nowMs = 1000
    const pushes: string[] = []
    const scheduler = createRemoteLiveSnapshotScheduler({
      now: () => nowMs,
      push: (threadId) => {
        pushes.push(threadId)
        return true
      }
    })

    scheduler.schedule('thread-a')
    nowMs = 1200
    scheduler.schedule('thread-a')
    scheduler.clear('thread-a')
    nowMs = 1600
    await vi.advanceTimersByTimeAsync(400)

    expect(pushes).toEqual(['thread-a'])
  })

  it('keys the full projection throttle on true running chat streams', () => {
    expect(
      hasStreamingRemoteRunSessions([
        { appChatId: 'chat-starting', status: 'starting' },
        { status: 'running' },
        { appChatId: 'chat-done', status: 'completed' }
      ])
    ).toBe(false)
    expect(
      hasStreamingRemoteRunSessions([{ appChatId: 'chat-streaming', status: 'running' }])
    ).toBe(true)
  })

  it('uses the wider full-snapshot window only while a stream is running', () => {
    expect(remoteProjectionSnapshotThrottleMsForStreaming(false)).toBe(1000)
    expect(remoteProjectionSnapshotThrottleMsForStreaming(true)).toBe(2500)
  })
})
