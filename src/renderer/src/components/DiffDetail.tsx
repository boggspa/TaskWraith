import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import type { GitFileStatus } from '../../../main/services/GitService'
import type { DiffFileSummary, DiffPreviewKind } from '../../../main/store/types'
import {
  ensureEditorHighlightStylesMounted,
  highlightCodeToLineSpans,
  languageFromPath,
  type HighlightSpan
} from './highlightCodeLines'
import { useCopyFeedback } from '../lib/useCopyFeedback'
import {
  DEFAULT_DIFF_RENDER_LINE_LIMIT,
  diffLineDisplayText,
  diffLineNumber,
  isRenderableDiffLine,
  parseUnifiedDiff,
  type ParsedDiffLine,
  type ParsedUnifiedDiff
} from '../lib/unifiedDiffParser'
import type { DiffViewMode } from './DiffViewerTypes'

export interface DiffDetailProps {
  summary: DiffFileSummary
  gitStatus?: GitFileStatus
  busyPath?: string
  viewMode: DiffViewMode
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
}

interface DiffLineRowProps {
  line: ParsedDiffLine
  newSpans?: HighlightSpan[]
  oldSpans?: HighlightSpan[]
}

interface DiffLinesProps {
  filePath?: string
  parsed: ParsedUnifiedDiff | null
  viewMode: DiffViewMode
  onShowMore?: () => void
  renderCapReached?: boolean
  showMoreLineCount?: number
  sourceOmittedLineCount?: number
  sourceTruncated?: boolean
}

interface DiffRenderRow {
  id: string
  kind: 'empty' | 'line' | 'sectionHeader'
  header?: string
  line?: ParsedDiffLine
}

interface DiffVirtualRange {
  endIndex: number
  paddingBottom: number
  paddingTop: number
  startIndex: number
}

interface DiffHighlightSet {
  lookup: Map<string, { new?: number; old?: number }>
  new: HighlightSpan[][]
  old: HighlightSpan[][]
}

const DIFF_DETAIL_RENDER_LINE_LIMIT = DEFAULT_DIFF_RENDER_LINE_LIMIT
const DIFF_DETAIL_MAX_RENDER_LINE_LIMIT = 10_000
const DIFF_VIRTUALIZATION_THRESHOLD = 800
const DIFF_VIRTUAL_ROW_HEIGHT = 22
const DIFF_VIRTUAL_OVERSCAN = 24
const DIFF_TEXT_PREVIEW_CHAR_LIMIT = 20_000

export interface DiffTextPreviewExcerpt {
  omittedChars: number
  text: string
  truncated: boolean
}

export interface DiffLineGutterWidths {
  inline: string
  new: string
  old: string
}

export function diffTextPreviewExcerpt(
  text: string,
  limit = DIFF_TEXT_PREVIEW_CHAR_LIMIT
): DiffTextPreviewExcerpt {
  if (text.length <= limit) {
    return { omittedChars: 0, text, truncated: false }
  }
  const newlineIndex = text.lastIndexOf('\n', limit)
  const endIndex = newlineIndex >= Math.floor(limit * 0.8) ? newlineIndex : limit
  return {
    omittedChars: text.length - endIndex,
    text: text.slice(0, endIndex),
    truncated: true
  }
}

export const diffDetailPathDisplay = (path: string): { name: string; parent: string } => {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop() || path || 'file'
  return {
    name,
    parent: parts.join('/')
  }
}

export const diffLineGutterWidths = (parsed: ParsedUnifiedDiff | null): DiffLineGutterWidths => {
  let oldDigits = 1
  let newDigits = 1

  parsed?.sections.forEach((section) => {
    section.lines.forEach((line) => {
      if (line.oldLine !== null) {
        oldDigits = Math.max(oldDigits, String(line.oldLine).length)
      }
      if (line.newLine !== null) {
        newDigits = Math.max(newDigits, String(line.newLine).length)
      }
    })
  })

  const old = `${Math.max(4, oldDigits + 2)}ch`
  const next = `${Math.max(4, newDigits + 2)}ch`
  return {
    inline: `${Math.max(4, Math.max(oldDigits, newDigits) + 2)}ch`,
    old,
    new: next
  }
}

const diffStatusLabel = (status: DiffFileSummary['status']): string => {
  if (status === 'hidden_sensitive') return 'hidden'
  if (status === 'too_large') return 'large'
  return status.replace(/_/g, ' ')
}

