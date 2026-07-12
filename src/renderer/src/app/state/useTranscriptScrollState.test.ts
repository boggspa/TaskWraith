import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hookHarness = vi.hoisted(() => ({
  effectFactories: [] as Array<() => void | (() => void)>,
  layoutEffectFactories: [] as Array<() => void | (() => void)>,
  listeners: new Map<string, (event: any) => void>(),
  windowListeners: new Map<string, (event: any) => void>(),
  refCall: 0,
  stateSetters: [] as Array<ReturnType<typeof vi.fn>>,
  scroller: null as unknown as HTMLElement
}))

vi.mock('react', () => ({
  useCallback: <T extends (...args: any[]) => any>(callback: T): T => callback,
  useEffect: (factory: () => void | (() => void)) => {
    hookHarness.effectFactories.push(factory)
  },
  useLayoutEffect: (factory: () => void | (() => void)) => {
    hookHarness.layoutEffectFactories.push(factory)
  },
  useRef: <T>(initial: T) => {
    const call = hookHarness.refCall++
    return { current: call === 0 ? hookHarness.scroller : initial }
  },
  useState: <T>(initial: T) => {
    const setter = vi.fn()
    hookHarness.stateSetters.push(setter)
    return [initial, setter] as const
  }
}))

import { useTranscriptScrollState } from './useTranscriptScrollState'

describe('useTranscriptScrollState', () => {
  beforeEach(() => {
    hookHarness.effectFactories.length = 0
    hookHarness.layoutEffectFactories.length = 0
    hookHarness.listeners.clear()
    hookHarness.windowListeners.clear()
    hookHarness.refCall = 0
    hookHarness.stateSetters.length = 0
    hookHarness.scroller = {
      scrollTop: 500,
      scrollHeight: 1_000,
      clientHeight: 200,
      scrollTo: vi.fn(),
      addEventListener: vi.fn((name: string, listener: (event: any) => void) => {
        hookHarness.listeners.set(name, listener)
      }),
      removeEventListener: vi.fn()
    } as unknown as HTMLElement
    vi.stubGlobal('window', {
      addEventListener: vi.fn((name: string, listener: (event: any) => void) => {
        hookHarness.windowListeners.set(name, listener)
      }),
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('publishes input-owned follow changes so the streaming jump pill can rerender', () => {
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true
    })

    // Effect 3 owns wheel/key/pointer intent; run only that focused binding.
    hookHarness.effectFactories[2]?.()
    const autoFollowStateSetter = hookHarness.stateSetters[0]

    hookHarness.listeners.get('wheel')?.({ deltaY: -1 })
    expect(autoFollowStateSetter).toHaveBeenLastCalledWith(false)
    hookHarness.listeners.get('wheel')?.({ deltaY: -1 })
    expect(autoFollowStateSetter).toHaveBeenCalledTimes(1)

    hookHarness.windowListeners.get('keydown')?.({
      key: 'End',
      target: null,
      preventDefault: vi.fn()
    })
    expect(autoFollowStateSetter).toHaveBeenLastCalledWith(true)
    expect(autoFollowStateSetter).toHaveBeenCalledTimes(2)
  })

  it('publishes document-root PageUp intent when transcript prose owns the visible scroll', () => {
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true
    })

    hookHarness.effectFactories[2]?.()
    const autoFollowStateSetter = hookHarness.stateSetters[0]

    hookHarness.windowListeners.get('keydown')?.({ key: 'PageUp', target: null })

    expect(autoFollowStateSetter).toHaveBeenCalledWith(false)
  })

  it('publishes follow changes after a shared consumer pre-mutates the decision ref', () => {
    const result = useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true
    })

    // TranscriptPanel prepares a message jump this way: it updates the shared
    // decision ref synchronously, then invokes the hook callback.
    result.autoFollowRef.current = false
    result.beginManualTranscriptJump()

    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
  })
})
