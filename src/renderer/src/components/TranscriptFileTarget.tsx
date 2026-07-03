import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { resolveWorkspaceAbsolutePath } from '../lib/ActivityPathDisplay'

/**
 * A clickable file reference for transcript tool-call rows.
 *
 * Rendered as a link-styled `<button>` showing `label` (typically the file's
 * basename, or the raw path in the compact trace). Clicking opens the file in
 * the OS default handler for its type — i.e. the user's editor/IDE when they
 * have one associated with source files — via the existing, security-gated
 * `shell:open-link` bridge (`window.api.openExternalOrPath`). Hovering (or
 * focusing) surfaces a small portaled popover with the full resolved path plus
 * Open / Reveal-in-Finder / Copy-path actions.
 *
 * The popover is portaled to `document.body` so it escapes the transcript's
 * scroll/overflow ancestors (`.transcript-scroll`, `.live-activity-viewport`)
 * that would otherwise clip an inline-positioned card — the same reason
 * {@link DiffHoverPreview} and ContextMeterPopover portal.
 *
 * The element is designed to nest inside the row's own `div[role="button"]`
 * expand toggle: click / Enter / Space stop propagation so opening a file
 * never also expands (or collapses) the surrounding row.
 */

const CLOSE_DELAY_MS = 140
const CARD_MARGIN = 10
const CARD_GAP = 6
const CARD_MAX_WIDTH = 460
const CARD_FALLBACK_HEIGHT = 132

type AnchorRect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>

export interface FileCardLayout {
  left: number
  top: number
  width: number
  placement: 'above' | 'below'
}

/**
 * Position the popover relative to its anchor: prefer directly below, flip
 * above when it would overflow the bottom edge, and clamp horizontally inside
 * the viewport. Pure + exported so the geometry is unit-testable without a DOM.
 */
export function getFileCardLayout({
  anchor,
  cardHeight,
  viewportWidth,
  viewportHeight
}: {
  anchor: AnchorRect
  cardHeight: number
  viewportWidth: number
  viewportHeight: number
}): FileCardLayout {
  const width = Math.max(220, Math.min(CARD_MAX_WIDTH, viewportWidth - CARD_MARGIN * 2))
  const left = Math.max(CARD_MARGIN, Math.min(anchor.left, viewportWidth - width - CARD_MARGIN))
  const height = Math.max(1, cardHeight)
  const belowTop = anchor.bottom + CARD_GAP
  if (belowTop + height <= viewportHeight - CARD_MARGIN) {
    return { left, top: belowTop, width, placement: 'below' }
  }
  const aboveTop = anchor.top - CARD_GAP - height
  if (aboveTop >= CARD_MARGIN) {
    return { left, top: aboveTop, width, placement: 'above' }
  }
  const clampedTop = Math.max(CARD_MARGIN, viewportHeight - height - CARD_MARGIN)
  return { left, top: clampedTop, width, placement: 'below' }
}

export interface TranscriptFileTargetProps {
  /** Path exactly as the tool reported it (may be workspace-relative). */
  filePath: string
  /** Inline text shown on the row (usually the basename or raw path). */
  label: string
  /** Workspace root, used to resolve a relative `filePath` to absolute. */
  workspacePath?: string
  /** Extra class(es) merged onto the button so callers keep their own styling
   * (e.g. `activity-file-name`, `compact-tool-trace-path`). */
  className?: string
  /** When false, the button stays click-to-open but does NOT raise its own
   * hover popover — used on rows that already show a diff hover preview so the
   * two don't stack. The native `title` tooltip still carries the full path. */
  showHoverCard?: boolean
}

function openExternally(path: string): void {
  if (!path || typeof window === 'undefined') return
  void window.api?.openExternalOrPath?.(path)
}

function revealInFinder(path: string): void {
  if (!path || typeof window === 'undefined') return
  void window.api?.revealPathInFinder?.(path)
}

