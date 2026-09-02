import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  diffLineDisplayText,
  isRenderableDiffLine,
  parseUnifiedDiff,
  type ParsedDiffLine
} from '../lib/unifiedDiffParser'
import { renderHighlightedSpans } from './DiffDetail'
import {
  ensureEditorHighlightStylesMounted,
  highlightCodeToLineSpans,
  languageFromPath,
  type HighlightSpan
} from './highlightCodeLines'

export type DiffHoverPreviewSource = 'commit-reference' | 'run-summary' | 'tool-call'

export interface DiffHoverPreviewFile {
  path: string
  additions?: number
  deletions?: number
}

export interface DiffHoverPreviewSummary {
  actionLabel?: string
  emptyFooterLabel?: string
  emptyMessage?: string
  path: string
  status?: string
  additions?: number
  deletions?: number
  diffText?: string
  /** diffText was synthesized from the run's tool-call edit payloads rather
   * than captured from git — badge it so the hunks aren't mistaken for the
   * file's on-disk diff. */
  snapshot?: boolean
  source?: DiffHoverPreviewSource
  /** Optional bounded file list, used by commit previews in Task Complete. */
  files?: DiffHoverPreviewFile[]
  /** Total files before the preview payload's 30-row cap. */
  fileCount?: number
}

export interface DiffHoverPreviewState {
  anchor: DOMRect
  boundary?: DOMRect
  summary: DiffHoverPreviewSummary
  action?: {
    label: string
    onActivate: () => void
  }
  focusTarget?: 'action' | 'preview'
}

export const DIFF_HOVER_PREVIEW_TOOLTIP_ID = 'diff-hover-preview-tooltip'

const DIFF_HOVER_PREVIEW_LINE_LIMIT = 96
const DIFF_HOVER_PREVIEW_RAW_LINE_LIMIT = 240
const DIFF_HOVER_PREVIEW_CHAR_LIMIT = 40_000
const DIFF_HOVER_PREVIEW_MIN_WIDTH = 520
const DIFF_HOVER_PREVIEW_MAX_WIDTH = 1040
const DIFF_HOVER_PREVIEW_HEIGHT = 360
const DIFF_HOVER_PREVIEW_MARGIN = 12
const DIFF_HOVER_PREVIEW_CLOSE_DELAY_MS = 1400

export const DIFF_HOVER_PREVIEW_FILE_INITIAL_LIMIT = 8
export const DIFF_HOVER_PREVIEW_FILE_MAX_VISIBLE = 30

type DiffHoverPreviewRect = Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top' | 'width'>

export function diffHoverPreviewSourceLabel(source?: DiffHoverPreviewSource): string {
  if (source === 'commit-reference') return 'Commit'
  if (source === 'run-summary') return 'Task complete'
  if (source === 'tool-call') return 'Tool edit'
  return 'Diff preview'
}

export function diffHoverPreviewRole(hasAction: boolean): 'dialog' | 'tooltip' {
  return hasAction ? 'dialog' : 'tooltip'
}

export function canShowDiffHoverPreview(
  summary: Pick<DiffHoverPreviewSummary, 'diffText'>,
  hasAction = false
): boolean {
  return Boolean(summary.diffText?.trim() || hasAction)
}

export interface DiffHoverPreviewStat {
  kind: 'add' | 'delete'
  label: string
  ariaLabel: string
}

export function getDiffHoverPreviewStats(
  summary: Pick<DiffHoverPreviewSummary, 'additions' | 'deletions'>
): DiffHoverPreviewStat[] {
  const stats: DiffHoverPreviewStat[] = []
  if (summary.additions !== undefined) {
    stats.push({
      kind: 'add',
      label: `+${summary.additions}`,
      ariaLabel: `${summary.additions.toLocaleString()} additions`
    })
  }
  if (summary.deletions !== undefined) {
    stats.push({
      kind: 'delete',
      label: `-${summary.deletions}`,
      ariaLabel: `${summary.deletions.toLocaleString()} deletions`
    })
  }
  return stats
}

export interface DiffHoverPreviewFileWindow {
  canShowMore: boolean
  files: DiffHoverPreviewFile[]
  hiddenAfterCap: number
  nextShowCount: number
  previewableCount: number
  visibleCount: number
}

export function diffHoverPreviewEmptyMessage(
  summary: Pick<DiffHoverPreviewSummary, 'emptyMessage'>,
  hasPreparedDiff: boolean
): string {
  if (summary.emptyMessage) return summary.emptyMessage
  return hasPreparedDiff ? 'No diff hunks to preview.' : 'No inline diff captured.'
}

