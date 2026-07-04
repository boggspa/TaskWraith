/**
 * Animated transcript jumps ("go to message" / jump-to-start / jump-to-end).
 *
 * The gutter rail's jumps used to teleport (`scrollTop = target`), which is
 * disorienting on long threads — the reader loses all sense of how far they
 * travelled. This module glides the scroller to the target over ~0.5–1.6s
 * (distance-scaled) instead.
 *
 * Design constraints, in order of importance:
 *
 *  1. NEVER fight the user. Any wheel / touch / scrollbar-drag / key input on
 *     the scroller cancels the animation immediately and hands the scroll
 *     back (with an `onCancel` hook so the caller can abandon its pending
 *     focus target too).
 *  2. Virtualiser-friendly. Every frame reports the new position via
 *     `onFrame` so the caller can run `syncVirtualizerScrollPosition` — the
 *     window then follows the glide exactly like a user scroll, mounting
 *     rows as they stream past.
 *  3. Reduced motion = instant. When the OS query or the app's
 *     `data-reduce-motion` attribute asks for it, `animateTo` degrades to
 *     the old single-write jump (onFrame + onDone still fire once, so the
 *     caller's bookkeeping is identical on both paths).
 *
 * The pure pieces (duration curve, easing) are exported for unit tests; the
 * animator itself is a small rAF loop around them.
 */

export const TRANSCRIPT_SCROLL_MIN_DURATION_MS = 500
export const TRANSCRIPT_SCROLL_MAX_DURATION_MS = 1600

/**
 * Distance-scaled glide duration. Three regimes:
 *  - sub-viewport nudges (< ~95px, e.g. the post-glide settle correction)
 *    resolve fast (~120–500ms) so they read as a nudge, not a second trip;
 *  - ordinary jumps get the 0.5s floor so they still read as travel;
 *  - cross-transcript hauls scale at 0.4 ms/px up to the 1.6s ceiling,
 *    putting a typical few-thousand-px jump in the requested 1–2s band.
 */
export function transcriptScrollDurationMs(distancePx: number): number {
  if (!Number.isFinite(distancePx)) return TRANSCRIPT_SCROLL_MIN_DURATION_MS
  const distance = Math.abs(distancePx)
  if (distance < 1) return 0
  const scaled = Math.max(TRANSCRIPT_SCROLL_MIN_DURATION_MS, 400 + distance * 0.4)
  const shortHopCap = 120 + distance * 4
  return Math.round(Math.min(TRANSCRIPT_SCROLL_MAX_DURATION_MS, scaled, shortHopCap))
}

/** Standard symmetric ease: gentle start, fast middle, soft landing. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2
}

export interface TranscriptScrollAnimateOptions {
  /** Called with the position written this frame (after the scrollTop write). */
  onFrame?: (scrollTop: number) => void
  /** Called once when the glide lands (or immediately on the instant path). */
  onDone?: (landedScrollTop: number) => void
  /** Called when user input interrupts the glide. NOT called by `cancel()`. */
  onInterrupted?: () => void
}

export interface TranscriptScrollAnimator {
  /**
   * Glide `scroller` to `targetTop`. A new call while a glide is in flight
   * retargets: the animation restarts from the CURRENT position toward the
   * new destination (position-continuous, so a re-estimate mid-flight never
   * teleports).
   */
  animateTo(scroller: HTMLElement, targetTop: number, options?: TranscriptScrollAnimateOptions): void
  /** Silently stop the current glide (no onDone / onInterrupted). */
  cancel(): void
  isAnimating(): boolean
}

function prefersInstantScroll(): boolean {
  if (typeof document !== 'undefined') {
    if (document.documentElement.getAttribute('data-reduce-motion') === 'true') return true
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true
    } catch {
      // matchMedia unavailable (test envs) → treat as no preference.
    }
  }
  return false
}

const INTERRUPT_EVENTS = ['wheel', 'touchstart', 'mousedown', 'keydown'] as const

export function createTranscriptScrollAnimator(
  shouldUseInstant: () => boolean = prefersInstantScroll
): TranscriptScrollAnimator {
  let rafId: number | null = null
  let activeScroller: HTMLElement | null = null
  let detachInterrupts: (() => void) | null = null

  const stop = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    detachInterrupts?.()
    detachInterrupts = null
    activeScroller = null
  }

  const clampTarget = (scroller: HTMLElement, targetTop: number): number => {
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    return Math.max(0, Math.min(maxScrollTop, targetTop))
  }

  return {
    animateTo(scroller, targetTop, options = {}) {
      stop()
      const startTop = scroller.scrollTop
      const target = clampTarget(scroller, targetTop)
      const duration = transcriptScrollDurationMs(target - startTop)

      const finish = (): void => {
        // Re-clamp at landing time — virtualised heights re-measure during the
        // glide, so the max scrollTop at the end can differ from the start.
        const landed = clampTarget(scroller, targetTop)
        scroller.scrollTop = landed
        options.onFrame?.(landed)
        stop()
        options.onDone?.(landed)
      }

      if (duration <= 0 || shouldUseInstant()) {
        finish()
        return
      }

      activeScroller = scroller
      const onUserInput = (): void => {
        stop()
        options.onInterrupted?.()
      }
      for (const eventName of INTERRUPT_EVENTS) {
        scroller.addEventListener(eventName, onUserInput, { passive: true })
      }
      detachInterrupts = () => {
        for (const eventName of INTERRUPT_EVENTS) {
          scroller.removeEventListener(eventName, onUserInput)
        }
      }

      const startedAt = performance.now()
      const step = (now: number): void => {
        rafId = null
        if (activeScroller !== scroller || !scroller.isConnected) {
          stop()
          return
        }
        const t = (now - startedAt) / duration
        if (t >= 1) {
          finish()
          return
        }
        const next = startTop + (target - startTop) * easeInOutCubic(t)
        scroller.scrollTop = next
        options.onFrame?.(scroller.scrollTop)
        rafId = requestAnimationFrame(step)
      }
      rafId = requestAnimationFrame(step)
    },
    cancel: stop,
    isAnimating: () => activeScroller !== null
  }
}
