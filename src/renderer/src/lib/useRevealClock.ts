import { useEffect, useRef } from 'react'

/*
 * useRevealClock — one shared, ref-counted requestAnimationFrame that fans out
 * a per-frame dt to every active reveal. A single rAF drives all live bubbles
 * (multiview: up to 4) and SELF-STOPS when the last subscriber leaves, so there
 * is no idle rAF burning battery when nothing is streaming.
 */

type RevealTick = (dt: number) => void

const subscribers = new Set<RevealTick>()
let rafId: number | null = null
let lastTs = 0

function frame(ts: number): void {
  const dt = lastTs ? (ts - lastTs) / 1000 : 1 / 60
  lastTs = ts
  // Snapshot so a subscriber that unsubscribes mid-tick can't mutate the set
  // we're iterating, and one throwing subscriber can't kill the shared clock.
  for (const cb of Array.from(subscribers)) {
    try {
      cb(dt)
    } catch {
      /* isolate */
    }
  }
  if (subscribers.size > 0 && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(frame)
  } else {
    rafId = null
    lastTs = 0
  }
}

function subscribeRevealClock(cb: RevealTick): () => void {
  subscribers.add(cb)
  if (rafId === null && typeof requestAnimationFrame === 'function') {
    lastTs = 0
    rafId = requestAnimationFrame(frame)
  }
  return () => {
    subscribers.delete(cb)
    if (subscribers.size === 0 && rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
      lastTs = 0
    }
  }
}

/** Run `cb(dt)` on the shared reveal clock while `active`. */
export function useRevealClock(cb: RevealTick, active: boolean): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    if (!active) return
    return subscribeRevealClock((dt) => cbRef.current(dt))
  }, [active])
}