export function getDiffHoverPreviewFileWindow(
  files: DiffHoverPreviewFile[] | undefined,
  expanded = false,
  totalFileCount?: number
): DiffHoverPreviewFileWindow {
  const allFiles = Array.isArray(files) ? files : []
  const totalCount = Math.max(
    allFiles.length,
    typeof totalFileCount === 'number' && Number.isFinite(totalFileCount)
      ? Math.max(0, Math.floor(totalFileCount))
      : 0
  )
  const previewableCount = Math.min(totalCount, DIFF_HOVER_PREVIEW_FILE_MAX_VISIBLE)
  const maxVisibleCount = Math.min(allFiles.length, previewableCount)
  const visibleCount = expanded
    ? maxVisibleCount
    : Math.min(allFiles.length, DIFF_HOVER_PREVIEW_FILE_INITIAL_LIMIT)

  return {
    canShowMore: !expanded && maxVisibleCount > visibleCount,
    files: allFiles.slice(0, visibleCount),
    hiddenAfterCap: Math.max(0, totalCount - DIFF_HOVER_PREVIEW_FILE_MAX_VISIBLE),
    nextShowCount: Math.max(0, maxVisibleCount - visibleCount),
    previewableCount,
    visibleCount
  }
}

export interface DiffHoverPreviewLayout {
  left: number
  maxHeight: number
  top: number
  width: number
}

