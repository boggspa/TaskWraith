import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { parseUnifiedDiff, type ParsedDiffLine } from '../lib/unifiedDiffParser'

export interface DiffHoverPreviewSummary {
  actionLabel?: string
  path: string
  status?: string
  additions?: number
  deletions?: number
  diffText: string
}

export interface DiffHoverPreviewState {
  anchor: DOMRect
  boundary?: DOMRect
  summary: DiffHoverPreviewSummary
  action?: {
    label: string
    onActivate: () => void
  }
}

export const DIFF_HOVER_PREVIEW_TOOLTIP_ID = 'diff-hover-preview-tooltip'

const DIFF_HOVER_PREVIEW_LINE_LIMIT = 96
const DIFF_HOVER_PREVIEW_RAW_LINE_LIMIT = 240
const DIFF_HOVER_PREVIEW_CHAR_LIMIT = 40_000
const DIFF_HOVER_PREVIEW_MIN_WIDTH = 520
const DIFF_HOVER_PREVIEW_MAX_WIDTH = 1040
const DIFF_HOVER_PREVIEW_HEIGHT = 360
const DIFF_HOVER_PREVIEW_MARGIN = 12
const DIFF_HOVER_PREVIEW_CLOSE_DELAY_MS = 140

type DiffHoverPreviewRect = Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top' | 'width'>

export interface DiffHoverPreviewLayout {
  left: number
  maxHeight: number
  top: number
  width: number
}

export function getDiffHoverPreviewLayout({
  anchor,
  boundary,
  viewportHeight,
  viewportWidth
}: {
  anchor: DiffHoverPreviewRect
  boundary?: DiffHoverPreviewRect
  viewportHeight: number
  viewportWidth: number
}): DiffHoverPreviewLayout {
  const boundaryLeft = Math.max(
    DIFF_HOVER_PREVIEW_MARGIN,
    boundary?.left ?? DIFF_HOVER_PREVIEW_MARGIN
  )
  const boundaryRight = Math.min(
    viewportWidth - DIFF_HOVER_PREVIEW_MARGIN,
    boundary?.right ?? viewportWidth - DIFF_HOVER_PREVIEW_MARGIN
  )
  const availableWidth = Math.max(320, boundaryRight - boundaryLeft)
  const targetWidth =
    availableWidth >= DIFF_HOVER_PREVIEW_MIN_WIDTH
      ? availableWidth
      : Math.max(anchor.width, DIFF_HOVER_PREVIEW_MIN_WIDTH)
  const width = Math.max(
    320,
    Math.min(
      targetWidth,
      DIFF_HOVER_PREVIEW_MAX_WIDTH,
      availableWidth,
      viewportWidth - DIFF_HOVER_PREVIEW_MARGIN * 2
    )
  )
  const maxHeight = Math.max(
    180,
    Math.min(DIFF_HOVER_PREVIEW_HEIGHT, viewportHeight - DIFF_HOVER_PREVIEW_MARGIN * 2)
  )
  const centeredLeft = boundaryLeft + Math.max(0, (availableWidth - width) / 2)
  const left = Math.max(boundaryLeft, Math.min(centeredLeft, boundaryRight - width))
  const preferredTop = anchor.top - maxHeight - 10
  const fallbackTop = Math.min(
    anchor.bottom + 10,
    viewportHeight - maxHeight - DIFF_HOVER_PREVIEW_MARGIN
  )
  const top = preferredTop >= DIFF_HOVER_PREVIEW_MARGIN ? preferredTop : fallbackTop

  return {
    left,
    maxHeight,
    top: Math.max(DIFF_HOVER_PREVIEW_MARGIN, top),
    width
  }
}

export function diffHoverPreviewBoundaryForElement(element: HTMLElement): DOMRect | undefined {
  const boundary = element.closest(
    '.transcript-inner, .message-group, .activity-timeline, .live-activity-viewport'
  )
  return boundary instanceof HTMLElement ? boundary.getBoundingClientRect() : undefined
}

export const prepareDiffHoverPreviewText = (
  diffText: string
): { text: string; capped: boolean } => {
  let lineCount = 0
  let index = 0
  const maxIndex = Math.min(diffText.length, DIFF_HOVER_PREVIEW_CHAR_LIMIT)
  while (index < maxIndex) {
    if (diffText.charCodeAt(index) === 10) {
      lineCount += 1
      if (lineCount >= DIFF_HOVER_PREVIEW_RAW_LINE_LIMIT) {
        index += 1
        break
      }
    }
    index += 1
  }
  return {
    text: diffText.slice(0, index),
    capped: index < diffText.length
  }
}

function diffHoverPreviewLineClass(line: ParsedDiffLine): string {
  if (line.kind === 'add') return 'add'
  if (line.kind === 'del') return 'del'
  if (line.kind === 'meta') return 'meta'
  return 'context'
}

function DiffHoverPreviewLine({ line }: { line: ParsedDiffLine }) {
  return (
    <div className={`diff-hover-preview-line ${diffHoverPreviewLineClass(line)}`}>
      <span className="diff-hover-preview-gutter old">{line.oldLine ?? ''}</span>
      <span className="diff-hover-preview-gutter new">{line.newLine ?? ''}</span>
      <span className="diff-hover-preview-code">{line.text || ' '}</span>
    </div>
  )
}

