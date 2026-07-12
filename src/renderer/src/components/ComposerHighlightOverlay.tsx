import { Fragment, useLayoutEffect, useRef, type RefObject } from 'react'
import type { EnsembleParticipant } from '../../../main/store/types'
import { tokeniseMentions } from '../lib/mentionHighlight'
import { syncComposerHighlightMetrics, syncComposerHighlightScroll } from './composerHighlightSync'

interface ComposerHighlightOverlayProps {
  value: string
  /** Ensemble participants for the chat. Undefined / empty disables
   * the resolver — tokens just render as regular text in that case
   * since there's no participant to colour against. */
  participants?: EnsembleParticipant[]
  /**
   * 1.0.4 — Source-of-truth ref to the textarea this overlay is
   * mirroring. We read its `getComputedStyle()` and copy the
   * glyph-positioning properties onto the overlay so the two
   * layers stay metric-aligned regardless of per-shell or
   * per-theme CSS variation. Without this, every composer shell
   * needs hand-written CSS that mirrors the textarea's font /
   * padding / border — fragile, repetitive, and prone to drift.
   * See ledger `1.0.4 → 1.0.5 trajectory` for the contenteditable
   * migration that replaces this two-layer pattern entirely.
   */
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /**
   * Changing this value forces a metric re-sync even when the
   * `textareaRef` identity hasn't changed. Parent uses it to
   * trigger sync on composer-style switches, theme flips, welcome
   * mode toggles — anything that might restyle the textarea
   * without resizing it (so the ResizeObserver wouldn't fire).
   * Any primitive works as a useLayoutEffect dep; we accept
   * string | number so the parent can compose a readable key
   * like `"codex|dark|welcome"` instead of hashing into an int.
   */
  syncEpoch: string | number
}

/**
 * Visual layer that sits OVER the composer textarea and renders
 * the same prompt text, except `@Token` mentions that resolve to a
 * participant get wrapped in a provider-tinted span. The textarea
 * itself stays as a plain `<textarea>` (handles caret, IME,
 * selection, paste); only when an `@-mention` is actually resolved
 * does the parent apply the `has-mention-overlay` class to make
 * the textarea text transparent so the overlay reads as the only
 * visible text source.
 *
 * Architecture (1.0.4):
 *   - The overlay's font / padding / border / line-height /
 *     letter-spacing are NOT set via CSS per-shell. They're copied
 *     from the textarea's `getComputedStyle()` at runtime via the
 *     `useLayoutEffect` below. That way every composer shell's
 *     textarea metrics flow through to the overlay automatically,
 *     no matter how many per-shell rules the shell stack adds.
 *   - A `ResizeObserver` on the textarea catches any size-changing
 *     style update (font-family swap, padding change, etc.) and
 *     re-syncs the overlay. Plus an explicit `syncEpoch` from the
 *     parent for shell-/theme-changes that don't actually resize.
 *
 * Why this exists: the native textarea keeps typing behavior predictable while
 * the overlay handles visual mention highlighting. This can be simplified if
 * the composer later moves to a `contenteditable` model.
 *
 * The actual tokenisation lives in `lib/mentionHighlight.ts` so the
 * same logic powers the transcript user-message bubbles and the
 * queued-messages above-row body text via `MentionHighlightedText`.
 */
