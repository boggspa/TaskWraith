import { describe, expect, it, vi } from 'vitest'
import { makeElectronIpcSink, RunEventBus } from './RunEventBus'

/*
 * 1.0.4-AQ1 — regression coverage for the disposed-frame race in
 * `makeElectronIpcSink`.
 *
 * Pre-fix the sink checked `sender.isDestroyed()` but did NOT wrap the
 * subsequent `sender.send(...)` in try-catch. That meant a frame
 * disposed BETWEEN the check and the send (microtask race when the
 * user closes the window during a CLI socket flush) would crash with
 * an electron-internal "Render frame was disposed before WebFrameMain
 * could be accessed" stderr spam.
 *
 * These tests pin both guard branches: the early-exit when
 * `isDestroyed()` returns true, and the swallow when the send itself
 * throws.
 */

function makeSender(
  over: Partial<{ isDestroyed: () => boolean; send: (...args: any[]) => void }> = {}
) {
  return {
    isDestroyed: over.isDestroyed ?? (() => false),
    send: over.send ?? vi.fn()
  } as unknown as Electron.WebContents
}

describe('makeElectronIpcSink', () => {
  it('forwards the payload to sender.send when the sender is alive', () => {
    const send = vi.fn()
    const sink = makeElectronIpcSink()
    sink.handle({
      channel: 'agent-output',
      provider: 'codex',
      publishedAt: new Date().toISOString(),
      payload: { hello: 'world' },
      sender: makeSender({ send })
    })
    expect(send).toHaveBeenCalledWith('agent-output', { hello: 'world' })
  })

  it('returns silently when the sender is null', () => {
    const sink = makeElectronIpcSink()
    expect(() =>
      sink.handle({
        channel: 'agent-output',
        provider: 'codex',
        publishedAt: new Date().toISOString(),
        payload: {},
        sender: undefined
      })
    ).not.toThrow()
  })

  it('does not forward events explicitly suppressed from renderer IPC', () => {
    const send = vi.fn()
    const sink = makeElectronIpcSink()
    sink.handle({
      channel: 'agent-output',
      provider: 'kimi',
      publishedAt: new Date().toISOString(),
      payload: { ensembleMaterialized: true },
      sender: makeSender({ send }),
      suppressElectronIpc: true
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('returns early when isDestroyed() reports true', () => {
    const send = vi.fn()
    const sink = makeElectronIpcSink()
    sink.handle({
      channel: 'agent-output',
      provider: 'codex',
      publishedAt: new Date().toISOString(),
      payload: {},
      sender: makeSender({ isDestroyed: () => true, send })
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('treats an isDestroyed() that throws as if the sender is disposed', () => {
    const send = vi.fn()
    const sink = makeElectronIpcSink()
    sink.handle({
      channel: 'agent-output',
      provider: 'codex',
      publishedAt: new Date().toISOString(),
      payload: {},
      sender: makeSender({
        isDestroyed: () => {
          throw new Error('Object has been destroyed')
        },
        send
      })
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows a send() that throws (TOCTOU race between check and send)', () => {
    // Pre-1.0.4-AQ1: this exact path would crash the main process
    // with `Render frame was disposed before WebFrameMain could be
    // accessed`. The sink now wraps the send in try-catch so the
    // race is contained.
    const sink = makeElectronIpcSink()
    expect(() =>
      sink.handle({
        channel: 'agent-output',
        provider: 'codex',
        publishedAt: new Date().toISOString(),
        payload: {},
        sender: makeSender({
          isDestroyed: () => false,
          send: () => {
            throw new Error('Render frame was disposed before WebFrameMain could be accessed')
          }
        })
      })
    ).not.toThrow()
  })
})

describe('RunEventBus exact-run audiences', () => {
  it('delivers a claimed run only to its closed main-owned sink audience', () => {
    const bus = new RunEventBus()
    const channelCollector = vi.fn()
    const renderer = vi.fn()
    const remoteBridge = vi.fn()
    bus.subscribe({ id: 'channel-agent-run-terminal', handle: channelCollector })
    bus.subscribe({ id: 'electron-ipc', handle: renderer })
    bus.subscribe({ id: 'remote-bridge', handle: remoteBridge })
    const lease = bus.claimRunAudience('channel-agent-run-1', ['channel-agent-run-terminal'])

    bus.publish({
      channel: 'agent-output',
      provider: 'codex',
      payload: { appRunId: 'channel-agent-run-1', text: 'private provider output' }
    })
    bus.publish({
      channel: 'agent-exit',
      provider: 'codex',
      payload: { appRunId: 'channel-agent-run-1', code: 0 }
    })

    expect(channelCollector).toHaveBeenCalledTimes(2)
    expect(renderer).not.toHaveBeenCalled()
    expect(remoteBridge).not.toHaveBeenCalled()
    expect(lease).toMatchObject({
      runId: 'channel-agent-run-1',
      sinkIds: ['channel-agent-run-terminal']
    })
    expect(Object.isFrozen(lease)).toBe(true)
  })

  it('leaves unrelated or non-canonical payloads on the ordinary fan-out path', () => {
    const bus = new RunEventBus()
    const first = vi.fn()
    const second = vi.fn()
    bus.subscribe({ id: 'first', handle: first })
    bus.subscribe({ id: 'second', handle: second })
    bus.claimRunAudience('channel-agent-run-2', ['first'])

    for (const payload of [
      { appRunId: 'ordinary-run', text: 'ordinary' },
      { appRunId: ' channel-agent-run-2', text: 'non-canonical' },
      { text: 'unrouted' },
      Object.create({ appRunId: 'channel-agent-run-2' })
    ]) {
      bus.publish({ channel: 'agent-output', provider: 'codex', payload })
    }

    expect(first).toHaveBeenCalledTimes(4)
    expect(second).toHaveBeenCalledTimes(4)
  })

  it('rejects ambiguous claims and makes lease release stale-owner safe', () => {
    const bus = new RunEventBus()
    expect(() => bus.claimRunAudience('', ['collector'])).toThrow('claim is invalid')
    expect(() => bus.claimRunAudience('run', [])).toThrow('claim is invalid')
    expect(() => bus.claimRunAudience('run', ['collector', 'collector'])).toThrow('must be unique')

    const first = bus.claimRunAudience('run', ['collector'])
    expect(bus.restrictedRunCount()).toBe(1)
    expect(() => bus.claimRunAudience('run', ['collector'])).toThrow('already claimed')
    expect(first.release()).toBe(true)
    expect(first.release()).toBe(false)

    const replacement = bus.claimRunAudience('run', ['replacement'])
    expect(first.release()).toBe(false)
    expect(bus.restrictedRunCount()).toBe(1)
    expect(replacement.release()).toBe(true)
    expect(bus.restrictedRunCount()).toBe(0)
  })

  it('clears both subscribers and abandoned audience leases during reset', () => {
    const bus = new RunEventBus()
    bus.subscribe({ id: 'collector', handle: vi.fn() })
    const lease = bus.claimRunAudience('run', ['collector'])

    bus.reset()

    expect(bus.listSinks()).toEqual([])
    expect(bus.restrictedRunCount()).toBe(0)
    expect(lease.release()).toBe(false)
  })
})
