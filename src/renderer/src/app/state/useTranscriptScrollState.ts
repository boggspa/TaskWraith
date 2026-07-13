import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  CODE_BLOCK_RESIZE_EVENT,
  STICK_ENGAGE_PX,
  advanceExternalRestoreLifecycle,
  captureChatScrollState,
  expectedBottomScrollTop,
  hasExplicitTranscriptScrollAwayIntent,
  hasRecentTranscriptDownwardIntent,
  isEditableTranscriptKeyTarget,
  isExpectedProgrammaticScroll,
  isTranscriptScrollbarPointer,
  restoreChatScrollStateWhenReady,
  resolveTranscriptChatSwitchPlan,
  shouldAbortAutoFollowSnap,
  shouldReengageAutoFollowAfterScroll,
  shouldRepinAfterCodeBlockResize,
  shouldRepinAfterFrame,
  shouldRepinAfterScrollEvaluation,
  shouldRepinAfterTranscriptResize,
  shouldRecordScrollbarDownwardIntent,
  shouldClearScrollbarDownwardIntent,
  shouldShowJumpToLatestPill,
  shouldTreatScrollAsUserScrollAway,
  type CachedChatScrollState,
  type ChatScrollState
} from '../../lib/TranscriptScroll'

export interface UseTranscriptScrollStateInput {
  chatId: string | null
  messages: readonly unknown[] | undefined
  runCompleteNotice: unknown
  /** True while a run is streaming into this chat — keeps the
   *  jump-to-latest pill visible when follow is off even though text growth
   *  inside one bubble never bumps the message-count-based unread number. */
  streamingActive?: boolean
}

export interface RestoreTranscriptScrollOptions {
  syncAutoFollow?: boolean
  targetChatId?: string | null
}

