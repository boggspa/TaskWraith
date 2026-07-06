import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  CODE_BLOCK_RESIZE_EVENT,
  DOWNWARD_INTENT_WINDOW_MS,
  STICK_ENGAGE_PX,
  captureChatScrollState,
  expectedBottomScrollTop,
  isExpectedProgrammaticScroll,
  restoreChatScrollStateWhenReady,
  shouldAbortAutoFollowSnap,
  shouldDisengageAutoFollow,
  shouldReengageAutoFollowAfterScroll,
  shouldRepinAfterCodeBlockResize,
  shouldRepinAfterFrame,
  shouldRepinAfterTranscriptResize,
  shouldShowJumpToLatestPill,
  shouldSnapAfterChatSwitch,
  shouldTreatScrollAsUserScrollAway,
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
  const userScrolledAwayInFrameRef = useRef(false)
  // True from a jump-to-latest click until the scroll arrives at the live
  // edge (or the user cancels with an upward gesture). The smooth-scroll
  // flight passes through positions far from the bottom; without this the
  // rAF evaluate's positional disengage would kill the follow the click
  // just armed, and a mid-flight content growth would strand the jump short
  // of the bottom with the pill re-appearing.
  const jumpInFlightRef = useRef(false)
  // Timestamp of the last downward wheel/touch/key gesture; zeroed by any
  // upward gesture or scroll-away. Vouches for the wide re-engage band
  // (STICK_REENGAGE_DOWNWARD_PX) — scroll events alone can't distinguish a
  // real downward return from an unarmed restore write or a coalesced frame
  // whose last input was upward.
  const downwardIntentAtRef = useRef(0)
  const repinRafIdRef = useRef<number | null>(null)
  const lastTranscriptScrollTopRef = useRef(0)
  const programmaticScrollTargetRef = useRef<number | null>(null)
  const programmaticScrollClearRafRef = useRef<number | null>(null)
  const [unreadFromBottomCount, setUnreadFromBottomCount] = useState(0)
  const unreadFromBottomCountRef = useRef(0)
  const previousMessagesCountRef = useRef<{ chatId: string | null; count: number }>({
    chatId: null,
    count: 0
  })
  const pendingTranscriptJumpChatIdRef = useRef<string | null>(null)

  const captureScrollState = useCallback(
    () => captureChatScrollState(transcriptScrollRef.current),
    []
  )

  const restoreScrollStateWhenReady = useCallback(
    (
      scrollState: ChatScrollState | undefined,
      options: RestoreTranscriptScrollOptions = {}
    ) => {
      if (scrollState && options.syncAutoFollow) {
        autoFollowRef.current = scrollState.atBottom
      }
      restoreChatScrollStateWhenReady(() => transcriptScrollRef.current, scrollState)
    },
    []
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
    autoFollowRef.current = true
    userScrolledAwayInFrameRef.current = false
    jumpInFlightRef.current = true
    if (unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [])

  // Arm follow without a scroll of its own — for gestures where the NEXT
  // messages layout-effect snap should carry the viewport down (sending a
  // prompt while scrolled up: the reply belongs to the user's action, so the
  // transcript re-locks to the live edge exactly like Claude/Codex do).
  const relockToLatest = useCallback(() => {
    autoFollowRef.current = true
    userScrolledAwayInFrameRef.current = false
    jumpInFlightRef.current = false
    pendingTranscriptJumpChatIdRef.current = null
    if (unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
  }, [])

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
          currentScrollTop: nextScrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          expectedProgrammaticScrollTop: programmaticScrollTargetRef.current
        })
      ) {
        return false
      }
      clearProgrammaticScrollTarget()
      autoFollowRef.current = false
      userScrolledAwayInFrameRef.current = true
      jumpInFlightRef.current = false
      downwardIntentAtRef.current = 0
      lastTranscriptScrollTopRef.current = nextScrollTop
      return true
    },
    [clearProgrammaticScrollTarget]
  )

  const beginManualTranscriptJump = useCallback(() => {
    autoFollowRef.current = false
    userScrolledAwayInFrameRef.current = true
    jumpInFlightRef.current = false
    clearProgrammaticScrollTarget()
    pendingTranscriptJumpChatIdRef.current = null
    if (repinRafIdRef.current !== null) {
      cancelAnimationFrame(repinRafIdRef.current)
      repinRafIdRef.current = null
    }
  }, [clearProgrammaticScrollTarget])

  const prepareMessageJump = useCallback((targetChatId: string) => {
    pendingTranscriptJumpChatIdRef.current = targetChatId
    autoFollowRef.current = false
    userScrolledAwayInFrameRef.current = true
    jumpInFlightRef.current = false
  }, [])

  const clearPendingMessageJump = useCallback(() => {
    pendingTranscriptJumpChatIdRef.current = null
  }, [])

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
          userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current,
          previousScrollTop,
          nextScrollTop,
          isProgrammatic: false,
          recentDownwardIntent:
            Date.now() - downwardIntentAtRef.current < DOWNWARD_INTENT_WINDOW_MS
        })
      ) {
        autoFollowRef.current = true
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
      } else if (!jumpInFlightRef.current && shouldDisengageAutoFollow(distanceFromBottom)) {
        // Positional disengage — suppressed while a jump-to-latest flight
        // owns the descent (its intermediate positions are far from the
        // bottom by construction; user gestures cancel the flight via the
        // intent/scroll-away paths below and re-enable this branch).
        autoFollowRef.current = false
      }
      lastTranscriptScrollTopRef.current = nextScrollTop
    }
    const onScroll = () => {
      const nextScrollTop = scroller.scrollTop
      const expectedProgrammatic = isExpectedProgrammaticScroll({
        expectedScrollTop: programmaticScrollTargetRef.current,
        nextScrollTop
      })
      if (
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: lastTranscriptScrollTopRef.current,
          nextScrollTop,
          distanceFromBottom: scroller.scrollHeight - nextScrollTop - scroller.clientHeight,
          isProgrammatic: expectedProgrammatic
        })
      ) {
        clearProgrammaticScrollTarget()
        userScrolledAwayInFrameRef.current = true
        autoFollowRef.current = false
        jumpInFlightRef.current = false
        downwardIntentAtRef.current = 0
      }
      if (rafId !== null) return
      rafId = requestAnimationFrame(evaluate)
    }
    lastTranscriptScrollTopRef.current = scroller.scrollTop
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [chatId, clearProgrammaticScrollTarget, snapScrollToBottom])

  useEffect(() => {
    return () => clearProgrammaticScrollTarget()
  }, [clearProgrammaticScrollTarget])

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return

    const handleScrollIntent = (deltaY: number) => {
      if (deltaY > 0) {
        // Downward gesture — vouches for the wide re-engage band for a
        // short window (see DOWNWARD_INTENT_WINDOW_MS).
        downwardIntentAtRef.current = Date.now()
        return
      }
      if (deltaY >= 0) return
      if (scroller.scrollTop > 0) {
        userScrolledAwayInFrameRef.current = true
        autoFollowRef.current = false
        jumpInFlightRef.current = false
        // The user's LAST input is upward — a stale downward flick must not
        // hand the band to this frame's coalesced net movement.
        downwardIntentAtRef.current = 0
      }
    }

    const onWheel = (event: WheelEvent) => handleScrollIntent(event.deltaY)

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
      if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
        handleScrollIntent(-1)
        return
      }
      if (event.key === 'PageDown' || event.key === 'ArrowDown') {
        handleScrollIntent(1)
        return
      }
      if (event.key === 'End') {
        const focused = event.target as Element | null
        const isEditable =
          focused instanceof HTMLInputElement ||
          focused instanceof HTMLTextAreaElement ||
          (focused instanceof HTMLElement && focused.isContentEditable)
        if (!isEditable) {
          event.preventDefault()
          handleJumpToLatestRef.current()
        }
      }
    }

    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('touchend', onTouchEnd, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)

    return () => {
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      scroller.removeEventListener('keydown', onKeyDown)
    }
  }, [chatId])

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
    autoFollowRef.current = !hasPendingManualJump
    userScrolledAwayInFrameRef.current = hasPendingManualJump
    jumpInFlightRef.current = false
    if (unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
    previousMessagesCountRef.current = {
      chatId,
      count: messages?.length ?? 0
    }
    const rafId = requestAnimationFrame(() => {
      const hasStillPendingManualJump = Boolean(
        chatId && pendingTranscriptJumpChatIdRef.current === chatId
      )
      if (hasStillPendingManualJump) {
        pendingTranscriptJumpChatIdRef.current = null
      }
      if (
        !shouldSnapAfterChatSwitch({
          autoFollow: autoFollowRef.current,
          userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current,
          hasPendingManualJump: hasStillPendingManualJump
        })
      ) {
        return
      }
      snapScrollToBottom(scroller)
    })
    return () => cancelAnimationFrame(rafId)
    // Chat-switch only: message growth is handled by the message layout effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  return {
    transcriptScrollRef,
    transcriptContentRef,
    autoFollowRef,
    unreadFromBottomCount,
    showJumpToLatestPill: shouldShowJumpToLatestPill({
      autoFollow: autoFollowRef.current,
      unreadCount: unreadFromBottomCount,
      streamingActive: streamingActive === true
    }),
    handleJumpToLatest,
    relockToLatest,
    markProgrammaticScroll,
    beginManualTranscriptJump,
    prepareMessageJump,
    clearPendingMessageJump,
    captureScrollState,
    restoreScrollStateWhenReady,
    preserveScrollWhile
  }
}