export function ComposerHighlightOverlay({
  value,
  participants,
  textareaRef,
  syncEpoch
}: ComposerHighlightOverlayProps): React.JSX.Element {
  const segments = tokeniseMentions(value, participants || [])
  const overlayRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  /**
   * 1.0.4-AR1 — listener attachment is its own effect, scoped to
   * `[textareaRef]`. Previously the scroll+resize listeners were
   * registered inside the metric-sync effect that re-ran on EVERY
   * `value` change (every keystroke), tearing down + re-attaching
   * the listeners between every character. That worked for
   * mouse-wheel scrolls but the browser's input-driven
   * auto-scroll-to-caret in `<textarea>` does NOT always fire a
   * standalone `scroll` event in Chromium — it folds the scroll
   * adjustment into the same input dispatch, so by the time our
   * metric-sync effect ran the listener was gone for the duration
   * of the synchronous teardown / reattach. On long prompts the
   * overlay ended up perpetually pinned to the top because the
   * crucial scroll signal slipped between the listener's edges.
   *
   * The fix is twofold:
   *   1. Attach the scroll listener exactly once (per textarea
   *      ref). It survives every keystroke without churn.
   *   2. Add a sibling `input` listener that schedules a
   *      `requestAnimationFrame(syncScroll)` so the next animation
   *      frame — AFTER the browser has finished its post-input
   *      auto-scroll — re-reads `textarea.scrollTop` and updates
   *      the transform. Belt-and-braces with the standalone
   *      `scroll` listener; either path is enough on its own.
   *
   * The metric-sync effect below stays value-dependent because the
   * content's min-height tracks `textarea.scrollHeight`, which only
   * changes when the text content changes.
   */
  useLayoutEffect(() => {
    let textarea: HTMLTextAreaElement | null = null
    let rafId: number | null = null
    let disposed = false

    const syncScroll = (): void => {
      const content = contentRef.current
      if (!textarea || !content) return
      syncComposerHighlightScroll(textarea, content)
    }

    const scheduleSync = (): void => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (disposed) return
        syncScroll()
      })
    }

    const scheduleAttach = (): void => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (disposed) return
        attach()
      })
    }

    const attach = (): void => {
      const nextTextarea = textareaRef.current
      if (!nextTextarea || !contentRef.current) {
        scheduleAttach()
        return
      }
      textarea = nextTextarea
      syncScroll()
      textarea.addEventListener('scroll', syncScroll, { passive: true })
      // Input listener catches the input-driven auto-scroll-to-caret
      // that Chromium folds into the input dispatch without firing a
      // separate scroll event. The rAF defers the read until after
      // the browser has finished any post-input layout adjustments.
      textarea.addEventListener('input', scheduleSync, { passive: true })
    }

    attach()

    return () => {
      disposed = true
      textarea?.removeEventListener('scroll', syncScroll)
      textarea?.removeEventListener('input', scheduleSync)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [textareaRef, syncEpoch])

  useLayoutEffect(() => {
    let rafId: number | null = null
    let observer: ResizeObserver | null = null
    let disposed = false

    /**
     * Copy the textarea's computed glyph-positioning properties
     * onto the inner overlay content. These are the ones that affect WHERE each
     * character sits — change any of them and the two layers
     * diverge. This includes the font's shaping controls and the
     * whitespace/wrapping controls, not just the visible font shorthand.
     *
     * NOT copied:
     *   - `color` (textarea is transparent when has-mention-overlay
     *     is active; overlay needs its own color cascade)
     *   - `background` (per-shell chrome stays on the textarea;
     *     overlay sits over the top with no bg)
     *   - `outline` / `box-shadow` (textarea-specific affordances)
     * Border space is matched with a transparent border on the
     * content layer so its content area is inset by the same number of
     * pixels as the textarea's (border-box accounting). Its explicit width is
     * based on `clientWidth`, rather than the wrapper, so a native scrollbar
     * gutter cannot make the mirror wrap at a different character.
     */
    const syncStyles = (): void => {
      const textarea = textareaRef.current
      const overlay = overlayRef.current
      const content = contentRef.current
      if (!textarea || !overlay || !content) {
        scheduleStyleSync()
        return
      }
      const cs = getComputedStyle(textarea)
      syncComposerHighlightMetrics(textarea, content, cs)
    }

    const scheduleStyleSync = (): void => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (disposed) return
        syncStyles()
        observeTextarea()
      })
    }

    const observeTextarea = (): void => {
      const textarea = textareaRef.current
      if (!textarea || typeof ResizeObserver === 'undefined' || observer) return
      observer = new ResizeObserver(() => {
        syncStyles()
      })
      observer.observe(textarea)
    }

    // Initial style sync + an immediate scroll mirror so the
    // first paint of a freshly-mounted overlay aligns with whatever
    // scroll position the textarea is already at (e.g. restoring a
    // long draft from cache).
    syncStyles()

    // Catch any subsequent style change that affects the textarea's
    // size. `ResizeObserver` fires when content-box / border-box
    // dimensions change, which covers padding swaps, font-size
    // swaps, and most font-family swaps (different glyph widths
    // change the intrinsic size). For pure-styling changes that
    // don't resize (rare), the `syncEpoch` dep below handles it.
    observeTextarea()
    return () => {
      disposed = true
      observer?.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [textareaRef, syncEpoch, value])

  return (
    <div ref={overlayRef} className="composer-textarea-highlight" aria-hidden="true">
      <div ref={contentRef} className="composer-textarea-highlight-content">
        {segments.map((segment, idx) => {
          if (segment.kind === 'text') {
            return <Fragment key={idx}>{segment.text}</Fragment>
          }
          if (segment.kind === 'user-mention') {
            // 1.0.4 — `@user` / `@human` / `@you` chip. Tints with
            // the user's chosen `--user-bubble-color` (Appearance
            // settings) so the chip visually echoes their identity
            // rather than any provider's brand.
            return (
              <span
                key={idx}
                className="composer-mention-token composer-mention-token--user"
                style={{ color: `var(--user-bubble-base, var(--accent))` }}
              >
                {segment.text}
              </span>
            )
          }
          return (
            <span
              key={idx}
              className="composer-mention-token"
              style={{ color: `var(--provider-${segment.providerClass}-color, var(--accent))` }}
            >
              {segment.text}
            </span>
          )
        })}
        {/* Trailing newline so the overlay's last line gets line-height
            treatment even when `value` ends with `\n`. textareas treat
            a trailing newline as a real line; pre-wrap divs would
            collapse without this. */}
        {'\n'}
      </div>
    </div>
  )
}