export function useTranscriptScrollState({
  chatId,
  messages,
  runCompleteNotice,
  streamingActive
}: UseTranscriptScrollStateInput) {
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const transcriptContentRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const [autoFollowActive, setAutoFollowActive] = useState(true)
  const publishedAutoFollowRef = useRef(true)
  const setAutoFollow = useCallback((next: boolean) => {
    autoFollowRef.current = next
    // TranscriptPanel shares this ref and may update it before invoking one of
    // the callbacks below. Compare against the last published React state, not
    // the externally mutable decision ref, so those callback paths still
    // trigger the presentation rerender they requested.
    if (publishedAutoFollowRef.current === next) return
    publishedAutoFollowRef.current = next
    // The ref owns synchronous scroll decisions, while state makes the
    // presentation react to input-only changes. Wheel/key/scrollbar gestures
    // do not necessarily change messages, so without this state update the
    // jump-to-latest pill can remain stale for an entire streaming lane.
    setAutoFollowActive(next)
  }, [])
  const userScrolledAwayInFrameRef = useRef(false)
  // True from a jump-to-latest click until the scroll arrives at the live
  // edge (or the user cancels with an upward gesture). The smooth-scroll
  // flight passes through positions far from the bottom; without this the
  // rAF evaluate's positional disengage would kill the follow the click
  // just armed, and a mid-flight content growth would strand the jump short
  // of the bottom with the pill re-appearing.
  const jumpInFlightRef = useRef(false)
  // Timestamp of the last verified downward gesture (wheel/touch/key or a
  // tracked scrollbar pointer); zeroed by any upward gesture or scroll-away.
  // Vouches for both re-engage bands — scroll events alone cannot distinguish a
  // real downward return from an unarmed restore write or a coalesced frame
  // whose last input was upward.
  const downwardIntentAtRef = useRef(0)
  // Native/overlay scrollbar drags do not emit wheel/touch/key intent. Mark a
  // pointer that starts on the scrollbar, then vouch for it only after its
  // scrollTop actually moves downward. The normal 400ms timestamp window gives
  // the final scroll event a short grace after pointerup.
  const scrollbarPointerActiveRef = useRef(false)
  const repinRafIdRef = useRef<number | null>(null)
  const lastTranscriptScrollTopRef = useRef(0)
  // Updated for every native `scroll` event (not just the coalesced rAF) so a
  // scrollbar drag that reverses within one frame clears its downward voucher.
  const lastNativeScrollTopRef = useRef(0)
  const programmaticScrollTargetRef = useRef<number | null>(null)
  const programmaticScrollClearRafRef = useRef<number | null>(null)
  const [unreadFromBottomCount, setUnreadFromBottomCount] = useState(0)
  const [externalRestoreAnchorTarget, setExternalRestoreAnchorTarget] = useState<{
    generation: number
    targetChatId: string | null
    messageId: string
  } | null>(null)
  const unreadFromBottomCountRef = useRef(0)
  const previousMessagesCountRef = useRef<{ chatId: string | null; count: number }>({
    chatId: null,
    count: 0
  })
  const pendingTranscriptJumpChatIdRef = useRef<string | null>(null)
  const chatScrollStateByIdRef = useRef<Map<string, CachedChatScrollState>>(new Map())
  const committedChatIdRef = useRef(chatId)
  const externalRestoreGenerationRef = useRef(0)
  const pendingExternalRestoreRef = useRef<{
    generation: number
    targetChatId: string | null
    cached: CachedChatScrollState
    lifecycle: {
      settled: boolean
      chatSwitchObserved: boolean
    }
  } | null>(null)
  useLayoutEffect(() => {
    committedChatIdRef.current = chatId
  }, [chatId])
  const cancelPendingExternalRestore = useCallback(() => {
    externalRestoreGenerationRef.current += 1
    pendingExternalRestoreRef.current = null
    setExternalRestoreAnchorTarget(null)
  }, [])

  const captureScrollState = useCallback(
    () => captureChatScrollState(transcriptScrollRef.current),
    []
  )

  const restoreScrollStateWhenReady = useCallback(
    (
      scrollState: ChatScrollState | undefined,
      options: RestoreTranscriptScrollOptions = {}
    ) => {
      const targetChatId = options.targetChatId ?? committedChatIdRef.current
      const generation = externalRestoreGenerationRef.current + 1
      externalRestoreGenerationRef.current = generation
      pendingExternalRestoreRef.current = scrollState
        ? {
            generation,
            targetChatId,
            cached: { scrollState, autoFollow: scrollState.atBottom },
            lifecycle: {
              settled: false,
              chatSwitchObserved: committedChatIdRef.current === targetChatId
            }
          }
        : null
      setExternalRestoreAnchorTarget(
        scrollState?.anchorMessageId
          ? { generation, targetChatId, messageId: scrollState.anchorMessageId }
          : null
      )
      let ownershipSynced = false
      const cancel = restoreChatScrollStateWhenReady(
        () => {
          if (committedChatIdRef.current !== targetChatId) return null
          const scroller = transcriptScrollRef.current
          if (scroller && options.syncAutoFollow && !ownershipSynced && scrollState) {
            ownershipSynced = true
            setAutoFollow(scrollState.atBottom)
            userScrolledAwayInFrameRef.current = !scrollState.atBottom
          }
          return scroller
        },
        scrollState,
        8,
        () => externalRestoreGenerationRef.current === generation,
        () => {
          const pending = pendingExternalRestoreRef.current
          if (pending?.generation === generation) {
            const transition = advanceExternalRestoreLifecycle(pending.lifecycle, 'settled')
            const nextPending = { ...pending, lifecycle: transition.state }
            pendingExternalRestoreRef.current = transition.shouldClear ? null : nextPending
          }
          if (externalRestoreGenerationRef.current === generation) {
            setExternalRestoreAnchorTarget((current) =>
              current?.generation === generation ? null : current
            )
          }
        },
        8
      )
      return () => {
        cancel()
        if (pendingExternalRestoreRef.current?.generation === generation) {
          pendingExternalRestoreRef.current = null
        }
        if (externalRestoreGenerationRef.current === generation) {
          setExternalRestoreAnchorTarget((current) =>
            current?.generation === generation ? null : current
          )
        }
      }
    },
    [setAutoFollow]
  )

  const preserveScrollWhile = useCallback(
    (callback: () => void) => {
      const scrollState = captureScrollState()
      callback()
      restoreScrollStateWhenReady(scrollState)
    },
    [captureScrollState, restoreScrollStateWhenReady]
  )

  const handleJumpToLatest = useCallback(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return
    cancelPendingExternalRestore()
    setAutoFollow(true)
    userScrolledAwayInFrameRef.current = false
    jumpInFlightRef.current = true
    if (unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [cancelPendingExternalRestore, setAutoFollow])

  // Arm follow without a scroll of its own — for gestures where the NEXT
  // messages layout-effect snap should carry the viewport down (sending a
  // prompt while scrolled up: the reply belongs to the user's action, so the
  // transcript re-locks to the live edge exactly like Claude/Codex do).
  const relockToLatest = useCallback(() => {
    cancelPendingExternalRestore()
    setAutoFollow(true)
    userScrolledAwayInFrameRef.current = false
    jumpInFlightRef.current = false
    pendingTranscriptJumpChatIdRef.current = null
    if (unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
  }, [cancelPendingExternalRestore, setAutoFollow])

  const handleJumpToLatestRef = useRef(handleJumpToLatest)
  handleJumpToLatestRef.current = handleJumpToLatest

  const clearProgrammaticScrollTarget = useCallback(() => {
    programmaticScrollTargetRef.current = null
    if (programmaticScrollClearRafRef.current !== null) {
      cancelAnimationFrame(programmaticScrollClearRafRef.current)
      programmaticScrollClearRafRef.current = null
    }
  }, [])

  const scheduleProgrammaticScrollTargetClear = useCallback(() => {
    if (programmaticScrollClearRafRef.current !== null) {
      cancelAnimationFrame(programmaticScrollClearRafRef.current)
    }
    programmaticScrollClearRafRef.current = requestAnimationFrame(() => {
      programmaticScrollClearRafRef.current = requestAnimationFrame(() => {
        programmaticScrollClearRafRef.current = null
        programmaticScrollTargetRef.current = null
      })
    })
  }, [])

  const snapScrollToBottom = useCallback((node: HTMLElement) => {
    const target = expectedBottomScrollTop({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight
    })
    if (isExpectedProgrammaticScroll({ expectedScrollTop: target, nextScrollTop: node.scrollTop })) {
      clearProgrammaticScrollTarget()
    } else {
      programmaticScrollTargetRef.current = target
      scheduleProgrammaticScrollTargetClear()
    }
    node.scrollTop = node.scrollHeight
  }, [clearProgrammaticScrollTarget, scheduleProgrammaticScrollTargetClear])

  // Arm the programmatic-scroll guard for a scroll write the App did NOT
  // issue itself — specifically TranscriptPanel's virtual-window anchor
  // correction (keeps the anchored row fixed while rows above it re-measure).
  // That write is otherwise invisible to the scroll evaluator, so when it
  // lands at the live edge while moving DOWN (content above the anchor grew,
  // pushing scrollTop toward the bottom) the engage-band re-engage path reads
  // it as the user returning to the bottom and re-locks follow the user never
  // asked for — the Grok-in-ensemble "pulls to bottom" report (virtualization,
  // and thus the anchor correction, is active in multi-row ensemble chats).
  // Callers pass the ACTUAL post-write `scrollTop` (browser-clamped), so a
  // target that overshoots to the bottom is matched by the guard rather than
  // slipping through as the very re-engage it would trigger.
  const markProgrammaticScroll = useCallback(
    (landedScrollTop: number) => {
      if (!Number.isFinite(landedScrollTop)) return
      programmaticScrollTargetRef.current = Math.max(0, landedScrollTop)
      scheduleProgrammaticScrollTargetClear()
    },
    [scheduleProgrammaticScrollTargetClear]
  )

  const disengageIfLiveScrollShowsUserAway = useCallback(
    (scroller: HTMLElement): boolean => {
      const nextScrollTop = scroller.scrollTop
      if (
        !shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: lastTranscriptScrollTopRef.current,
          lastNativeScrollTop: lastNativeScrollTopRef.current,
          currentScrollTop: nextScrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          expectedProgrammaticScrollTop: programmaticScrollTargetRef.current,
          hasExplicitScrollAwayIntent: hasExplicitTranscriptScrollAwayIntent({
            userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current,
            scrollbarPointerActive: scrollbarPointerActiveRef.current,
            previousScrollTop: lastNativeScrollTopRef.current,
            nextScrollTop
          })
        })
      ) {
        return false
      }
      clearProgrammaticScrollTarget()
      setAutoFollow(false)
      userScrolledAwayInFrameRef.current = true
      jumpInFlightRef.current = false
      downwardIntentAtRef.current = 0
      lastTranscriptScrollTopRef.current = nextScrollTop
      lastNativeScrollTopRef.current = nextScrollTop
      return true
    },
    [clearProgrammaticScrollTarget, setAutoFollow]
  )

  const beginManualTranscriptJump = useCallback(() => {
    cancelPendingExternalRestore()
    setAutoFollow(false)
    userScrolledAwayInFrameRef.current = true
    jumpInFlightRef.current = false
    clearProgrammaticScrollTarget()
    pendingTranscriptJumpChatIdRef.current = null
    if (repinRafIdRef.current !== null) {
      cancelAnimationFrame(repinRafIdRef.current)
      repinRafIdRef.current = null
    }
  }, [cancelPendingExternalRestore, clearProgrammaticScrollTarget, setAutoFollow])

  const prepareMessageJump = useCallback((targetChatId: string) => {
    cancelPendingExternalRestore()
    pendingTranscriptJumpChatIdRef.current = targetChatId
    setAutoFollow(false)
    userScrolledAwayInFrameRef.current = true
    jumpInFlightRef.current = false
  }, [cancelPendingExternalRestore, setAutoFollow])

  const clearPendingMessageJump = useCallback(() => {
    pendingTranscriptJumpChatIdRef.current = null
  }, [])

  const prepareChatSwitch = useCallback(
    (targetChatId: string | null) => {
      const sourceChatId = committedChatIdRef.current
      if (!sourceChatId || sourceChatId === targetChatId) return
      if (pendingExternalRestoreRef.current?.targetChatId !== targetChatId) {
        cancelPendingExternalRestore()
      }
      const scrollState = captureScrollState()
      if (!scrollState) return
      chatScrollStateByIdRef.current.set(sourceChatId, {
        scrollState,
        autoFollow: autoFollowRef.current
      })
    },
    [cancelPendingExternalRestore, captureScrollState]
  )

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return

    let rafId: number | null = null
    const evaluate = () => {
      rafId = null
      const previousScrollTop = lastTranscriptScrollTopRef.current
      const nextScrollTop = scroller.scrollTop
      const distanceFromBottom = scroller.scrollHeight - nextScrollTop - scroller.clientHeight
      if (distanceFromBottom <= STICK_ENGAGE_PX) {
        // The live edge is reached by any means — a jump flight (smooth or
        // snapped short by the messages effect) has arrived.
        jumpInFlightRef.current = false
      }
      const expectedProgrammatic = isExpectedProgrammaticScroll({
        expectedScrollTop: programmaticScrollTargetRef.current,
        nextScrollTop
      })
      if (expectedProgrammatic) {
        clearProgrammaticScrollTarget()
        lastTranscriptScrollTopRef.current = nextScrollTop
        return
      }
      programmaticScrollTargetRef.current = null
      if (
        shouldReengageAutoFollowAfterScroll({
          distanceFromBottom,
          // Treat an already-off follow latch as sticky even if an unusual
          // scroll path did not set the companion intent flag (for example a
          // coalesced assistant-delta reflow racing the first scroll event).
          // Once follow is off, only verified downward input may re-arm it.
          userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current || !autoFollowRef.current,
          previousScrollTop,
          nextScrollTop,
          isProgrammatic: false,
          recentDownwardIntent: hasRecentTranscriptDownwardIntent({
            intentAt: downwardIntentAtRef.current,
            now: Date.now()
          })
        })
      ) {
        setAutoFollow(true)
        userScrolledAwayInFrameRef.current = false
        if (unreadFromBottomCountRef.current !== 0) {
          unreadFromBottomCountRef.current = 0
          setUnreadFromBottomCount(0)
        }
        if (distanceFromBottom > STICK_ENGAGE_PX) {
          // Band re-engage (STICK_REENGAGE_DOWNWARD_PX): the deliberate
          // downward return landed near — but not at — the moving live
          // edge. Complete the gesture so the user is actually pinned.
          snapScrollToBottom(scroller)
        }
      } else if (
        shouldRepinAfterScrollEvaluation({
          autoFollow: autoFollowRef.current,
          userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current,
          jumpInFlight: jumpInFlightRef.current,
          distanceFromBottom
        })
      ) {
        // Layout clamps and subsequent tail growth can leave a pinned viewport
        // behind without any user gesture. Preserve app ownership and close
        // that gap; explicit input handlers have already disabled follow.
        snapScrollToBottom(scroller)
      }
      lastTranscriptScrollTopRef.current = nextScrollTop
    }
    const onScroll = () => {
      const nextScrollTop = scroller.scrollTop
      const previousNativeScrollTop = lastNativeScrollTopRef.current
      const expectedProgrammatic = isExpectedProgrammaticScroll({
        expectedScrollTop: programmaticScrollTargetRef.current,
        nextScrollTop
      })
      if (
        shouldRecordScrollbarDownwardIntent({
          pointerActive: scrollbarPointerActiveRef.current,
          isProgrammatic: expectedProgrammatic,
          previousScrollTop: previousNativeScrollTop,
          nextScrollTop
        })
      ) {
        downwardIntentAtRef.current = Date.now()
      } else if (
        shouldClearScrollbarDownwardIntent({
          pointerActive: scrollbarPointerActiveRef.current,
          isProgrammatic: expectedProgrammatic,
          previousScrollTop: previousNativeScrollTop,
          nextScrollTop
        })
      ) {
        downwardIntentAtRef.current = 0
      }
      const hasExplicitScrollAwayIntent = hasExplicitTranscriptScrollAwayIntent({
        userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current,
        scrollbarPointerActive: scrollbarPointerActiveRef.current,
        previousScrollTop: previousNativeScrollTop,
        nextScrollTop
      })
      lastNativeScrollTopRef.current = nextScrollTop
      if (
        hasExplicitScrollAwayIntent &&
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: previousNativeScrollTop,
          nextScrollTop,
          distanceFromBottom: scroller.scrollHeight - nextScrollTop - scroller.clientHeight,
          isProgrammatic: expectedProgrammatic
        })
      ) {
        clearProgrammaticScrollTarget()
        userScrolledAwayInFrameRef.current = true
        setAutoFollow(false)
        jumpInFlightRef.current = false
        downwardIntentAtRef.current = 0
      }
      if (rafId !== null) return
      rafId = requestAnimationFrame(evaluate)
    }
    lastTranscriptScrollTopRef.current = scroller.scrollTop
    lastNativeScrollTopRef.current = scroller.scrollTop
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [chatId, clearProgrammaticScrollTarget, setAutoFollow, snapScrollToBottom])

  useEffect(() => {
    return () => clearProgrammaticScrollTarget()
  }, [clearProgrammaticScrollTarget])

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return

    const handleScrollIntent = (deltaY: number) => {
      if (deltaY !== 0) cancelPendingExternalRestore()
      if (deltaY > 0) {
        // Downward gesture — vouches for the wide re-engage band for a
        // short window (see hasRecentTranscriptDownwardIntent).
        downwardIntentAtRef.current = Date.now()
        return
      }
      if (deltaY >= 0) return
      if (scroller.scrollTop > 0) {
        userScrolledAwayInFrameRef.current = true
        setAutoFollow(false)
        jumpInFlightRef.current = false
        // The user's LAST input is upward — a stale downward flick must not
        // hand the band to this frame's coalesced net movement.
        downwardIntentAtRef.current = 0
      }
    }

    const onWheel = (event: WheelEvent) => handleScrollIntent(event.deltaY)

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const rect = scroller.getBoundingClientRect()
      const direction = getComputedStyle(scroller).direction === 'rtl' ? 'rtl' : 'ltr'
      if (
        !isTranscriptScrollbarPointer({
          clientX: event.clientX,
          rectLeft: rect.left,
          rectRight: rect.right,
          offsetWidth: scroller.offsetWidth,
          clientWidth: scroller.clientWidth,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          direction
        })
      ) {
        return
      }
      scrollbarPointerActiveRef.current = true
      cancelPendingExternalRestore()
      lastNativeScrollTopRef.current = scroller.scrollTop
      // Direction is not known until scrollTop moves. Clear any stale wheel /
      // touch / key voucher so the pointer gesture must earn its own intent.
      downwardIntentAtRef.current = 0
    }
    const endScrollbarPointer = () => {
      scrollbarPointerActiveRef.current = false
    }

    let lastTouchY: number | null = null
    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY ?? null
      if (currentY === null || lastTouchY === null) return
      handleScrollIntent(lastTouchY - currentY)
      lastTouchY = currentY
    }
    const onTouchEnd = () => {
      lastTouchY = null
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTranscriptKeyTarget(event.target)) return
      const target = event.target
      const isNodeTarget = typeof Node !== 'undefined' && target instanceof Node
      if (
        isNodeTarget &&
        target !== document.body &&
        target !== document.documentElement &&
        !scroller.contains(target)
      ) {
        return
      }
      if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
        handleScrollIntent(-1)
        return
      }
      if (event.key === 'PageDown' || event.key === 'ArrowDown') {
        handleScrollIntent(1)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        handleJumpToLatestRef.current()
      }
    }

    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('pointerdown', onPointerDown, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('touchend', onTouchEnd, { passive: true })
    // Ordinary transcript prose is not focusable, so clicking it leaves the
    // document root focused. PageUp/Home still scroll the transcript through
    // the browser's default handling, but a listener bound only to `scroller`
    // never sees that key event and follow remains incorrectly armed. Listen at
    // the window and accept only document-root or transcript-owned targets.
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerup', endScrollbarPointer, { passive: true })
    window.addEventListener('pointercancel', endScrollbarPointer, { passive: true })
    window.addEventListener('blur', endScrollbarPointer)

    return () => {
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerup', endScrollbarPointer)
      window.removeEventListener('pointercancel', endScrollbarPointer)
      window.removeEventListener('blur', endScrollbarPointer)
      scrollbarPointerActiveRef.current = false
    }
  }, [cancelPendingExternalRestore, chatId, setAutoFollow])

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return

    let rafId: number | null = null
    const onCodeBlockResize = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const node = transcriptScrollRef.current
        if (!node) return
        if (disengageIfLiveScrollShowsUserAway(node)) return
        if (
          !shouldRepinAfterCodeBlockResize({
            autoFollow: autoFollowRef.current,
            userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current
          })
        ) {
          return
        }
        snapScrollToBottom(node)
      })
    }

    scroller.addEventListener(CODE_BLOCK_RESIZE_EVENT, onCodeBlockResize)
    return () => {
      scroller.removeEventListener(CODE_BLOCK_RESIZE_EVENT, onCodeBlockResize)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [chatId, disengageIfLiveScrollShowsUserAway, snapScrollToBottom])

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    const content = transcriptContentRef.current
    if (!scroller || !content) return
    if (typeof ResizeObserver === 'undefined') return

    let rafId: number | null = null
    const observer = new ResizeObserver(() => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const node = transcriptScrollRef.current
        if (!node) return
        if (disengageIfLiveScrollShowsUserAway(node)) return
        if (
          !shouldRepinAfterTranscriptResize({
            autoFollow: autoFollowRef.current,
            userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current
          })
        ) {
          return
        }
        snapScrollToBottom(node)
      })
    })

    observer.observe(content)
    return () => {
      observer.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [chatId, disengageIfLiveScrollShowsUserAway, snapScrollToBottom])

  useLayoutEffect(() => {
    const currentMessageCount = messages?.length ?? 0
    const sameChatAsBaseline = previousMessagesCountRef.current.chatId === chatId
    const deltaSinceLastPass = sameChatAsBaseline
      ? currentMessageCount - previousMessagesCountRef.current.count
      : 0
    previousMessagesCountRef.current = {
      chatId,
      count: currentMessageCount
    }
    if (!sameChatAsBaseline && unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
    const incrementUnreadIfNewMessagesArrived = () => {
      if (deltaSinceLastPass <= 0) return
      const next = unreadFromBottomCountRef.current + deltaSinceLastPass
      unreadFromBottomCountRef.current = next
      setUnreadFromBottomCount(next)
    }

    if (!autoFollowRef.current) {
      incrementUnreadIfNewMessagesArrived()
      return
    }
    const scroller = transcriptScrollRef.current
    if (!scroller) return
    if (userScrolledAwayInFrameRef.current) {
      incrementUnreadIfNewMessagesArrived()
      return
    }
    if (disengageIfLiveScrollShowsUserAway(scroller)) {
      incrementUnreadIfNewMessagesArrived()
      return
    }
    userScrolledAwayInFrameRef.current = false
    snapScrollToBottom(scroller)
    repinRafIdRef.current = requestAnimationFrame(() => {
      repinRafIdRef.current = null
      const node = transcriptScrollRef.current
      if (!node) return
      if (disengageIfLiveScrollShowsUserAway(node)) return
      if (
        !shouldRepinAfterFrame({
          autoFollow: autoFollowRef.current,
          userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current
        })
      ) {
        return
      }
      snapScrollToBottom(node)
    })
    return () => {
      if (repinRafIdRef.current !== null) {
        cancelAnimationFrame(repinRafIdRef.current)
        repinRafIdRef.current = null
      }
    }
  }, [chatId, disengageIfLiveScrollShowsUserAway, messages, runCompleteNotice, snapScrollToBottom])

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return
    const hasPendingManualJump = Boolean(chatId && pendingTranscriptJumpChatIdRef.current === chatId)
    const cached = chatId ? chatScrollStateByIdRef.current.get(chatId) : undefined
    let pendingExternalRestoreRecord =
      pendingExternalRestoreRef.current?.targetChatId === chatId
        ? pendingExternalRestoreRef.current
        : undefined
    if (pendingExternalRestoreRecord) {
      const transition = advanceExternalRestoreLifecycle(
        pendingExternalRestoreRecord.lifecycle,
        'chat-switch-observed'
      )
      const nextPending = { ...pendingExternalRestoreRecord, lifecycle: transition.state }
      if (pendingExternalRestoreRef.current?.generation === nextPending.generation) {
        pendingExternalRestoreRef.current = transition.shouldClear ? null : nextPending
      }
      pendingExternalRestoreRecord = nextPending
    }
    const pendingExternalRestore = pendingExternalRestoreRecord?.cached
    const initialPlan = resolveTranscriptChatSwitchPlan({
      cached,
      pendingExternalRestore,
      hasPendingManualJump
    })
    const initialAutoFollow =
      initialPlan.kind === 'latest' ||
      (initialPlan.kind === 'external-restore' && initialPlan.cached.autoFollow)
    setAutoFollow(initialAutoFollow)
    userScrolledAwayInFrameRef.current = !initialAutoFollow
    jumpInFlightRef.current = false
    if (unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
    previousMessagesCountRef.current = {
      chatId,
      count: messages?.length ?? 0
    }
    let cancelRestore = () => {}
    const rafId = requestAnimationFrame(() => {
      const hasStillPendingManualJump = Boolean(
        chatId && pendingTranscriptJumpChatIdRef.current === chatId
      )
      if (hasStillPendingManualJump) {
        pendingTranscriptJumpChatIdRef.current = null
      }
      const plan = resolveTranscriptChatSwitchPlan({
        cached,
        pendingExternalRestore,
        hasPendingManualJump: hasStillPendingManualJump
      })
      if (plan.kind === 'manual-jump') {
        return
      }
      if (plan.kind === 'external-restore') return
      if (plan.kind === 'restore') {
        cancelRestore = restoreChatScrollStateWhenReady(
          () => (committedChatIdRef.current === chatId ? transcriptScrollRef.current : null),
          plan.cached.scrollState,
          8,
          () => committedChatIdRef.current === chatId
        )
        return
      }
      snapScrollToBottom(scroller)
    })
    return () => {
      cancelAnimationFrame(rafId)
      cancelRestore()
    }
    // Chat-switch only: message growth is handled by the message layout effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  return {
    transcriptScrollRef,
    transcriptContentRef,
    autoFollowRef,
    externalRestoreAnchorMessageId:
      externalRestoreAnchorTarget?.targetChatId === chatId
        ? externalRestoreAnchorTarget.messageId
        : null,
    unreadFromBottomCount,
    showJumpToLatestPill: shouldShowJumpToLatestPill({
      autoFollow: autoFollowActive,
      unreadCount: unreadFromBottomCount,
      streamingActive: streamingActive === true
    }),
    handleJumpToLatest,
    relockToLatest,
    markProgrammaticScroll,
    beginManualTranscriptJump,
    prepareMessageJump,
    clearPendingMessageJump,
    prepareChatSwitch,
    captureScrollState,
    restoreScrollStateWhenReady,
    preserveScrollWhile
  }
}
