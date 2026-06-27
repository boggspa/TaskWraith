import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  CODE_BLOCK_RESIZE_EVENT,
  captureChatScrollState,
  restoreChatScrollStateWhenReady,
  shouldDisengageAutoFollow,
  shouldEngageAutoFollow,
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
}

export interface RestoreTranscriptScrollOptions {
  syncAutoFollow?: boolean
}

export function useTranscriptScrollState({
  chatId,
  messages,
  runCompleteNotice
}: UseTranscriptScrollStateInput) {
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const transcriptContentRef = useRef<HTMLDivElement>(null)
  const autoFollowRef = useRef(true)
  const userScrolledAwayInFrameRef = useRef(false)
  const repinRafIdRef = useRef<number | null>(null)
  const lastTranscriptScrollTopRef = useRef(0)
  const programmaticScrollRef = useRef(false)
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
    if (unreadFromBottomCountRef.current !== 0) {
      unreadFromBottomCountRef.current = 0
      setUnreadFromBottomCount(0)
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [])

  const handleJumpToLatestRef = useRef(handleJumpToLatest)
  handleJumpToLatestRef.current = handleJumpToLatest

  const snapScrollToBottom = useCallback((node: HTMLElement) => {
    programmaticScrollRef.current = true
    node.scrollTop = node.scrollHeight
  }, [])

  const beginManualTranscriptJump = useCallback(() => {
    autoFollowRef.current = false
    userScrolledAwayInFrameRef.current = true
    programmaticScrollRef.current = true
    pendingTranscriptJumpChatIdRef.current = null
    if (repinRafIdRef.current !== null) {
      cancelAnimationFrame(repinRafIdRef.current)
      repinRafIdRef.current = null
    }
  }, [])

  const prepareMessageJump = useCallback((targetChatId: string) => {
    pendingTranscriptJumpChatIdRef.current = targetChatId
    autoFollowRef.current = false
    userScrolledAwayInFrameRef.current = true
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
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false
        lastTranscriptScrollTopRef.current = scroller.scrollTop
        return
      }
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      if (shouldEngageAutoFollow(distanceFromBottom)) {
        autoFollowRef.current = true
        userScrolledAwayInFrameRef.current = false
        if (unreadFromBottomCountRef.current !== 0) {
          unreadFromBottomCountRef.current = 0
          setUnreadFromBottomCount(0)
        }
      } else if (shouldDisengageAutoFollow(distanceFromBottom)) {
        autoFollowRef.current = false
      }
      lastTranscriptScrollTopRef.current = scroller.scrollTop
    }
    const onScroll = () => {
      if (
        shouldTreatScrollAsUserScrollAway({
          previousScrollTop: lastTranscriptScrollTopRef.current,
          nextScrollTop: scroller.scrollTop,
          isProgrammatic: programmaticScrollRef.current
        })
      ) {
        userScrolledAwayInFrameRef.current = true
        autoFollowRef.current = false
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
  }, [chatId])

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return

    const handleUpwardIntent = (deltaY: number) => {
      if (deltaY >= 0) return
      if (scroller.scrollTop > 0) {
        userScrolledAwayInFrameRef.current = true
        autoFollowRef.current = false
      }
    }

    const onWheel = (event: WheelEvent) => handleUpwardIntent(event.deltaY)

    let lastTouchY: number | null = null
    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY ?? null
      if (currentY === null || lastTouchY === null) return
      handleUpwardIntent(lastTouchY - currentY)
      lastTouchY = currentY
    }
    const onTouchEnd = () => {
      lastTouchY = null
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
        handleUpwardIntent(-1)
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
  }, [chatId, snapScrollToBottom])

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
  }, [chatId, snapScrollToBottom])

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
    userScrolledAwayInFrameRef.current = false
    snapScrollToBottom(scroller)
    repinRafIdRef.current = requestAnimationFrame(() => {
      repinRafIdRef.current = null
      const node = transcriptScrollRef.current
      if (!node) return
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
  }, [chatId, messages, runCompleteNotice, snapScrollToBottom])

  useEffect(() => {
    const scroller = transcriptScrollRef.current
    if (!scroller) return
    const hasPendingManualJump = Boolean(chatId && pendingTranscriptJumpChatIdRef.current === chatId)
    autoFollowRef.current = !hasPendingManualJump
    userScrolledAwayInFrameRef.current = hasPendingManualJump
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
      unreadCount: unreadFromBottomCount
    }),
    handleJumpToLatest,
    beginManualTranscriptJump,
    prepareMessageJump,
    clearPendingMessageJump,
    captureScrollState,
    restoreScrollStateWhenReady,
    preserveScrollWhile
  }
}
