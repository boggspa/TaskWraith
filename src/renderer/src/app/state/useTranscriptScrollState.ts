import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'

import {
  LIVE_EDGE_PROXIMITY_PX,
  STICK_ENGAGE_PX,
  advanceExternalRestoreLifecycle,
  captureChatScrollState,
  countJumpToLatestCountableMessages,
  createFollowPinScheduler,
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
  shouldRepinAfterFrame,
  shouldRepinAfterScrollEvaluation,
  shouldRecordScrollbarDownwardIntent,
  shouldClearScrollbarDownwardIntent,
  shouldShowJumpToLatestPill,
  shouldTreatUnclassifiedNativeScrollAsUserScrollAway,
  shouldTreatScrollAsUserScrollAway,
  type CachedChatScrollState,
  type ChatScrollState
} from '../../lib/TranscriptScroll'

interface UseTranscriptScrollStateBaseInput {
  chatId: string | null
  messages: readonly unknown[] | undefined
  runCompleteNotice: unknown
  /** Whether the transcript DOM is mounted. Welcome panes mount it only after
   * their first message, without changing chatId. Including this lifecycle in
   * DOM-binding effects prevents those panes from permanently missing scroll
   * and intent listeners. */
  transcriptMounted?: boolean
  /** True while a run is streaming into this chat — keeps the
   *  jump-to-latest pill visible when follow is off even though text growth
   *  inside one bubble never bumps the message-count-based unread number. */
  streamingActive?: boolean
  /** Optional pane-owned refs. Stable Multiview panes supply these so their
   * reader position and follow ownership survive transcript remounts. */
  transcriptScrollRef?: RefObject<HTMLDivElement | null>
  transcriptContentRef?: RefObject<HTMLDivElement | null>
  chatScrollStateByIdRef?: MutableRefObject<Map<string, CachedChatScrollState>>
}

/** When a pane supplies its persistent latch it must also supply the owner
 * setter. The hook keeps synchronous reads on the same ref without mutating
 * an object received through its input boundary. */
export type UseTranscriptScrollStateInput = UseTranscriptScrollStateBaseInput &
  (
    | { autoFollowRef?: undefined; setAutoFollowRef?: undefined }
    | {
        autoFollowRef: MutableRefObject<boolean>
        setAutoFollowRef: (next: boolean) => void
      }
  )

export interface RestoreTranscriptScrollOptions {
  syncAutoFollow?: boolean
  targetChatId?: string | null
  /** Geometry's loose bottom band is not equivalent to ownership. Surface
   * transfers can preserve the source's exact follow latch here. */
  autoFollow?: boolean
}

