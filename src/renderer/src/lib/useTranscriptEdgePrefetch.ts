import { useEffect, type RefObject } from 'react'

export type TranscriptPrefetchDirection = 'older' | 'newer'

export interface TranscriptEdgePrefetchState {
  hasOlder: boolean
  hasNewer: boolean
  nearOlder: boolean
  nearNewer: boolean
  following: boolean
}

/** A mounted overscan band can include both ends of thousands of folded rows.
 * Only the reader's actual position authorizes automatic page movement. */
export function transcriptEdgePrefetchDirection({
  scrollTop,
  scrollHeight,
  clientHeight,
  intent = null,
  ...state
}: TranscriptEdgePrefetchState & {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  intent?: TranscriptPrefetchDirection | null
}): TranscriptPrefetchDirection | null {
  if (clientHeight <= 0) return null
  const range = Math.max(0, scrollHeight - clientHeight)
  if (range <= 1) {
    // A short, folded window has no scroll direction. A wheel gesture may
    // request one page, but its arrival must not start an automatic refill.
    if (intent === 'older' && state.hasOlder) return 'older'
    if (intent === 'newer' && state.hasNewer) return 'newer'
    return null
  }
  const top = Math.max(0, Math.min(range, scrollTop))
  // Disjoint edge zones, even when the entire loaded window is mounted.
  const threshold = Math.min(320, range / 3)
  if (!state.following && state.hasOlder && state.nearOlder && top <= threshold) return 'older'
  if (state.hasNewer && state.nearNewer && range - top <= threshold) return 'newer'
  return null
}

/** Coalesce page selection until layout has settled. Store publication can be
 * synchronous, so loading from React's effect flush can otherwise recurse
 * through newly mounted activity viewports before a browser frame occurs. */
export function observeTranscriptEdgePrefetch({
  scroller,
  readState,
  load,
  requestFrame,
  cancelFrame
}: {
  scroller: HTMLDivElement
  readState: () => TranscriptEdgePrefetchState
  load: (direction: TranscriptPrefetchDirection) => void
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (frame: number) => void
}): () => void {
  let frame: number | null = null
  let intent: TranscriptPrefetchDirection | null = null
  let intentTarget: HTMLElement | null = null
  const schedule = (): void => {
    if (frame !== null) return
    frame = requestFrame(() => {
      frame = null
      const scrollTop = scroller.scrollTop
      const scrollHeight = scroller.scrollHeight
      const clientHeight = scroller.clientHeight
      if (intent && scrollHeight - clientHeight <= 1) {
        // An inner activity viewport owns its gesture. Defer these layout
        // reads to the coalesced frame; ordinary wheel handlers stay cheap.
        for (let node = intentTarget; node && node !== scroller; node = node.parentElement) {
          if (
            node.scrollHeight > node.clientHeight + 1 &&
            /auto|scroll/.test(getComputedStyle(node).overflowY)
          ) {
            intent = null
            break
          }
        }
      }
      const direction = transcriptEdgePrefetchDirection({
        ...readState(),
        scrollTop,
        scrollHeight,
        clientHeight,
        intent
      })
      intent = null
      intentTarget = null
      if (direction) load(direction)
    })
  }
  const onWheel = (event: WheelEvent): void => {
    if (!event.deltaY || event.ctrlKey) return
    intent = event.deltaY < 0 ? 'older' : 'newer'
    intentTarget = event.target as HTMLElement | null
    schedule()
  }
  scroller.addEventListener('scroll', schedule, { passive: true })
  scroller.addEventListener('wheel', onWheel, { passive: true })
  schedule()
  return () => {
    scroller.removeEventListener('scroll', schedule)
    scroller.removeEventListener('wheel', onWheel)
    if (frame !== null) cancelFrame(frame)
  }
}

export function useTranscriptEdgePrefetch({
  enabled,
  scrollRef,
  autoFollowRef,
  hasOlder,
  hasNewer,
  nearOlder,
  nearNewer,
  windowStart,
  windowEnd,
  load
}: Omit<TranscriptEdgePrefetchState, 'following'> & {
  enabled: boolean
  scrollRef: RefObject<HTMLDivElement | null>
  autoFollowRef?: RefObject<boolean>
  windowStart: number
  windowEnd: number
  load: (direction: TranscriptPrefetchDirection) => void
}): void {
  useEffect(() => {
    const scroller = scrollRef.current
    if (!enabled || !scroller) return
    return observeTranscriptEdgePrefetch({
      scroller,
      readState: () => ({
        hasOlder,
        hasNewer,
        nearOlder,
        nearNewer,
        following: autoFollowRef?.current === true
      }),
      load,
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (frame) => window.cancelAnimationFrame(frame)
    })
  }, [
    enabled,
    scrollRef,
    autoFollowRef,
    hasOlder,
    hasNewer,
    nearOlder,
    nearNewer,
    windowStart,
    windowEnd,
    load
  ])
}
