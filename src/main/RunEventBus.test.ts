import { describe, expect, it, vi } from 'vitest'
import { makeElectronIpcSink } from './RunEventBus'

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