export const diffDetailHeaderSummary = (
  summary: Pick<DiffFileSummary, 'additions' | 'deletions' | 'status'>
): string => {
  const parts = [diffStatusLabel(summary.status)]
  if (summary.additions !== undefined || summary.deletions !== undefined) {
    parts.push(`+${summary.additions ?? 0}`)
    parts.push(`-${summary.deletions ?? 0}`)
  }
  return parts.join(' ')
}

export function DiffDetail({
  summary,
  gitStatus,
  busyPath,
  viewMode,
  onOpenFile,
  onStageFile,
  onUnstageFile
}: DiffDetailProps) {
  const { copiedId, copy } = useCopyFeedback()
  const [renderLineLimit, setRenderLineLimit] = useState(DIFF_DETAIL_RENDER_LINE_LIMIT)
  const isBusy = busyPath === summary.path
  const canOpenFile =
    Boolean(onOpenFile) &&
    summary.status !== 'deleted' &&
    summary.status !== 'binary' &&
    summary.status !== 'hidden_sensitive' &&
    summary.previewKind !== 'binary' &&
    summary.previewKind !== 'hidden'
  const canStageFile = Boolean(onStageFile) && Boolean(gitStatus?.unstaged) && !isBusy
  const canUnstageFile = Boolean(onUnstageFile) && Boolean(gitStatus?.staged) && !isBusy
  const previewKind: DiffPreviewKind = summary.previewKind || 'none'
  const headerSummary = diffDetailHeaderSummary(summary)
  const pathDisplay = diffDetailPathDisplay(summary.path)
  const actionClass = 'segmented-control-action segmented-control-action--compact'
  const usesDiffLines =
    Boolean(summary.diffText) && (previewKind === 'synthetic_new_file' || previewKind === 'git_diff')
  const parsedDiff = useMemo(
    () =>
      summary.diffText
        ? parseUnifiedDiff(summary.diffText, { maxLines: renderLineLimit })
        : null,
    [renderLineLimit, summary.diffText]
  )
  const textPreview = useMemo(
    () => diffTextPreviewExcerpt(summary.diffText ?? ''),
    [summary.diffText]
  )

  useEffect(() => {
    setRenderLineLimit(DIFF_DETAIL_RENDER_LINE_LIMIT)
  }, [summary.diffText, summary.path])

  const showMoreDiffLines = () => {
    setRenderLineLimit((current) =>
      Math.min(current + DIFF_DETAIL_RENDER_LINE_LIMIT, DIFF_DETAIL_MAX_RENDER_LINE_LIMIT)
    )
  }
  const showMoreLineCount = Math.max(
    0,
    Math.min(
      DIFF_DETAIL_RENDER_LINE_LIMIT,
      DIFF_DETAIL_MAX_RENDER_LINE_LIMIT - renderLineLimit,
      parsedDiff?.omittedLineCount ?? 0
    )
  )
  const renderCapReached =
    Boolean(parsedDiff?.truncated) && renderLineLimit >= DIFF_DETAIL_MAX_RENDER_LINE_LIMIT

  const renderPreview = () => {
    switch (previewKind) {
      case 'hidden':
        return (
          <div
            style={{
              padding: 'var(--space-md)',
              color: 'var(--warning)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            Sensitive file — preview hidden
          </div>
        )
      case 'binary':
        return (
          <div
            style={{
              padding: 'var(--space-md)',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            Binary file
          </div>
        )
      case 'synthetic_new_file':
      case 'git_diff':
        return summary.diffText ? (
          <DiffLines
            parsed={parsedDiff}
            viewMode={viewMode}
            filePath={summary.path}
            onShowMore={showMoreLineCount > 0 ? showMoreDiffLines : undefined}
            renderCapReached={renderCapReached}
            showMoreLineCount={showMoreLineCount}
            sourceOmittedLineCount={summary.diffTextOmittedLines}
            sourceTruncated={summary.diffTextTruncated}
          />
        ) : (
          <div
            style={{
              padding: 'var(--space-md)',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            No diff available.
          </div>
        )
      case 'text_preview':
        return (
          <div className="diff-text-preview">
            {(summary.diffTextTruncated || textPreview.truncated) && (
              <div className="diff-text-preview-note" role="note">
                Preview capped before rendering.
                {summary.diffTextOmittedLines
                  ? ` ${summary.diffTextOmittedLines.toLocaleString()} source lines were omitted.`
                  : textPreview.truncated
                    ? ` ${textPreview.omittedChars.toLocaleString()} characters were omitted.`
                    : ' Some source text may be omitted.'}
              </div>
            )}
            <pre>{textPreview.text}</pre>
          </div>
        )
      default:
        return (
          <div
            style={{
              padding: 'var(--space-md)',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)'
            }}
          >
            No preview available.
          </div>
        )
    }
  }

  return (
    <div className="diff-detail">
      <div className="diff-detail-header">
        <div className="diff-detail-title">
          <span className="diff-detail-path" title={summary.path}>
            <strong>{pathDisplay.name}</strong>
            {pathDisplay.parent && <small>{pathDisplay.parent}</small>}
          </span>
          <span
            className="diff-detail-stat-badge"
            data-status={summary.status}
            aria-label={`File change summary: ${headerSummary}`}
          >
            {headerSummary}
          </span>
        </div>
        <div className="diff-detail-actions">
          <button
            className={actionClass}
            type="button"
            onClick={() => onOpenFile?.(summary.path)}
            disabled={!canOpenFile}
            title={canOpenFile ? 'Open file in editor' : 'This diff item cannot be opened'}
          >
            Open
          </button>
          {(onStageFile || onUnstageFile) && (
            <>
              <button
                className={actionClass}
                type="button"
                onClick={() => void onStageFile?.(summary.path)}
                disabled={!canStageFile}
                title={canStageFile ? 'Stage this file' : 'No unstaged changes to stage'}
              >
                {isBusy ? 'Working' : 'Stage'}
              </button>
              <button
                className={actionClass}
                type="button"
                onClick={() => void onUnstageFile?.(summary.path)}
                disabled={!canUnstageFile}
                title={canUnstageFile ? 'Unstage this file' : 'No staged changes to unstage'}
              >
                Unstage
              </button>
            </>
          )}
          <button
            className={actionClass}
            type="button"
            onClick={() => summary.diffText && copy('diff', summary.diffText)}
            title="Copy diff"
          >
            {copiedId === 'diff' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div className={`diff-detail-body ${usesDiffLines ? 'diff-detail-body-diff' : ''}`}>
        {renderPreview()}
      </div>
    </div>
  )
}

const emptyDiffHighlights = (): DiffHighlightSet => ({
  lookup: new Map(),
  new: [],
  old: []
})

const collectDiffHighlights = (
  parsed: ParsedUnifiedDiff | null,
  filePath?: string
): DiffHighlightSet => {
  if (!parsed) return emptyDiffHighlights()
  ensureEditorHighlightStylesMounted()
  const language = languageFromPath(filePath)
  const oldTexts: string[] = []
  const newTexts: string[] = []
  const lookup = new Map<string, { new?: number; old?: number }>()

  parsed.sections.forEach((section, sectionIndex) => {
    section.lines.forEach((line, lineIndex) => {
      if (!isRenderableDiffLine(line)) return
      const key = `${sectionIndex}:line:${lineIndex}`
      const display = diffLineDisplayText(line)
      const entry: { new?: number; old?: number } = {}
      if (line.kind === 'del' || line.kind === 'context') {
        entry.old = oldTexts.length
        oldTexts.push(display)
      }
      if (line.kind === 'add' || line.kind === 'context') {
        entry.new = newTexts.length
        newTexts.push(display)
      }
      lookup.set(key, entry)
    })
  })

  return {
    lookup,
    old: highlightCodeToLineSpans(oldTexts.join('\n'), language),
    new: highlightCodeToLineSpans(newTexts.join('\n'), language)
  }
}

const buildDiffRows = (parsed: ParsedUnifiedDiff): DiffRenderRow[] => {
  const rows: DiffRenderRow[] = []
  parsed.sections.forEach((section, sectionIndex) => {
    if (section.header) {
      rows.push({
        id: `${sectionIndex}:header`,
        kind: 'sectionHeader',
        header: section.header
      })
    }
    const lines = section.lines.filter(isRenderableDiffLine)
    if (lines.length === 0) {
      if (!section.header) return
      return
    }
    section.lines.forEach((line, lineIndex) => {
      if (!isRenderableDiffLine(line)) return
      rows.push({
        id: `${sectionIndex}:line:${lineIndex}`,
        kind: 'line',
        line
      })
    })
  })
  return rows
}

export const diffVirtualizationSummary = (
  totalRows: number,
  range: Pick<DiffVirtualRange, 'endIndex' | 'startIndex'>,
  enabled: boolean
): string => {
  if (!enabled || totalRows <= 0) return ''
  const mountedRows = Math.max(0, range.endIndex - range.startIndex)
  const firstRow = Math.min(totalRows, range.startIndex + 1)
  const lastRow = Math.min(totalRows, range.endIndex)
  return `Windowing ${mountedRows.toLocaleString()} of ${totalRows.toLocaleString()} rows · showing ${firstRow.toLocaleString()}-${lastRow.toLocaleString()}`
}

function DiffLines({
  parsed,
  viewMode,
  filePath,
  onShowMore,
  renderCapReached = false,
  showMoreLineCount,
  sourceOmittedLineCount,
  sourceTruncated = false
}: DiffLinesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 })
  const rows = useMemo(() => (parsed ? buildDiffRows(parsed) : []), [parsed])
  const highlights = useMemo(() => collectDiffHighlights(parsed, filePath), [filePath, parsed])
  const gutterWidths = useMemo(() => diffLineGutterWidths(parsed), [parsed])
  const gutterStyle = {
    '--diff-gutter-width': gutterWidths.inline,
    '--diff-new-gutter-width': gutterWidths.new,
    '--diff-old-gutter-width': gutterWidths.old
  } as CSSProperties

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const updateViewport = () => {
      setViewport({
        height: scrollElement.clientHeight,
        scrollTop: scrollElement.scrollTop
      })
    }

    updateViewport()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateViewport)
      observer.observe(scrollElement)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [rows.length])

  if (!parsed || parsed.sections.length === 0) {
    return <div className="diff-lines-section">No diff hunks to display.</div>
  }

  const useVirtualization = rows.length > DIFF_VIRTUALIZATION_THRESHOLD
  const nextLineCount =
    showMoreLineCount ?? Math.min(DIFF_DETAIL_RENDER_LINE_LIMIT, parsed.omittedLineCount)
  const visibleRange: DiffVirtualRange = (() => {
    if (!useVirtualization) {
      return {
        endIndex: rows.length,
        paddingBottom: 0,
        paddingTop: 0,
        startIndex: 0
      }
    }
    const viewportHeight = Math.max(viewport.height, DIFF_VIRTUAL_ROW_HEIGHT * 12)
    const visibleCount =
      Math.ceil(viewportHeight / DIFF_VIRTUAL_ROW_HEIGHT) + DIFF_VIRTUAL_OVERSCAN * 2
    const startIndex = Math.max(
      0,
      Math.floor(viewport.scrollTop / DIFF_VIRTUAL_ROW_HEIGHT) - DIFF_VIRTUAL_OVERSCAN
    )
    const endIndex = Math.min(rows.length, startIndex + visibleCount)
    return {
      endIndex,
      paddingBottom: Math.max(0, rows.length - endIndex) * DIFF_VIRTUAL_ROW_HEIGHT,
      paddingTop: startIndex * DIFF_VIRTUAL_ROW_HEIGHT,
      startIndex
    }
  })()
  const currentVirtualHeader = (() => {
    if (!useVirtualization) return ''
    for (let index = Math.min(rows.length - 1, visibleRange.startIndex); index >= 0; index -= 1) {
      const row = rows[index]
      if (row?.kind === 'sectionHeader') return row.header ?? ''
    }
    return ''
  })()
  const visibleRows = rows.slice(visibleRange.startIndex, visibleRange.endIndex)
  const virtualSummary = diffVirtualizationSummary(rows.length, visibleRange, useVirtualization)

  const handleScroll = () => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    setViewport({
      height: scrollElement.clientHeight,
      scrollTop: scrollElement.scrollTop
    })
  }

  return (
    <div className="diff-lines-root" style={gutterStyle}>
      {sourceTruncated && (
        <div className="diff-lines-truncated diff-lines-source-truncated" role="note">
          <span>
            Preview capped before rendering.
            {sourceOmittedLineCount
              ? ` ${sourceOmittedLineCount.toLocaleString()} source lines were omitted.`
              : ' Some source lines may be omitted.'}
          </span>
        </div>
      )}
      {parsed.truncated && (
        <div className="diff-lines-truncated" role="note">
          <span>
            Showing first {parsed.renderedLineCount.toLocaleString()} lines.{' '}
            {parsed.omittedLineCount.toLocaleString()} more omitted.
            {renderCapReached ? ' Rendering capped for performance.' : ''}
          </span>
          {onShowMore && nextLineCount > 0 && (
            <button className="diff-lines-show-more" type="button" onClick={onShowMore}>
              Show {nextLineCount.toLocaleString()} more
            </button>
          )}
        </div>
      )}
      {virtualSummary && (
        <div className="diff-lines-virtualization-note" role="note">
          {virtualSummary}
        </div>
      )}
      <DiffLinesColumnHeader viewMode={viewMode} />
      <div
        className={`diff-lines-stack ${useVirtualization ? 'virtualized' : ''}`}
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {currentVirtualHeader && (
          <div className="diff-lines-floating-header" title={currentVirtualHeader} />
        )}
        <div
          className="diff-lines-virtual-window"
          style={
            useVirtualization
              ? {
                  paddingBottom: `${visibleRange.paddingBottom}px`,
                  paddingTop: `${visibleRange.paddingTop}px`
                }
              : undefined
          }
        >
          {visibleRows.map((row) => renderDiffRow(row, viewMode, highlights))}
        </div>
      </div>
    </div>
  )
}

function DiffLinesColumnHeader({ viewMode }: { viewMode: DiffViewMode }) {
  if (viewMode !== 'split') return null
  return (
    <div className="diff-lines-column-header split" role="presentation">
      <span>Old</span>
      <span>Original</span>
      <span>New</span>
      <span>Modified</span>
    </div>
  )
}

function renderDiffRow(row: DiffRenderRow, viewMode: DiffViewMode, highlights: DiffHighlightSet) {
  if (row.kind === 'sectionHeader') {
    return (
      <div
        key={row.id}
        className="diff-lines-section-header"
        title={row.header}
        aria-label={row.header}
      />
    )
  }
  if (row.kind === 'empty') {
    return (
      <div key={row.id} className="diff-line">
        No content in this section.
      </div>
    )
  }
  if (!row.line) return null
  const sides = highlights.lookup.get(row.id)
  const oldSpans = sides?.old != null ? highlights.old[sides.old] : undefined
  const newSpans = sides?.new != null ? highlights.new[sides.new] : undefined
  return viewMode === 'split' ? (
    <SplitDiffLineRow key={row.id} line={row.line} oldSpans={oldSpans} newSpans={newSpans} />
  ) : (
    <DiffLineRow key={row.id} line={row.line} newSpans={newSpans} oldSpans={oldSpans} />
  )
}

function renderHighlightedSpans(spans: HighlightSpan[] | undefined, fallback: string): ReactNode {
  if (!spans || spans.length === 0) return fallback || ' '
  return spans.map((span, index) =>
    span.className ? (
      <span className={span.className} key={index}>
        {span.text}
      </span>
    ) : (
      <Fragment key={index}>{span.text}</Fragment>
    )
  )
}

function DiffLineRow({ line, newSpans, oldSpans }: DiffLineRowProps) {
  const className = `diff-line ${line.kind === 'context' ? '' : line.kind}`.trim()
  const spans = line.kind === 'del' ? oldSpans : newSpans
  return (
    <div className={className}>
      <span className="diff-line-marker" aria-hidden="true" />
      <span className="diff-line-gutter">{diffLineNumber(line) ?? ''}</span>
      <span className="diff-line-code">
        {renderHighlightedSpans(spans, diffLineDisplayText(line))}
      </span>
    </div>
  )
}

function SplitDiffLineRow({ line, oldSpans, newSpans }: DiffLineRowProps) {
  if (line.kind === 'meta') {
    return null
  }

  const className = `diff-line-split ${line.kind === 'context' ? '' : line.kind}`.trim()
  return (
    <div className={className}>
      <span className="diff-line-gutter old">{line.oldLine ?? ''}</span>
      <span className="diff-line-split-code old">
        {renderHighlightedSpans(oldSpans, diffLineDisplayText(line, 'old'))}
      </span>
      <span className="diff-line-gutter new">{line.newLine ?? ''}</span>
      <span className="diff-line-split-code new">
        {renderHighlightedSpans(newSpans, diffLineDisplayText(line, 'new'))}
      </span>
    </div>
  )
}
