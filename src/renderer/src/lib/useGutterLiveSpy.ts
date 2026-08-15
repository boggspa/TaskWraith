import { useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  shouldAcceptGutterLiveSpy,
  structuralGutterSpyPropsChanged,
  type StructuralGutterSpyProps
} from './TranscriptUserMessageGutter'
import type { TranscriptScrollSpy } from './TranscriptVirtualWindow'

interface GutterLiveSpyLatch {
  snapshot: TranscriptScrollSpy
  structuralProps: StructuralGutterSpyProps
}

/**
 * Arbitrates the gutter's per-frame spy without scheduling a passive state
 * clear when TranscriptPanel publishes fresher structural values.
 *
 * A live snapshot is tagged with the structural props current when it arrived.
 * A later parent render invalidates that snapshot declaratively, so structural
 * values win immediately without another commit. The next sink tick can then
 * latch again, even when its scroll values happen to equal the stale snapshot.
 */
export function useGutterLiveSpy(
  spySinkRef: MutableRefObject<((snapshot: TranscriptScrollSpy) => void) | null> | undefined,
  structuralProps: StructuralGutterSpyProps
): TranscriptScrollSpy | null {
  const currentStructuralProps = useMemo(
    () => ({
      scrollProgress: structuralProps.scrollProgress,
      scrollViewportFraction: structuralProps.scrollViewportFraction,
      activeScrollRowKey: structuralProps.activeScrollRowKey
    }),
    [
      structuralProps.activeScrollRowKey,
      structuralProps.scrollProgress,
      structuralProps.scrollViewportFraction
    ]
  )
  const structuralPropsRef = useRef(currentStructuralProps)
  const [latch, setLatch] = useState<GutterLiveSpyLatch | null>(null)

  useLayoutEffect(() => {
    structuralPropsRef.current = currentStructuralProps
  }, [currentStructuralProps])

  useLayoutEffect(() => {
    if (!spySinkRef) return
    spySinkRef.current = (snapshot) => {
      const structuralPropsAtCapture = structuralPropsRef.current
      setLatch((previous) => {
        const previousSnapshot =
          previous &&
          !structuralGutterSpyPropsChanged(previous.structuralProps, structuralPropsAtCapture)
            ? previous.snapshot
            : null
        if (!shouldAcceptGutterLiveSpy(previousSnapshot, snapshot)) return previous
        return { snapshot, structuralProps: structuralPropsAtCapture }
      })
    }
    return () => {
      spySinkRef.current = null
    }
  }, [spySinkRef])

  if (!latch || structuralGutterSpyPropsChanged(latch.structuralProps, currentStructuralProps)) {
    return null
  }
  return latch.snapshot
}
