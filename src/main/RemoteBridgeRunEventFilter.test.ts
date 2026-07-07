import { describe, expect, it } from 'vitest'
import { createRemoteBridgeRunEventInterestFilter } from './RemoteBridgeRunEventFilter'
import type { RunEvent } from './RunEventBus'

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    channel: 'agent-output',
    provider: 'codex',
    payload: { appChatId: 'chat-a', text: 'hello' },
    publishedAt: '2026-07-07T20:00:00.000Z',
    ...overrides
  }
}

describe('RemoteBridgeRunEventInterestFilter', () => {
  it('fails open before a device asserts watch capability', () => {
    const filter = createRemoteBridgeRunEventInterestFilter()

    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-a' } }))).toBe(true)
    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-b' } }))).toBe(true)
  })

  it('forwards classifiable agent-output only for the watched thread after assertion', () => {
    const filter = createRemoteBridgeRunEventInterestFilter()
    filter.setWatchedThread('chat-a')

    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-a' } }))).toBe(true)
    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-b' } }))).toBe(false)
  })

  it('treats null watch as home screen and filters classifiable agent-output', () => {
    const filter = createRemoteBridgeRunEventInterestFilter()
    filter.setWatchedThread(null)

    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-a' } }))).toBe(false)
  })

  it('passes unclassifiable agent-output and non-output channels', () => {
    const filter = createRemoteBridgeRunEventInterestFilter()
    filter.setWatchedThread(null)

    expect(filter.shouldForward(event({ payload: { text: 'no thread' } }))).toBe(true)
    expect(filter.shouldForward(event({ channel: 'agent-exit', payload: { appChatId: 'chat-b' } }))).toBe(
      true
    )
  })

  it('resets to fail-open on device establish until the phone re-asserts', () => {
    const filter = createRemoteBridgeRunEventInterestFilter()
    filter.setWatchedThread('chat-a')
    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-b' } }))).toBe(false)

    filter.resetOnDeviceEstablished()

    expect(filter.state).toMatchObject({ watchedAppChatId: null, hasWatchCapability: false })
    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-b' } }))).toBe(true)
  })

  it('fails open while multiple devices are connected', () => {
    const filter = createRemoteBridgeRunEventInterestFilter()
    filter.setWatchedThread('chat-a')
    filter.setConnectedDeviceCount(2)

    expect(filter.shouldForward(event({ payload: { appChatId: 'chat-b' } }))).toBe(true)
  })
})
