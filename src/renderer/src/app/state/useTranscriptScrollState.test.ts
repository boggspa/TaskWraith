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
    vi.restoreAllMocks()
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

  it('stamps lastUserScrollAt on any wheel/key scroll intent for Phase-1 gesture defer', () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const result = useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true
    })

    expect(result.lastUserScrollAtRef.current).toBe(0)
    expect(result.getUserScrollGestureLive()).toBe(false)

    // Effect 3 owns wheel/key/pointer intent.
    hookHarness.effectFactories[2]?.()

    // Downward intent must stamp too — Phase-1 defers for any live gesture,
    // not only scroll-away / follow-off.
    hookHarness.listeners.get('wheel')?.({ deltaY: 1 })
    expect(result.lastUserScrollAtRef.current).toBe(now)
    expect(result.getUserScrollGestureLive()).toBe(true)

    vi.mocked(Date.now).mockReturnValue(now + 121)
    expect(result.getUserScrollGestureLive()).toBe(false)

    hookHarness.windowListeners.get('keydown')?.({
      key: 'ArrowUp',
      target: null,
      preventDefault: vi.fn()
    })
    expect(result.lastUserScrollAtRef.current).toBe(now + 121)
    expect(result.getUserScrollGestureLive()).toBe(true)
  })

  it('cancels a pending follow-pin frame when wheel intent scrolls away', () => {
    // Live-edge geometry so the messages layout pass arms pinNowAndScheduleTrailing
    // (sync apply + one coalesced trailing rAF) without scheduling the separate
    // programmatic-clear nested frames.
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    const requestAnimationFrame = vi.fn(() => 42)
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)

    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [{ id: 'streaming-message' }],
      runCompleteNotice: null,
      streamingActive: true
    })

    // Layout effect 2 owns message-growth follow pins.
    hookHarness.layoutEffectFactories[2]?.()
    expect(requestAnimationFrame).toHaveBeenCalled()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()

    // Effect 3 owns wheel/key/pointer intent — upward wheel must drop the
    // trailing pin so a later frame cannot re-teleport the reader to the tail.
    hookHarness.effectFactories[2]?.()
    hookHarness.listeners.get('wheel')?.({ deltaY: -1 })

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
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
    // Effect indices after Phase E: 0 scroll, 1 programmatic-clear, 2 intent,
    // 3 content ResizeObserver, 4 chat-switch (code-block resize listener retired).
    for (const effectIndex of [0, 2, 3, 4]) {
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

    for (const effectIndex of [0, 2, 3, 4]) {
      expect(hookHarness.effectDependencies[effectIndex]).toContain(true)
    }
    hookHarness.effectFactories[0]?.()
    hookHarness.effectFactories[2]?.()
    expect(hookHarness.listeners.has('scroll')).toBe(true)
    expect(hookHarness.listeners.has('wheel')).toBe(true)
    expect(hookHarness.windowListeners.has('keydown')).toBe(true)
    // Phase E: outer CODE_BLOCK_RESIZE_EVENT listener is retired.
    expect([...hookHarness.listeners.keys()].some((name) => name.includes('code-block'))).toBe(
      false
    )
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

  it('ignores document-root key intent in a pane that does not own root scroll', () => {
    // Multiview mounts this hook per pane and every instance listens on the
    // window, so one PageUp with transcript prose focused (target = the
    // document root) disengaged follow in EVERY pane at once. Only the pane
    // the grid focused should act on a root-targeted key.
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true,
      ownsRootKeyboardScroll: false
    })

    hookHarness.effectFactories[2]?.()
    const autoFollowStateSetter = hookHarness.stateSetters[0]

    hookHarness.windowListeners.get('keydown')?.({ key: 'PageUp', target: null })
    hookHarness.windowListeners.get('keydown')?.({
      key: 'End',
      target: null,
      preventDefault: vi.fn()
    })

    expect(autoFollowStateSetter).not.toHaveBeenCalled()
  })

  it('still answers keys aimed at its own scroller when it does not own root scroll', () => {
    // Ownership gates only the ambiguous document-root event. A key genuinely
    // targeted inside this pane's transcript is unambiguously its own.
    class FakeNode {}
    const ownTarget = new FakeNode()
    vi.stubGlobal('Node', FakeNode)
    ;(hookHarness.scroller as unknown as { contains: (node: unknown) => boolean }).contains = (
      node
    ) => node === ownTarget

    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true,
      ownsRootKeyboardScroll: false
    })

    hookHarness.effectFactories[2]?.()
    const autoFollowStateSetter = hookHarness.stateSetters[0]

    hookHarness.windowListeners.get('keydown')?.({ key: 'PageUp', target: ownTarget })

    expect(autoFollowStateSetter).toHaveBeenCalledWith(false)
  })

  it('owns root key intent by default so the single-pane transcript is unchanged', () => {
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
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    // Live-edge geometry + messages so layout can arm pinNowAndScheduleTrailing;
    // unclassified scroll-away must cancel that coalesced frame (mirror wheel).
    const requestAnimationFrame = vi.fn(() => 42)
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const result = useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [{ id: 'streaming-message' }],
      runCompleteNotice: null,
      streamingActive: true
    })

    hookHarness.layoutEffectFactories[2]?.()
    expect(requestAnimationFrame).toHaveBeenCalled()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()

    // Effect 0 owns the passive native scroll listener. Simulate a scrollbar
    // drag that Chromium did not pair with a wheel/pointer event on the
    // transcript content element.
    hookHarness.effectFactories[0]?.()
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 620
    hookHarness.listeners.get('scroll')?.({})

    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
    // Verified user-away stamps gesture-live for Phase-1 deferral.
    expect(result.lastUserScrollAtRef.current).toBe(now)
    expect(result.getUserScrollGestureLive()).toBe(true)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
  })

  it('clears lastUserScrollAt on chat switch so gesture-live does not carry over', () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const result = useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [],
      runCompleteNotice: null,
      streamingActive: true
    })

    // Effect 2 owns wheel intent — stamp a live gesture window.
    hookHarness.effectFactories[2]?.()
    hookHarness.listeners.get('wheel')?.({ deltaY: 1 })
    expect(result.lastUserScrollAtRef.current).toBe(now)
    expect(result.getUserScrollGestureLive()).toBe(true)

    // Effect 4 owns chat-switch restore/snap. Switching must clear the stamp
    // so Phase-1 does not defer absolute restore on the incoming chat.
    hookHarness.effectFactories[4]?.()
    vi.mocked(Date.now).mockReturnValue(now + 50)
    expect(result.lastUserScrollAtRef.current).toBe(0)
    expect(result.getUserScrollGestureLive()).toBe(false)
  })

  it('cancels a pending follow-pin when chat-switch restores with follow off', () => {
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    const requestAnimationFrame = vi.fn(() => 42)
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)

    const chatScrollStateByIdRef = {
      current: new Map([
        [
          'chat-1',
          {
            autoFollow: false,
            scrollState: {
              scrollTop: 500,
              scrollHeight: 1_000,
              clientHeight: 200,
              scrollRatio: 0.625,
              atBottom: false
            }
          }
        ]
      ])
    }

    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [{ id: 'streaming-message' }],
      runCompleteNotice: null,
      streamingActive: true,
      chatScrollStateByIdRef
    })

    hookHarness.layoutEffectFactories[2]?.()
    expect(requestAnimationFrame).toHaveBeenCalled()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()

    // Cached follow-off → chat-switch plan restores with follow false and must
    // drop any coalesced pin from the prior chat's streaming layout.
    hookHarness.effectFactories[4]?.()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
  })

  it('cancels a pending follow-pin when external restore syncs follow off', () => {
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    const requestAnimationFrame = vi.fn(() => 42)
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)

    const result = useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [{ id: 'streaming-message' }],
      runCompleteNotice: null,
      streamingActive: true
    })

    hookHarness.layoutEffectFactories[2]?.()
    expect(requestAnimationFrame).toHaveBeenCalled()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()

    result.restoreScrollStateWhenReady(
      {
        scrollTop: 500,
        scrollHeight: 1_000,
        clientHeight: 200,
        scrollRatio: 0.625,
        atBottom: false
      },
      { syncAutoFollow: true }
    )

    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
    expect(result.lastUserScrollAtRef.current).toBe(0)
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
    // reader to the tail. Content and viewport heights are STABLE here —
    // that stability is what attributes the movement to the reader (an
    // unstable pair is indistinguishable from a fold clamp and keeps app
    // ownership instead; see the participant-boundary test below).
    hookHarness.effectFactories[0]?.()
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 620
    hookHarness.layoutEffectFactories[2]?.()

    expect(hookHarness.stateSetters[0]).toHaveBeenLastCalledWith(false)
    expect((hookHarness.scroller as unknown as { scrollTop: number }).scrollTop).toBe(620)
  })

  it('keeps follow and completes the snap across a participant-boundary fold + mount', () => {
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages: [{ id: 'm1' }],
      runCompleteNotice: null,
      streamingActive: true
    })

    // Ensemble hand-off: the settling participant's stack folds to a
    // one-liner (content shrinks, the browser clamps scrollTop 800 → 500 and
    // only QUEUES the scroll event), then the next participant's rows mount
    // in an adjacent commit (scrollHeight 1000 → 1100) before any of that is
    // sampled. The layout effect must read this as app-owned churn — keep
    // follow, complete the snap — not as a reader drag (the pre-stability
    // guard released follow here and stranded the transcript mid-air at
    // every participant boundary).
    hookHarness.effectFactories[0]?.()
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 500
    ;(hookHarness.scroller as unknown as { scrollHeight: number }).scrollHeight = 1_100
    hookHarness.layoutEffectFactories[2]?.()

    expect(hookHarness.stateSetters[0]).not.toHaveBeenCalled()
    expect((hookHarness.scroller as unknown as { scrollTop: number }).scrollTop).toBe(1_100)
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

  it('counts only conversational messages toward the unread pill', () => {
    const autoFollowRef = { current: false }
    // The hook treats the messages array as opaque and diffs countable
    // totals between layout passes; mutating one array in place lets a
    // single hook call express successive stream commits.
    const messages: Array<Record<string, unknown>> = [{ id: 'm1', role: 'assistant' }]
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages,
      runCompleteNotice: null,
      autoFollowRef,
      setAutoFollowRef: (next) => {
        autoFollowRef.current = next
      },
      transcriptScrollRef: { current: hookHarness.scroller as HTMLDivElement },
      transcriptContentRef: { current: hookHarness.scroller as HTMLDivElement }
    })

    // Layout effect 2 owns unread accounting. First pass records the
    // chat baseline (no unread yet).
    hookHarness.layoutEffectFactories[2]?.()
    const unreadSetter = hookHarness.stateSetters[1]
    expect(unreadSetter).not.toHaveBeenCalled()

    // Run machinery streams in: tool activity batches and a system
    // lifecycle row. None of it is a "new message".
    messages.push(
      { id: 't1', role: 'tool', toolActivities: [{ id: 'a1' }] },
      { id: 't2', role: 'tool', toolActivities: [{ id: 'a2' }] },
      { id: 's1', role: 'system' }
    )
    hookHarness.layoutEffectFactories[2]?.()
    expect(unreadSetter).not.toHaveBeenCalled()

    // A real assistant bubble arrives below the scrolled-up reader.
    messages.push({ id: 'm2', role: 'assistant' })
    hookHarness.layoutEffectFactories[2]?.()
    expect(unreadSetter).toHaveBeenLastCalledWith(1)
  })

  it('clears the unread tally and away gate when the viewport shows the live edge', () => {
    const autoFollowRef = { current: false }
    const messages: Array<Record<string, unknown>> = [{ id: 'm1', role: 'assistant' }]
    useTranscriptScrollState({
      chatId: 'chat-1',
      messages,
      runCompleteNotice: null,
      autoFollowRef,
      setAutoFollowRef: (next) => {
        autoFollowRef.current = next
      },
      transcriptScrollRef: { current: hookHarness.scroller as HTMLDivElement },
      transcriptContentRef: { current: hookHarness.scroller as HTMLDivElement }
    })

    hookHarness.layoutEffectFactories[2]?.()
    const unreadSetter = hookHarness.stateSetters[1]
    const awaySetter = hookHarness.stateSetters[3]
    // Scroller starts 300px above the bottom — the reader is genuinely away.
    expect(awaySetter).toHaveBeenLastCalledWith(true)

    messages.push({ id: 'm2', role: 'assistant' })
    hookHarness.layoutEffectFactories[2]?.()
    expect(unreadSetter).toHaveBeenLastCalledWith(1)

    // A shrink clamp (or slow scrollbar drag) lands the reader at the tail
    // WITHOUT re-arming follow: everything below the fold is now read, so
    // the tally clears and the away gate closes — no phantom pill.
    ;(hookHarness.scroller as unknown as { scrollTop: number }).scrollTop = 800
    hookHarness.layoutEffectFactories[2]?.()
    expect(unreadSetter).toHaveBeenLastCalledWith(0)
    expect(awaySetter).toHaveBeenLastCalledWith(false)
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