export function TranscriptFileTarget({
  filePath,
  label,
  workspacePath,
  className,
  showHoverCard = true
}: TranscriptFileTargetProps): React.JSX.Element {
  const absolutePath = useMemo(
    () => resolveWorkspaceAbsolutePath(filePath, workspacePath),
    [filePath, workspacePath]
  )
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [copied, setCopied] = useState(false)
  const [cardHeight, setCardHeight] = useState(CARD_FALLBACK_HEIGHT)
  const closeTimerRef = useRef<number | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const closeCard = useCallback(() => {
    clearCloseTimer()
    setAnchor(null)
    setCopied(false)
  }, [clearCloseTimer])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    if (typeof window === 'undefined') {
      setAnchor(null)
      return
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setAnchor(null)
      setCopied(false)
    }, CLOSE_DELAY_MS)
  }, [clearCloseTimer])

  const openCard = useCallback(
    (element: HTMLElement) => {
      if (!showHoverCard) return
      clearCloseTimer()
      setAnchor(element.getBoundingClientRect())
    },
    [clearCloseTimer, showHoverCard]
  )

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  // If suppression flips on (e.g. a write activity's diff streams in and the
  // row takes over hover with its own DiffHoverPreview), force-close any card
  // already open so the two popovers never stack.
  useEffect(() => {
    if (!showHoverCard) closeCard()
  }, [showHoverCard, closeCard])

  // Dismiss on Escape / scroll / resize — a captured hover popover would
  // otherwise drift away from its anchor when the transcript scrolls.
  useEffect(() => {
    if (!anchor) return
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('.transcript-file-card')) return
      closeCard()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCard()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', closeCard)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', closeCard)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, closeCard])

  useLayoutEffect(() => {
    if (!anchor || !cardRef.current) return
    const measured = cardRef.current.getBoundingClientRect().height
    if (!measured || !Number.isFinite(measured)) return
    const rounded = Math.ceil(measured)
    setCardHeight((current) => (Math.abs(current - rounded) <= 1 ? current : rounded))
  }, [anchor, absolutePath])

  // Move keyboard focus into the portaled card's first action so keyboard-only
  // users can reach Reveal / Copy — the card is portaled to <body>, outside the
  // trigger's tab order, so it must be entered programmatically (same approach
  // as DiffHoverPreview's focusTarget effect).
  const focusFirstCardAction = useCallback(() => {
    if (typeof window === 'undefined') return
    window.requestAnimationFrame(() => {
      cardRef.current?.querySelector<HTMLButtonElement>('.transcript-file-card-action')?.focus()
    })
  }, [])

  const handleCardBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (cardRef.current?.contains(event.relatedTarget as Node | null)) return
      scheduleClose()
    },
    [scheduleClose]
  )

  const handleCardKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeCard()
        triggerRef.current?.focus()
      }
    },
    [closeCard]
  )

  const handleOpen = useCallback(() => openExternally(absolutePath), [absolutePath])
  const handleReveal = useCallback(() => revealInFinder(absolutePath), [absolutePath])
  const handleCopy = useCallback(() => {
    if (!absolutePath || typeof navigator === 'undefined' || !navigator.clipboard) return
    navigator.clipboard
      .writeText(absolutePath)
      .then(() => setCopied(true))
      .catch(() => {})
  }, [absolutePath])

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const layout = anchor
    ? getFileCardLayout({ anchor, cardHeight, viewportWidth, viewportHeight })
    : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`transcript-file-target${className ? ` ${className}` : ''}`}
        title={absolutePath || label}
        aria-label={`Open ${label} in your editor`}
        aria-haspopup={showHoverCard ? 'dialog' : undefined}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          handleOpen()
        }}
        onMouseEnter={(event) => openCard(event.currentTarget)}
        onMouseLeave={scheduleClose}
        onFocus={(event) => openCard(event.currentTarget)}
        onBlur={scheduleClose}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            closeCard()
            return
          }
          // ArrowDown enters the (portaled) hover card so keyboard users can
          // reach the Reveal / Copy actions that live there.
          if (event.key === 'ArrowDown' && showHoverCard) {
            event.preventDefault()
            event.stopPropagation()
            openCard(event.currentTarget)
            focusFirstCardAction()
            return
          }
          // Enter / Space fire the native button click (open); stop the event
          // reaching the row so it doesn't also toggle the row's expansion.
          if (event.key === 'Enter' || event.key === ' ') {
            event.stopPropagation()
          }
        }}
      >
        {label}
      </button>
      {anchor && layout && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={cardRef}
              className="transcript-file-card"
              role="dialog"
              aria-label={`File actions for ${label}`}
              data-placement={layout.placement}
              style={{
                left: `${layout.left}px`,
                top: `${layout.top}px`,
                width: `${layout.width}px`
              }}
              onMouseEnter={clearCloseTimer}
              onMouseLeave={scheduleClose}
              onFocus={clearCloseTimer}
              onBlur={handleCardBlur}
              onKeyDown={handleCardKeyDown}
            >
              <div className="transcript-file-card-path">{absolutePath || label}</div>
              <div className="transcript-file-card-actions">
                <button
                  type="button"
                  className="transcript-file-card-action is-primary"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleOpen()
                    closeCard()
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="transcript-file-card-action"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleReveal()
                    closeCard()
                  }}
                >
                  Reveal in Finder
                </button>
                <button
                  type="button"
                  className="transcript-file-card-action"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleCopy()
                  }}
                >
                  {copied ? 'Copied' : 'Copy path'}
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
