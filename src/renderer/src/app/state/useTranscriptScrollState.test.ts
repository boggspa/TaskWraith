import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hookHarness = vi.hoisted(() => ({
  effectDependencies: [] as Array<readonly unknown[] | undefined>,
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
  useEffect: (factory: () => void | (() => void), dependencies?: readonly unknown[]) => {
    hookHarness.effectFactories.push(factory)
    hookHarness.effectDependencies.push(dependencies)
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
    hookHarness.effectDependencies.length = 0
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

  it('rebinds every transcript DOM effect when an empty-start pane mounts its transcript', () => {
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      transcriptMounted: false,
      transcriptScrollRef: { current: hookHarness.scroller as HTMLDivElement },
      transcriptContentRef: { current: hookHarness.scroller as HTMLDivElement }
    })

    // A stale ref must not bind while the welcome transcript is absent.
    for (const effectIndex of [0, 2, 3, 4, 5]) {
      hookHarness.effectFactories[effectIndex]?.()
      expect(hookHarness.effectDependencies[effectIndex]).toContain(false)
    }
    expect(hookHarness.scroller.addEventListener).not.toHaveBeenCalled()

    hookHarness.effectFactories.length = 0
    hookHarness.effectDependencies.length = 0
    hookHarness.refCall = 0
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [{ id: 'first-message' }],
      runCompleteNotice: null,
      transcriptMounted: true,
      transcriptScrollRef: { current: hookHarness.scroller as HTMLDivElement },
      transcriptContentRef: { current: hookHarness.scroller as HTMLDivElement }
    })

    for (const effectIndex of [0, 2, 3, 4, 5]) {
      expect(hookHarness.effectDependencies[effectIndex]).toContain(true)
    }
    hookHarness.effectFactories[0]?.()
    hookHarness.effectFactories[2]?.()
    expect(hookHarness.listeners.has('scroll')).toBe(true)
    expect(hookHarness.listeners.has('wheel')).toBe(true)
    expect(hookHarness.windowListeners.has('keydown')).toBe(true)
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

  it('releases follow from an unclassified native scrollbar scroll before the next transcript update', () => {
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true
    })

    // Effect 1 owns the passive native scroll listener. Simulate a scrollbar
    // drag that Chromium did not pair with a wheel/pointer event on the
    // transcript content element.
    hookHarness.effectFactories[0]?.()
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 620
    hookHarness.listeners.get('scroll')?.({})

    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
  })

  it('releases follow when a native scrollbar move outruns the streaming layout snap', () => {
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [{ id: 'streaming-message' }],
      runCompleteNotice: null,
      streamingActive: true
    })

    // The browser can apply a native scrollbar move before it has delivered
    // the matching scroll event. A streaming render must see that live DOM
    // position and decline its layout-effect snap instead of teleporting the
    // reader to the tail.
    hookHarness.effectFactories[0]?.()
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 620
    ;(hookHarness.scroller as unknown as { scrollHeight: number }).scrollHeight = 1_240
    hookHarness.layoutEffectFactories[2]?.()

    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
    expect((hookHarness.scroller as unknown as { scrollTop: number }).scrollTop).toBe(620)
  })

  it('publishes follow changes after a shared consumer pre-mutates the decision ref', () => {
    const autoFollowRef = { current: true }
    const setAutoFollowRef = vi.fn((next: boolean) => {
      autoFollowRef.current = next
    })
    const result = useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true,
      autoFollowRef,
      setAutoFollowRef
    })

    // TranscriptPanel prepares a message jump this way: it updates the shared
    // decision ref synchronously, then invokes the hook callback.
    result.autoFollowRef.current = false
    result.beginManualTranscriptJump()

    expect(setAutoFollowRef).toHaveBeenLastCalledWith(false)
    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
  })

  it('captures the outgoing chat into its supplied pane-local cache with exact follow ownership', () => {
    const autoFollowRef = { current: false }
    const chatScrollStateByIdRef = { current: new Map() }
    useTranscriptScrollState({
      chatId: 'chat-a',
      messages: [],
      runCompleteNotice: null,
      transcriptScrollRef: { current: hookHarness.scroller as HTMLDivElement },
      transcriptContentRef: { current: null },
      autoFollowRef,
      setAutoFollowRef: (next) => {
        autoFollowRef.current = next
      },
      chatScrollStateByIdRef
    })

    const cleanup = hookHarness.layoutEffectFactories[1]?.()
    expect(cleanup).toBeTypeOf('function')
    cleanup?.()

    expect(chatScrollStateByIdRef.current.get('chat-a')).toMatchObject({
      autoFollow: false,
      scrollState: {
        scrollTop: 500,
        atBottom: false
      }
    })
    expect(chatScrollStateByIdRef.current.has('chat-b')).toBe(false)
  })
})
