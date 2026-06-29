import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { parseUnifiedDiff, type ParsedDiffLine } from '../lib/unifiedDiffParser'

export interface DiffHoverPreviewSummary {
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
}

export const DIFF_HOVER_PREVIEW_TOOLTIP_ID = 'diff-hover-preview-tooltip'

const DIFF_HOVER_PREVIEW_LINE_LIMIT = 96
const DIFF_HOVER_PREVIEW_RAW_LINE_LIMIT = 240
const DIFF_HOVER_PREVIEW_CHAR_LIMIT = 40_000
const DIFF_HOVER_PREVIEW_MIN_WIDTH = 560
const DIFF_HOVER_PREVIEW_MAX_WIDTH = 920
const DIFF_HOVER_PREVIEW_HEIGHT = 320
const DIFF_HOVER_PREVIEW_MARGIN = 12

export function diffHoverPreviewBoundaryForElement(element: HTMLElement): DOMRect | undefined {
  const boundary = element.closest(
    '.transcript-inner, .message-group, .activity-timeline, .live-activity-viewport'
  )
  return boundary instanceof HTMLElement ? boundary.getBoundingClientRect() : undefined
}

const prepareDiffHoverPreviewText = (diffText: string): { text: string; capped: boolean } => {
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
    window.addEventListener('scroll', closePreview, true)
    window.addEventListener('resize', closePreview)
    window.addEventListener('keydown', closePreviewOnEscape)
    return () => {
      window.removeEventListener('scroll', closePreview, true)
      window.removeEventListener('resize', closePreview)
      window.removeEventListener('keydown', closePreviewOnEscape)
    }
  }, [closePreview, preview])
}

export function DiffHoverPreviewOverlay({
  preview
}: {
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
  const boundaryLeft = Math.max(
    DIFF_HOVER_PREVIEW_MARGIN,
    preview.boundary?.left ?? DIFF_HOVER_PREVIEW_MARGIN
  )
  const boundaryRight = Math.min(
    viewportWidth - DIFF_HOVER_PREVIEW_MARGIN,
    preview.boundary?.right ?? viewportWidth - DIFF_HOVER_PREVIEW_MARGIN
  )
  const availableWidth = Math.max(320, boundaryRight - boundaryLeft)
  const width = Math.min(
    Math.max(preview.anchor.width, DIFF_HOVER_PREVIEW_MIN_WIDTH),
    DIFF_HOVER_PREVIEW_MAX_WIDTH,
    availableWidth,
    viewportWidth - DIFF_HOVER_PREVIEW_MARGIN * 2
  )
  const preferredTop = preview.anchor.top - DIFF_HOVER_PREVIEW_HEIGHT - 10
  const top =
    preferredTop >= DIFF_HOVER_PREVIEW_MARGIN
      ? preferredTop
      : Math.min(
          preview.anchor.bottom + 10,
          viewportHeight - DIFF_HOVER_PREVIEW_HEIGHT - DIFF_HOVER_PREVIEW_MARGIN
        )
  const left = Math.max(
    boundaryLeft,
    Math.min(preview.anchor.left, boundaryRight - width)
  )
  const statusText =
    preview.summary.additions !== undefined || preview.summary.deletions !== undefined
      ? `+${preview.summary.additions || 0} -${preview.summary.deletions || 0}`
      : preview.summary.status || 'modified'

  const overlay = (
    <div
      id={DIFF_HOVER_PREVIEW_TOOLTIP_ID}
      className="diff-hover-preview"
      style={{
        left: `${left}px`,
        top: `${Math.max(DIFF_HOVER_PREVIEW_MARGIN, top)}px`,
        width: `${width}px`
      }}
      role="tooltip"
    >
      <div className="diff-hover-preview-header">
        <span title={preview.summary.path}>{preview.summary.path}</span>
        <strong>{statusText}</strong>
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
      {(parsed.truncated || preparedDiff?.capped) && (
        <div className="diff-hover-preview-footer">
          {parsed.renderedLineCount.toLocaleString()} lines shown
          {parsed.omittedLineCount > 0 || preparedDiff?.capped
            ? ` · ${Math.max(parsed.omittedLineCount, 1).toLocaleString()} hidden`
            : ''}
        </div>
      )}
    </div>
  )

  return createPortal(overlay, document.body)
}
