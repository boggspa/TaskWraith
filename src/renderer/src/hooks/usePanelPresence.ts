import { useEffect, useRef, useState } from 'react'

/**
 * Shared renderer timing mirrors the CSS motion tokens. CSS owns the visual
 * timing; these values only keep an exiting React subtree mounted until that
 * transition has completed.
 */
export const MOTION_DURATIONS = {
  fast: 120,
  base: 180,
  slow: 260
} as const

/**
 * True when either the app reduce-motion flag or the OS preference is on.
 * Used so JS settle timers collapse with the CSS token kill-switch.
 */
export function isMotionReduced(): boolean {
  if (typeof document !== 'undefined') {
    if (document.documentElement.getAttribute('data-reduce-motion') === 'true') {
      return true
    }
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  return false
}

/** Keep an exiting subtree mounted until CSS finishes — or 0 under reduce-motion. */
export function presenceSettleMs(durationMs: number): number {
  return isMotionReduced() ? 0 : durationMs + 48
}

export type PresenceVariant = 'slide' | 'rise' | 'fade'

export interface PresenceOptions {
  durationMs?: number
  variant?: PresenceVariant
  /** Dynamic cards can opt in to an entry transition on their first mount. */
  skipInitialAnimation?: boolean
}

/**
 * Keeps a conditionally-rendered surface mounted long enough to play a short
 * transform/opacity presence transition instead of snapping in/out on
 * mount/unmount.
 *
 * Returns the `mounted` flag to gate rendering and a `className` to spread
 * onto the surface root. The settled/idle state carries no animation class,
 * so a live surface never retains an unnecessary compositing hint.
 *
 * The very first render is never animated — only subsequent user toggles —
 * so restored UI does not appear to animate in after app launch.
 */
export interface Presence {
  mounted: boolean
  className: string
}

export type PanelPresence = Presence

const PRESENCE_CLASS = 'tw-presence'
const ENTER_FROM_CLASS = 'tw-presence--enter-from'
const EXIT_TO_CLASS = 'tw-presence--exit-to'
const PANEL_ANIM_CLASS = 'tw-panel-anim'
const PANEL_COLLAPSED_CLASS = 'tw-panel-collapsed'

function presenceClassName(variant: PresenceVariant, phase?: 'enter' | 'exit'): string {
  const classes = [PRESENCE_CLASS, `${PRESENCE_CLASS}--${variant}`]
  if (phase === 'enter') classes.push(ENTER_FROM_CLASS)
  if (phase === 'exit') classes.push(EXIT_TO_CLASS)
  return classes.join(' ')
}

export function usePresence(
  open: boolean,
  {
    durationMs = MOTION_DURATIONS.base,
    variant = 'fade',
    skipInitialAnimation = true
  }: PresenceOptions = {}
): Presence {
  const [mounted, setMounted] = useState(open)
  const mountedRef = useRef(mounted)
  const [className, setClassName] = useState(() =>
    open && !skipInitialAnimation ? presenceClassName(variant, 'enter') : ''
  )
  const firstRun = useRef(true)
  const raf1 = useRef<number | null>(null)
  const raf2 = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const optionsRef = useRef({ durationMs, variant, skipInitialAnimation })

  useEffect(() => {
    mountedRef.current = mounted
  }, [mounted])

  useEffect(() => {
    optionsRef.current = { durationMs, variant, skipInitialAnimation }
  }, [durationMs, skipInitialAnimation, variant])

  useEffect(() => {
    const clearScheduled = (): void => {
      if (raf1.current != null) cancelAnimationFrame(raf1.current)
      if (raf2.current != null) cancelAnimationFrame(raf2.current)
      if (timer.current != null) clearTimeout(timer.current)
      raf1.current = null
      raf2.current = null
      timer.current = null
    }

    const current = optionsRef.current
    const reduced = isMotionReduced()
    const settleDelay = presenceSettleMs(current.durationMs)

    // Under reduce-motion the CSS tokens are already 0.01ms — skip the
    // enter/exit class dance and settle immediately so modals/cards do not
    // remain focus-trapped after the visual is gone.
    if (reduced) {
      clearScheduled()
      firstRun.current = false
      setMounted(open)
      setClassName('')
      return clearScheduled
    }

    const scheduleEntry = (alreadyInEntryState = false): void => {
      setMounted(true)
      if (!alreadyInEntryState) setClassName(presenceClassName(current.variant, 'enter'))
      // Mount in its entry state, then release it after a pair of frames so
      // the browser has a concrete before/after style to interpolate.
      raf1.current = requestAnimationFrame(() => {
        raf2.current = requestAnimationFrame(() => {
          setClassName(presenceClassName(current.variant))
        })
      })
      timer.current = setTimeout(() => setClassName(''), settleDelay)
    }

    // Don't animate the initial state — only react to genuine toggles — unless
    // a newly-created, user-facing card explicitly opts into its first entry.
    if (firstRun.current) {
      firstRun.current = false
      if (open && !current.skipInitialAnimation) {
        scheduleEntry(true)
      } else {
        setMounted(open)
        setClassName('')
      }
      return clearScheduled
    }

    clearScheduled()

    if (open) {
      scheduleEntry()
    } else if (mountedRef.current) {
      // Arm the transition while still visually settled, then fade out. Exits
      // intentionally do not translate: disappearing chrome should feel calm.
      setClassName(presenceClassName(current.variant))
      raf1.current = requestAnimationFrame(() => {
        raf2.current = requestAnimationFrame(() => {
          setClassName(presenceClassName(current.variant, 'exit'))
        })
      })
      timer.current = setTimeout(() => {
        setMounted(false)
        setClassName('')
      }, settleDelay)
    } else {
      setClassName('')
    }

    return clearScheduled
  }, [open])

  return { mounted, className }
}

/**
 * Compatibility alias for the two legacy resizable panels. It shares the new
 * first-mount/exit lifecycle, but deliberately maps back to their established
 * margin-based classes so dragging their split handles remains unchanged.
 */
export function usePanelPresence(open: boolean, durationMs = 260): PanelPresence {
  const presence = usePresence(open, { durationMs, variant: 'slide' })
  if (!presence.className) return presence

  const isCollapsed =
    presence.className.includes(ENTER_FROM_CLASS) || presence.className.includes(EXIT_TO_CLASS)
  return {
    mounted: presence.mounted,
    className: `${PANEL_ANIM_CLASS}${isCollapsed ? ` ${PANEL_COLLAPSED_CLASS}` : ''}`
  }
}