export function useTranscriptScrollState({
  chatId,
  messages,
  runCompleteNotice,
  transcriptMounted = true,
  streamingActive,
  transcriptScrollRef: providedTranscriptScrollRef,
  transcriptContentRef: providedTranscriptContentRef,
  autoFollowRef: providedAutoFollowRef,
  setAutoFollowRef: providedSetAutoFollowRef,
  chatScrollStateByIdRef: providedChatScrollStateByIdRef
}: UseTranscriptScrollStateInput) {
  const ownedTranscriptScrollRef = useRef<HTMLDivElement>(null)
  const ownedTranscriptContentRef = useRef<HTMLDivElement>(null)
  const ownedAutoFollowRef = useRef(true)
  const transcriptScrollRef = providedTranscriptScrollRef ?? ownedTranscriptScrollRef
  const transcriptContentRef = providedTranscriptContentRef ?? ownedTranscriptContentRef
  const autoFollowRef = providedAutoFollowRef ?? ownedAutoFollowRef
  const initialAutoFollow = autoFollowRef.current
  const [autoFollowActive, setAutoFollowActive] = useState(initialAutoFollow)
  const publishedAutoFollowRef = useRef(initialAutoFollow)
  const setAutoFollow = useCallback((next: boolean) => {
    if (providedSetAutoFollowRef) {
      providedSetAutoFollowRef(next)
    } else {
      ownedAutoFollowRef.current = next
    }
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
  }, [providedAutoFollowRef, providedSetAutoFollowRef])
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
  // Phase E — single outer follow-pin owner. Messages-layout trailing re-pin,
  // content ResizeObserver, and scroll-evaluate gap-close share one rAF slot.
  const followPinApplyRef = useRef<() => void>(() => {})
  const followPinSchedulerRef = useRef<ReturnType<typeof createFollowPinScheduler> | null>(null)
  if (followPinSchedulerRef.current === null) {
    followPinSchedulerRef.current = createFollowPinScheduler({
      apply: () => followPinApplyRef.current()
    })
  }
  const followPinScheduler = followPinSchedulerRef.current
  const lastTranscriptScrollTopRef = useRef(0)
  // Updated for every native `scroll` event (not just the coalesced rAF) so a
  // scrollbar drag that reverses within one frame clears its downward voucher.
  const lastNativeScrollTopRef = useRef(0)
  // Keep the geometry that accompanied the last native scroll sample. Chromium
  // may apply a scrollbar thumb/track drag without surfacing a wheel or
  // pointer event to the content element; comparing these metrics lets the
  // scroll listener distinguish that reader action from a browser clamp after
  // content shrink or viewport growth.
  const lastNativeScrollHeightRef = useRef(0)
  const lastNativeClientHeightRef = useRef(0)
  const programmaticScrollTargetRef = useRef<number | null>(null)
  const programmaticScrollClearRafRef = useRef<number | null>(null)
  const [unreadFromBottomCount, setUnreadFromBottomCount] = useState(0)
  const [externalRestoreAnchorTarget, setExternalRestoreAnchorTarget] = useState<{
    generation: number
    targetChatId: string | null
    messageId: string
  } | null>(null)
  // Whether the viewport is genuinely above the live-edge band. Follow
  // ownership alone cannot answer this: shrink clamps and contained
  // live-activity viewports leave follow off while the reader still sees the
  // scroller's bottom, and a pill shown there jumps nowhere. Synced from live
  // geometry at every seam that can move it (scroll evaluate, content resize,
  // message layout, chat switch).
  const [awayFromLiveEdge, setAwayFromLiveEdge] = useState(false)
  const unreadFromBottomCountRef = useRef(0)
  const awayFromLiveEdgeRef = useRef(false)
  const previousMessagesCountRef = useRef<{ chatId: string | null; count: number }>({
    chatId: null,
    count: 0
  })
  const pendingTranscriptJumpChatIdRef = useRef<string | null>(null)
  const ownedChatScrollStateByIdRef = useRef<Map<string, CachedChatScrollState>>(new Map())
  const chatScrollStateByIdRef = providedChatScrollStateByIdRef ?? ownedChatScrollStateByIdRef
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
    [transcriptScrollRef]
  )

  // Capture the outgoing chat before this transcript DOM is rebound or removed.
  // Main navigation also calls prepareChatSwitch synchronously; this cleanup is
  // what gives independently-mounted Multiview panes the same guarantee.
  useLayoutEffect(() => {
    const sourceChatId = chatId
    return () => {
      if (!sourceChatId) return
      const scrollState = captureScrollState()
      if (!scrollState) return
      chatScrollStateByIdRef.current.set(sourceChatId, {
        scrollState,
        autoFollow: autoFollowRef.current
      })
    }
  }, [autoFollowRef, captureScrollState, chatId, chatScrollStateByIdRef])

  const restoreScrollStateWhenReady = useCallback(
    (
      scrollState: ChatScrollState | undefined,
      options: RestoreTranscriptScrollOptions = {}
    ) => {
      const restoreState =
        scrollState && options.autoFollow !== undefined
          ? { ...scrollState, atBottom: options.autoFollow }
          : scrollState
      const targetChatId = options.targetChatId ?? committedChatIdRef.current
      const generation = externalRestoreGenerationRef.current + 1
      externalRestoreGenerationRef.current = generation
      pendingExternalRestoreRef.current = restoreState
        ? {
            generation,
            targetChatId,
            cached: {
              scrollState: restoreState,
              autoFollow: options.autoFollow ?? restoreState.atBottom
            },
            lifecycle: {
              settled: false,
              chatSwitchObserved: committedChatIdRef.current === targetChatId
            }
          }
        : null
      setExternalRestoreAnchorTarget(
        restoreState?.anchorMessageId
          ? { generation, targetChatId, messageId: restoreState.anchorMessageId }
          : null
      )
      let ownershipSynced = false
      const cancel = restoreChatScrollStateWhenReady(
        () => {
          if (committedChatIdRef.current !== targetChatId) return null
          const scroller = transcriptScrollRef.current
          if (scroller && options.syncAutoFollow && !ownershipSynced && restoreState) {
            ownershipSynced = true
            const restoredAutoFollow = options.autoFollow ?? restoreState.atBottom
            setAutoFollow(restoredAutoFollow)
            userScrolledAwayInFrameRef.current = !restoredAutoFollow
          }
          return scroller
        },
        restoreState,
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

  // Re-derive `awayFromLiveEdge` from live scroller geometry. Reaching the
  // band also clears the unread tally: at the live edge everything below the
  // fold has been seen, and a count held past that point would resurface as a
  // stale pill the next time content grows. Idempotent and cheap, so every
  // geometry seam calls it unconditionally.
  const syncLiveEdgeProximity = useCallback(
    (scroller?: HTMLElement | null) => {
      const node = scroller ?? transcriptScrollRef.current
      if (!node) return
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      if (!Number.isFinite(distanceFromBottom)) return
      const away = distanceFromBottom > LIVE_EDGE_PROXIMITY_PX
      if (!away && unreadFromBottomCountRef.current !== 0) {
        unreadFromBottomCountRef.current = 0
        setUnreadFromBottomCount(0)
      }
      if (awayFromLiveEdgeRef.current !== away) {
        awayFromLiveEdgeRef.current = away
        setAwayFromLiveEdge(away)
      }
    },
    [transcriptScrollRef]
  )

  const disengageIfLiveScrollShowsUserAway = useCallback(
    (scroller: HTMLElement): boolean => {
      const nextScrollTop = scroller.scrollTop
      const hasExplicitScrollAwayIntent = hasExplicitTranscriptScrollAwayIntent({
        userScrolledAwayInThisFrame: userScrolledAwayInFrameRef.current,
        scrollbarPointerActive: scrollbarPointerActiveRef.current,
        previousScrollTop: lastNativeScrollTopRef.current,
        nextScrollTop
      })
      const hasUnclassifiedNativeScrollAwayIntent =
        !hasExplicitScrollAwayIntent &&
        shouldTreatUnclassifiedNativeScrollAsUserScrollAway({
          previousScrollTop: lastNativeScrollTopRef.current,
          nextScrollTop,
          previousScrollHeight: lastNativeScrollHeightRef.current,
          nextScrollHeight: scroller.scrollHeight,
          previousClientHeight: lastNativeClientHeightRef.current,
          nextClientHeight: scroller.clientHeight,
          isProgrammatic: isExpectedProgrammaticScroll({
            expectedScrollTop: programmaticScrollTargetRef.current,
            nextScrollTop
          })
        })
      if (
        !shouldAbortAutoFollowSnap({
          lastRecordedScrollTop: lastTranscriptScrollTopRef.current,
          lastNativeScrollTop: lastNativeScrollTopRef.current,
          currentScrollTop: nextScrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          expectedProgrammaticScrollTop: programmaticScrollTargetRef.current,
          hasExplicitScrollAwayIntent:
            hasExplicitScrollAwayIntent || hasUnclassifiedNativeScrollAwayIntent
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
      lastNativeScrollHeightRef.current = scroller.scrollHeight
      lastNativeClientHeightRef.current = scroller.clientHeight
      return true
    },
    [clearProgrammaticScrollTarget, setAutoFollow]
  )

  // Sole gated writer for coalesced follow pins. Callers request via
  // `followPinScheduler` rather than snapping from each geometry seam.
  // Proximity sync runs even when follow is off so content growth below a
  // stationary reader still flips the jump-pill away-gate.
  followPinApplyRef.current = () => {
    const node = transcriptScrollRef.current
    if (!node) return
    syncLiveEdgeProximity(node)
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
    syncLiveEdgeProximity(node)
  }

  const beginManualTranscriptJump = useCallback(() => {
    cancelPendingExternalRestore()
    setAutoFollow(false)
    userScrolledAwayInFrameRef.current = true
    jumpInFlightRef.current = false
    clearProgrammaticScrollTarget()
    pendingTranscriptJumpChatIdRef.current = null
    followPinScheduler.cancel()
  }, [cancelPendingExternalRestore, clearProgrammaticScrollTarget, followPinScheduler, setAutoFollow])

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
    if (!transcriptMounted) return
    const scroller = transcriptScrollRef.current
    if (!scroller) return

    let rafId: number | null = null
    const evaluate = () => {
      rafId = null
      const previousScrollTop = lastTranscriptScrollTopRef.current
      const nextScrollTop = scroller.scrollTop
      const distanceFromBottom = scroller.scrollHeight - nextScrollTop - scroller.clientHeight
      // Every scroll — user, clamp, or programmatic — can move the viewport
      // across the live-edge band; keep the pill's proximity gate current
      // before any of the early returns below.
      syncLiveEdgeProximity(scroller)
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
        // behind without any user gesture. Prefer a pending coalesced pin
        // (layout trailing / content RO); otherwise flush now — evaluate
        // already runs inside its own rAF, so deferring would add a frame.
        if (!followPinScheduler.isPending()) {
          followPinApplyRef.current()
        }
      }
      lastTranscriptScrollTopRef.current = nextScrollTop
    }
    const onScroll = () => {
      const nextScrollTop = scroller.scrollTop
      const previousNativeScrollTop = lastNativeScrollTopRef.current
      const nextScrollHeight = scroller.scrollHeight
      const nextClientHeight = scroller.clientHeight
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
      const hasNativeScrollbarScrollAwayIntent =
        !hasExplicitScrollAwayIntent &&
        shouldTreatUnclassifiedNativeScrollAsUserScrollAway({
          previousScrollTop: previousNativeScrollTop,
          nextScrollTop,
          previousScrollHeight: lastNativeScrollHeightRef.current,
          nextScrollHeight,
          previousClientHeight: lastNativeClientHeightRef.current,
          nextClientHeight,
          isProgrammatic: expectedProgrammatic
        })
      lastNativeScrollTopRef.current = nextScrollTop
      lastNativeScrollHeightRef.current = nextScrollHeight
      lastNativeClientHeightRef.current = nextClientHeight
      if (
        (hasExplicitScrollAwayIntent || hasNativeScrollbarScrollAwayIntent) &&
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: previousNativeScrollTop,
          nextScrollTop,
          distanceFromBottom: nextScrollHeight - nextScrollTop - nextClientHeight,
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
    lastNativeScrollHeightRef.current = scroller.scrollHeight
    lastNativeClientHeightRef.current = scroller.clientHeight
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [
    chatId,
    clearProgrammaticScrollTarget,
    followPinScheduler,
    setAutoFollow,
    snapScrollToBottom,
    syncLiveEdgeProximity,
    transcriptMounted
  ])

  useEffect(() => {
    return () => clearProgrammaticScrollTarget()
  }, [clearProgrammaticScrollTarget])

  useEffect(() => {
    if (!transcriptMounted) return
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
  }, [cancelPendingExternalRestore, chatId, setAutoFollow, transcriptMounted])

  useEffect(() => {
    if (!transcriptMounted) return
    const scroller = transcriptScrollRef.current
    const content = transcriptContentRef.current
    if (!scroller || !content) return
    if (typeof ResizeObserver === 'undefined') return

    // Phase E — content RO is the sole geometry growth observer for the outer
    // transcript (code-block resize events retired). Pins and proximity sync
    // share the coalesced follow-pin slot with layout trailing / evaluate.
    const observer = new ResizeObserver(() => {
      followPinScheduler.schedule()
    })

    observer.observe(content)
    return () => {
      observer.disconnect()
    }
  }, [chatId, followPinScheduler, transcriptMounted])

  useLayoutEffect(() => {
    // Both the baseline and the delta count only conversational messages
    // (user/assistant/error bubbles, guest replies, attention cards). Raw
    // array length also grows for every tool batch and system lifecycle row a
    // run appends — machinery that renders inside existing stack rows'
    // contained viewports — which inflated the pill to "44 new messages"
    // while nothing new existed below the reader.
    const currentMessageCount = countJumpToLatestCountableMessages(messages)
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
      // Layout has already committed the new rows — read the resulting
      // geometry so the pill's proximity gate reflects this very update
      // (and an increment that landed while the reader still sees the live
      // edge is immediately cleared instead of surfacing as a phantom pill).
      syncLiveEdgeProximity()
      return
    }
    const scroller = transcriptScrollRef.current
    if (!scroller) return
    if (userScrolledAwayInFrameRef.current) {
      incrementUnreadIfNewMessagesArrived()
      syncLiveEdgeProximity(scroller)
      return
    }
    if (disengageIfLiveScrollShowsUserAway(scroller)) {
      incrementUnreadIfNewMessagesArrived()
      syncLiveEdgeProximity(scroller)
      return
    }
    userScrolledAwayInFrameRef.current = false
    // Pre-paint pin + one coalesced trailing rAF (shared with content RO /
    // evaluate gap-close). `snapScrollToBottom` remains the only scrollTop
    // write API; the scheduler owns when follow-mode seams may call it.
    followPinScheduler.pinNowAndScheduleTrailing()
    return () => {
      followPinScheduler.cancel()
    }
  }, [
    chatId,
    disengageIfLiveScrollShowsUserAway,
    followPinScheduler,
    messages,
    runCompleteNotice,
    syncLiveEdgeProximity
  ])

  useEffect(() => {
    if (!transcriptMounted) return
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
    // Same countable metric as the message layout effect — a raw-length
    // baseline here would poison every unread delta until the counts happened
    // to re-align.
    previousMessagesCountRef.current = {
      chatId,
      count: countJumpToLatestCountableMessages(messages)
    }
    // Restore/snap writes below re-sync through their scroll events; this
    // covers the degenerate paths that never move scrollTop (short chats,
    // landing geometry identical to the previous chat's).
    syncLiveEdgeProximity(scroller)
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
  }, [chatId, transcriptMounted])

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
      streamingActive: streamingActive === true,
      awayFromLiveEdge
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