export function getDiffHoverPreviewLayout({
  anchor,
  boundary,
  previewHeight,
  viewportHeight,
  viewportWidth
}: {
  anchor: DiffHoverPreviewRect
  boundary?: DiffHoverPreviewRect
  previewHeight?: number
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
  const measuredHeight =
    typeof previewHeight === 'number' && Number.isFinite(previewHeight) && previewHeight > 0
      ? previewHeight
      : maxHeight
  const placementHeight = Math.max(1, Math.min(measuredHeight, maxHeight))
  const centeredLeft = boundaryLeft + Math.max(0, (availableWidth - width) / 2)
  const left = Math.max(boundaryLeft, Math.min(centeredLeft, boundaryRight - width))
  const preferredTop = anchor.top - placementHeight - 10
  const fallbackTop = Math.min(
    anchor.bottom + 10,
    viewportHeight - placementHeight - DIFF_HOVER_PREVIEW_MARGIN
  )
  const unclampedTop = preferredTop >= DIFF_HOVER_PREVIEW_MARGIN ? preferredTop : fallbackTop
  const maxTop = Math.max(
    DIFF_HOVER_PREVIEW_MARGIN,
    viewportHeight - placementHeight - DIFF_HOVER_PREVIEW_MARGIN
  )
  const top = Math.min(
    Math.max(DIFF_HOVER_PREVIEW_MARGIN, unclampedTop),
    maxTop
  )

  return {
    left,
    maxHeight,
    top,
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

export function DiffHoverPreviewLine({
  line,
  spans
}: {
  line: ParsedDiffLine
  spans?: HighlightSpan[]
}) {
  return (
    <div className={`diff-hover-preview-line ${diffHoverPreviewLineClass(line)}`}>
      <span className="diff-hover-preview-gutter old">{line.oldLine ?? ''}</span>
      <span className="diff-hover-preview-gutter new">{line.newLine ?? ''}</span>
      <span className="diff-hover-preview-code">
        {renderHighlightedSpans(spans, diffLineDisplayText(line))}
      </span>
    </div>
  )
}

/**
 * Dismiss a hover bubble on Escape, resize, or a scroll that is not inside the
 * bubble itself. `bubbleSelector` names the bubble so a scroll within it does
 * not close it; surfaces other than the diff preview pass their own.
 */
export function useDiffHoverPreviewDismiss<T>(
  preview: T | null,
  closePreview: () => void,
  bubbleSelector = '.diff-hover-preview'
) {
  useEffect(() => {
    if (!preview) return
    const closePreviewOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePreview()
    }
    const closePreviewOnScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest(bubbleSelector)) return
      if (typeof document !== 'undefined' && document.querySelector(`${bubbleSelector}:hover`)) return
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
  }, [bubbleSelector, closePreview, preview])
}

/**
 * Hover open/close timing + the currently shown preview.
 *
 * Generic over the preview payload so a surface whose bubble is not a diff can
 * share the same dwell behaviour — the Task-complete Sub-threads rows show an
 * Agent Invocation. `DiffHoverPreviewState` stays the default, so every
 * existing call site is unchanged.
 */
export function useDiffHoverPreviewState<T = DiffHoverPreviewState>(
  delayMs = DIFF_HOVER_PREVIEW_CLOSE_DELAY_MS,
  openDelayMs = 0
) {
  const [preview, setPreview] = useState<T | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const openTimerRef = useRef<number | null>(null)

  const keepPreviewOpen = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === 'undefined') return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const cancelScheduledShow = useCallback(() => {
    if (openTimerRef.current === null || typeof window === 'undefined') return
    window.clearTimeout(openTimerRef.current)
    openTimerRef.current = null
  }, [])

  const closePreview = useCallback(() => {
    cancelScheduledShow()
    keepPreviewOpen()
    setPreview(null)
  }, [cancelScheduledShow, keepPreviewOpen])

  const showPreview = useCallback(
    (nextPreview: T) => {
      cancelScheduledShow()
      keepPreviewOpen()
      setPreview(nextPreview)
    },
    [cancelScheduledShow, keepPreviewOpen]
  )

  // Deferred open for hover: the producer runs when the timer fires so the
  // anchor rect is measured at show time, not at schedule time (the row can
  // scroll or unmount during the wait — return null to abort). A currently
  // open preview stays visible until the new one replaces it.
  const scheduleShowPreview = useCallback(
    (produce: () => T | null) => {
      cancelScheduledShow()
      keepPreviewOpen()
      if (openDelayMs <= 0 || typeof window === 'undefined') {
        const nextPreview = produce()
        if (nextPreview) setPreview(nextPreview)
        return
      }
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null
        const nextPreview = produce()
        if (nextPreview) setPreview(nextPreview)
      }, openDelayMs)
    },
    [cancelScheduledShow, keepPreviewOpen, openDelayMs]
  )

  const scheduleClosePreview = useCallback(() => {
    cancelScheduledShow()
    keepPreviewOpen()
    if (typeof window === 'undefined') {
      setPreview(null)
      return
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setPreview(null)
    }, delayMs)
  }, [cancelScheduledShow, delayMs, keepPreviewOpen])

  useEffect(
    () => () => {
      cancelScheduledShow()
      keepPreviewOpen()
    },
    [cancelScheduledShow, keepPreviewOpen]
  )

  return {
    closePreview,
    keepPreviewOpen,
    preview,
    scheduleClosePreview,
    scheduleShowPreview,
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
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const actionRef = useRef<HTMLButtonElement | null>(null)
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)
  const [fileListExpanded, setFileListExpanded] = useState(false)
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
  const language = useMemo(
    () => languageFromPath(preview?.summary.path),
    [preview?.summary.path]
  )
  const highlightSpansByLine = useMemo(() => {
    const map = new Map<ParsedDiffLine, HighlightSpan[]>()
    if (!parsed) return map
    const renderableLines: ParsedDiffLine[] = []
    parsed.sections.forEach((section) => {
      section.lines.forEach((line) => {
        if (isRenderableDiffLine(line)) renderableLines.push(line)
      })
    })
    if (renderableLines.length === 0) return map
    ensureEditorHighlightStylesMounted()
    const spanLines = highlightCodeToLineSpans(
      renderableLines.map((line) => diffLineDisplayText(line)).join('\n'),
      language
    )
    renderableLines.forEach((line, index) => map.set(line, spanLines[index] ?? []))
    return map
  }, [language, parsed])
  const fileWindow = useMemo(
    () =>
      getDiffHoverPreviewFileWindow(
        preview?.summary.files,
        fileListExpanded,
        preview?.summary.fileCount
      ),
    [fileListExpanded, preview?.summary.fileCount, preview?.summary.files]
  )

  useEffect(() => {
    setFileListExpanded(false)
  }, [preview?.summary.path])

  useEffect(() => {
    if (!preview?.focusTarget) return
    const target =
      preview.focusTarget === 'action'
        ? actionRef.current || overlayRef.current
        : overlayRef.current
    target?.focus({ preventScroll: true })
  }, [preview?.focusTarget, preview?.summary.path])

  const previewIdentity = preview
    ? [
        preview.summary.path,
        preview.summary.status || '',
        preview.summary.additions ?? '',
        preview.summary.deletions ?? '',
        preview.summary.diffText?.length ?? 0,
        preview.summary.files?.length ?? 0,
        preview.summary.fileCount ?? 0,
        fileWindow.visibleCount,
        preview.action?.label || ''
      ].join('|')
    : ''

  useLayoutEffect(() => {
    if (!preview) {
      if (measuredHeight !== null) setMeasuredHeight(null)
      return
    }
    const height = overlayRef.current?.getBoundingClientRect().height
    if (!height || !Number.isFinite(height)) return
    const roundedHeight = Math.ceil(height)
    setMeasuredHeight((current) =>
      current !== null && Math.abs(current - roundedHeight) <= 1 ? current : roundedHeight
    )
  }, [measuredHeight, preview, previewIdentity])

  if (!preview || typeof document === 'undefined') return null

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const layout = getDiffHoverPreviewLayout({
    anchor: preview.anchor,
    boundary: preview.boundary,
    previewHeight: measuredHeight ?? undefined,
    viewportHeight,
    viewportWidth
  })
  const stats = getDiffHoverPreviewStats(preview.summary)
  const changeText = stats.map((stat) => stat.label).join(' ')
  const statusText = preview.summary.status || 'modified'
  const sourceLabel = diffHoverPreviewSourceLabel(preview.summary.source)
  const role = diffHoverPreviewRole(Boolean(preview.action))
  const snapshotLabel = preview.summary.snapshot ? 'tool snapshot' : ''
  const badgeLabel = [sourceLabel, statusText, snapshotLabel, changeText].filter(Boolean).join(' ')
  const hiddenLineCount =
    parsed && (parsed.omittedLineCount > 0 || preparedDiff?.capped)
      ? Math.max(parsed.omittedLineCount, 1)
      : 0

  const overlay = (
    <div
      ref={overlayRef}
      id={DIFF_HOVER_PREVIEW_TOOLTIP_ID}
      className="diff-hover-preview"
      data-source={preview.summary.source || 'generic'}
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
      role={role}
      aria-label={`Diff preview for ${preview.summary.path}`}
      tabIndex={0}
    >
      <div
        className="diff-hover-preview-bridge"
        style={{
          position: 'absolute',
          top: '-14px',
          bottom: '-14px',
          left: '0',
          right: '0',
          zIndex: -1
        }}
      />
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
        <div className="diff-hover-preview-badges" aria-label={badgeLabel}>
          <span className="diff-hover-preview-status">{sourceLabel}</span>
          <span className="diff-hover-preview-status">{statusText}</span>
          {snapshotLabel && <span className="diff-hover-preview-status">{snapshotLabel}</span>}
          {stats.length > 0 && (
            <span className="diff-hover-preview-stats" aria-label={changeText}>
              {stats.map((stat) => (
                <span
                  key={stat.kind}
                  className={`diff-hover-preview-stat ${stat.kind}`}
                  aria-label={stat.ariaLabel}
                >
                  {stat.label}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="diff-hover-preview-body">
        {fileWindow.files.length > 0 ? (
          <div className="diff-hover-preview-file-list" role="list">
            {fileWindow.files.map((file, index) => (
              <div
                className="diff-hover-preview-file-row"
                role="listitem"
                key={`${file.path}-${index}`}
              >
                <span className="diff-hover-preview-file-path" title={file.path}>
                  {file.path}
                </span>
                <span className="diff-hover-preview-file-stats">
                  {typeof file.additions === 'number' && (
                    <span className="diff-hover-preview-stat add">+{file.additions}</span>
                  )}
                  {typeof file.deletions === 'number' && (
                    <span className="diff-hover-preview-stat delete">-{file.deletions}</span>
                  )}
                </span>
              </div>
            ))}
            {fileWindow.canShowMore && (
              <button
                className="diff-hover-preview-file-more"
                type="button"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setFileListExpanded(true)
                }}
              >
                Show {fileWindow.nextShowCount} more file
                {fileWindow.nextShowCount === 1 ? '' : 's'}
              </button>
            )}
            {fileListExpanded && fileWindow.hiddenAfterCap > 0 && (
              <div className="diff-hover-preview-file-cap-note">
                +{fileWindow.hiddenAfterCap} more file
                {fileWindow.hiddenAfterCap === 1 ? '' : 's'} not shown
              </div>
            )}
          </div>
        ) : parsed && parsed.sections.length > 0 ? (
          parsed.sections.map((section, sectionIndex) => (
            <div key={sectionIndex} className="diff-hover-preview-section">
              {section.header && <div className="diff-hover-preview-hunk">{section.header}</div>}
              {section.lines.filter(isRenderableDiffLine).map((line, lineIndex) => (
                <DiffHoverPreviewLine
                  key={`${sectionIndex}-${lineIndex}`}
                  line={line}
                  spans={highlightSpansByLine.get(line)}
                />
              ))}
            </div>
          ))
        ) : (
          <div className="diff-hover-preview-empty">
            {diffHoverPreviewEmptyMessage(preview.summary, Boolean(preparedDiff))}
          </div>
        )}
      </div>
      <div className="diff-hover-preview-footer">
        <span>{preview.summary.actionLabel || 'Hover preview'}</span>
        <div className="diff-hover-preview-footer-actions">
          <span>
            {fileWindow.files.length > 0
              ? `${fileWindow.visibleCount.toLocaleString()} of ${Math.min(
                  fileWindow.previewableCount,
                  DIFF_HOVER_PREVIEW_FILE_MAX_VISIBLE
                ).toLocaleString()} files shown`
              : parsed
              ? `${parsed.renderedLineCount.toLocaleString()} lines shown${
                  hiddenLineCount > 0 ? ` · ${hiddenLineCount.toLocaleString()} hidden` : ''
                }`
              : preview.summary.emptyFooterLabel || 'No hunks captured'}
          </span>
          {preview.action && (
            <button
              ref={actionRef}
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
