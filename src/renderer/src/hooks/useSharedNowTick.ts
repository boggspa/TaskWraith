import { useCallback, useSyncExternalStore } from 'react'

type TickListener = () => void

const listeners = new Set<TickListener>()
let nowTick = 0
let intervalId: number | undefined

function startTicking(): void {
  if (intervalId !== undefined || typeof window === 'undefined') return
  intervalId = window.setInterval(() => {
    nowTick += 1
    for (const listener of listeners) listener()
  }, 1000)
}

function stopTickingWhenUnused(): void {
  if (listeners.size > 0 || intervalId === undefined) return
  if (typeof window !== 'undefined') window.clearInterval(intervalId)
  intervalId = undefined
}

function subscribeToSharedNowTick(listener: TickListener): () => void {
  listeners.add(listener)
  startTicking()
  return () => {
    listeners.delete(listener)
    stopTickingWhenUnused()
  }
}

function getSharedNowTick(): number {
  return nowTick
}

/**
 * Shares one renderer-wide one-second cadence between lightweight UI consumers.
 * The interval exists only while at least one enabled subscriber is mounted.
 */
export function useSharedNowTick(enabled = true): number {
  const subscribe = useCallback(
    (listener: TickListener) => (enabled ? subscribeToSharedNowTick(listener) : () => undefined),
    [enabled]
  )
  return useSyncExternalStore(subscribe, getSharedNowTick, getSharedNowTick)
}