export function useDiffHoverPreviewDismiss(
  preview: DiffHoverPreviewState | null,
  closePreview: () => void
) {
  useEffect(() => {
    if (!preview) return
    const closePreviewOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview()
    }
    const closePreviewOnScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('.diff-hover-preview')) return
      closePreview()
    }
    window.addEventListener('scroll', closePreviewOnScroll, true)
    window.addEventListener('resize', closePreview)
    window.addEventListener('keydown', closePreviewOnEscape)
    return () => {
      window.removeEventListener('scroll', closePreviewOnScroll, true)
      window.removeEventListener('resize', closePreview)
      window.removeEventListener('keydown', closePreviewOnEscape)
    }
  }, [closePreview, preview])
}

export function useDiffHoverPreviewState(delayMs = DIFF_HOVER_PREVIEW_CLOSE_DELAY_MS) {
  const [preview, setPreview] = useState<DiffHoverPreviewState | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const keepPreviewOpen = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === 'undefined') return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const closePreview = useCallback(() => {
    keepPreviewOpen()
    setPreview(null)
  }, [keepPreviewOpen])

  const showPreview = useCallback(
    (nextPreview: DiffHoverPreviewState) => {
      keepPreviewOpen()
      setPreview(nextPreview)
    },
    [keepPreviewOpen]
  )

  const scheduleClosePreview = useCallback(() => {
    keepPreviewOpen()
    if (typeof window === 'undefined') {
      setPreview(null)
      return
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setPreview(null)
    }, delayMs)
  }, [delayMs, keepPreviewOpen])

  useEffect(() => keepPreviewOpen, [keepPreviewOpen])

  return {
    closePreview,
    keepPreviewOpen,
    preview,
    scheduleClosePreview,
    showPreview
  }
}

export function DiffHoverPreviewOverlay({
  onFocus,
  onBlur,
  onMouseEnter,
  onMouseLeave,
  preview
}: {
  onFocus?: () => void
  onBlur?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  preview: DiffHoverPreviewState | null
}) {
  const preparedDiff = useMemo(
    () =>
      preview?.summary.diffText
        ? prepareDiffHoverPreviewText(preview.summary.diffText)
        : null,
    [preview?.summary.diffText]
  )
  const parsed = useMemo(
    () =>
      preparedDiff
        ? parseUnifiedDiff(preparedDiff.text, {
            maxLines: DIFF_HOVER_PREVIEW_LINE_LIMIT
          })
        : null,
    [preparedDiff]
  )

  if (!preview || !parsed || typeof document === 'undefined') return null

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const layout = getDiffHoverPreviewLayout({
    anchor: preview.anchor,
    boundary: preview.boundary,
    viewportHeight,
    viewportWidth
  })
  const changeText =
    preview.summary.additions !== undefined || preview.summary.deletions !== undefined
      ? `+${preview.summary.additions || 0} -${preview.summary.deletions || 0}`
      : ''
  const statusText = preview.summary.status || 'modified'
  const hiddenLineCount =
    parsed.omittedLineCount > 0 || preparedDiff?.capped
      ? Math.max(parsed.omittedLineCount, 1)
      : 0

  const overlay = (
    <div
      id={DIFF_HOVER_PREVIEW_TOOLTIP_ID}
      className="diff-hover-preview"
      data-status={statusText}
      onBlur={onBlur}
      onFocus={onFocus}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        left: `${layout.left}px`,
        maxHeight: `${layout.maxHeight}px`,
        top: `${layout.top}px`,
        width: `${layout.width}px`
      }}
      role="tooltip"
    >
      <div className="diff-hover-preview-header">
        <div className="diff-hover-preview-title">
          <span className="diff-hover-preview-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M4 1.75h5.1L13 5.65v8.6H4z" />
              <path d="M9 1.75v4h4" />
              <path d="M6.1 8.25h3.8M6.1 10.5h3.8" />
            </svg>
          </span>
          <span title={preview.summary.path}>{preview.summary.path}</span>
        </div>
        <div
          className="diff-hover-preview-badges"
          aria-label={changeText ? `${statusText} ${changeText}` : statusText}
        >
          <span className="diff-hover-preview-status">{statusText}</span>
          {changeText && <strong>{changeText}</strong>}
        </div>
      </div>
      <div className="diff-hover-preview-body">
        {parsed.sections.length > 0 ? (
          parsed.sections.map((section, sectionIndex) => (
            <div key={sectionIndex} className="diff-hover-preview-section">
              {section.header && <div className="diff-hover-preview-hunk">{section.header}</div>}
              {section.lines.map((line, lineIndex) => (
                <DiffHoverPreviewLine key={`${sectionIndex}-${lineIndex}`} line={line} />
              ))}
            </div>
          ))
        ) : (
          <div className="diff-hover-preview-empty">No diff hunks to preview.</div>
        )}
      </div>
      <div className="diff-hover-preview-footer">
        <span>{preview.summary.actionLabel || 'Hover preview'}</span>
        <div className="diff-hover-preview-footer-actions">
          <span>
            {parsed.renderedLineCount.toLocaleString()} lines shown
            {hiddenLineCount > 0 ? ` · ${hiddenLineCount.toLocaleString()} hidden` : ''}
          </span>
          {preview.action && (
            <button
              className="diff-hover-preview-action"
              type="button"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                preview.action?.onActivate()
              }}
            >
              {preview.action.label}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}
