import { useEffect, useState } from 'react'

export function initialViewportWidth(innerWidth: number | undefined): number {
  return typeof innerWidth === 'number' ? innerWidth : 1280
}

/**
 * Tracks the live window width so callers can clamp panel widths to the
 * viewport on launch / window resize. rAF-coalesced to avoid resize-storm
 * churn. Extracted from App() with behavior preserved.
 */
export function useViewportWidth(): number {
  const [viewportWidth, setViewportWidth] = useState(() =>
    initialViewportWidth(typeof window !== 'undefined' ? window.innerWidth : undefined)
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    let frame = 0
    const onResize = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => setViewportWidth(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return viewportWidth
}