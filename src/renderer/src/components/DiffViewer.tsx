import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffFileSummary, DiffPreviewKind } from '../../../main/store/types'
import type {
  GitFileStatus,
  GitRepositorySnapshot
} from '../../../main/services/GitService'
import { FileTypeIcon } from './FileTypeIcon'
import { useCopyFeedback } from '../lib/useCopyFeedback'
import {
  DEFAULT_DIFF_RENDER_LINE_LIMIT,
  parseUnifiedDiff,
  type ParsedDiffLine,
  type ParsedUnifiedDiff
} from '../lib/unifiedDiffParser'

interface DiffViewerProps {
  diff: {
    type: string
    text?: string
    statusText?: string
    diffText?: string
    summaries?: DiffFileSummary[]
  } | null
  workspacePath?: string
  gitSnapshot?: GitRepositorySnapshot | null
  busyPath?: string
  selectionRequest?: DiffSelectionRequest | null
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
}

interface DiffSelectionRequest {
  path: string
  nonce: number
}

interface DiffToolbarProps {
  changedCount: number
  totalCount: number
  hideNoise: boolean
  fileFilter: string
  viewMode: DiffViewMode
  onHideNoiseChange: (hideNoise: boolean) => void
  onFileFilterChange: (fileFilter: string) => void
  onViewModeChange: (viewMode: DiffViewMode) => void
}

interface DiffFileListProps {
  summaries: DiffFileSummary[]
  selectedPath?: string
  workspacePath?: string
  gitStatusByPath: Map<string, GitFileStatus>
  repoPathForSummary: (summary: DiffFileSummary) => string
  onSelectPath: (path: string) => void
}

interface DiffDetailProps {
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
}

interface DiffLinesProps {
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

type DiffViewMode = 'inline' | 'split'

const DIFF_DETAIL_RENDER_LINE_LIMIT = DEFAULT_DIFF_RENDER_LINE_LIMIT
const DIFF_DETAIL_MAX_RENDER_LINE_LIMIT = 10_000
const DIFF_VIRTUALIZATION_THRESHOLD = 800
const DIFF_VIRTUAL_ROW_HEIGHT = 22
const DIFF_VIRTUAL_OVERSCAN = 24

const normalizeAbsolutePath = (path: string): string => {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

const repoPathForWorkspacePath = (
  workspacePath: string | undefined,
  repoRoot: string | undefined,
  filePath: string
): string => {
  if (!workspacePath || !repoRoot) return filePath
  const normalizedWorkspace = normalizeAbsolutePath(workspacePath)
  const normalizedRepo = normalizeAbsolutePath(repoRoot)
  if (normalizedWorkspace === normalizedRepo) return filePath
  if (normalizedWorkspace.startsWith(`${normalizedRepo}/`)) {
    return `${normalizedWorkspace.slice(normalizedRepo.length + 1)}/${filePath}`
  }
  return filePath
}

const diffStageGroup = (
  summary: DiffFileSummary,
  gitStatus?: GitFileStatus
): 'mixed' | 'unstaged' | 'staged' | 'untracked' | 'other' => {
  if (gitStatus?.staged && gitStatus?.unstaged) return 'mixed'
  if (gitStatus?.unstaged) return 'unstaged'
  if (gitStatus?.staged) return 'staged'
  if (summary.status === 'untracked') return 'untracked'
  return 'other'
}

const diffStageGroupLabel = (group: ReturnType<typeof diffStageGroup>): string => {
  switch (group) {
    case 'mixed':
      return 'Staged + Unstaged'
    case 'unstaged':
      return 'Unstaged'
    case 'staged':
      return 'Staged'
    case 'untracked':
      return 'Untracked'
    default:
      return 'Other'
  }
}

export function DiffViewer({
  diff,
  workspacePath,
  gitSnapshot,
  busyPath,
  selectionRequest,
  onOpenFile,
  onStageFile,
  onUnstageFile
}: DiffViewerProps) {
  const [hideNoise, setHideNoise] = useState(true)
  const [fileFilter, setFileFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>('inline')

  const summaries = diff?.summaries || []
  const normalizedFileFilter = fileFilter.trim().toLowerCase()
  const gitStatusByPath = useMemo(() => {
    const byPath = new Map<string, GitFileStatus>()
    for (const file of gitSnapshot?.files ?? []) {
      byPath.set(file.path, file)
    }
    return byPath
  }, [gitSnapshot?.files])
  const repoPathForSummary = useMemo(
    () => (summary: DiffFileSummary) =>
      repoPathForWorkspacePath(workspacePath, gitSnapshot?.repoRoot, summary.path),
    [gitSnapshot?.repoRoot, workspacePath]
  )
  const filteredSummaries = summaries.filter((summary) => {
    if (hideNoise && summary.isNoise) return false
    if (!normalizedFileFilter) return true
    const repoPath = repoPathForSummary(summary)
    return (
      summary.path.toLowerCase().includes(normalizedFileFilter) ||
      repoPath.toLowerCase().includes(normalizedFileFilter) ||
      summary.status.toLowerCase().includes(normalizedFileFilter)
    )
  })
  const selectedSummary =
    filteredSummaries.find((s) => s.path === selectedPath) || filteredSummaries[0] || null
  const selectedGitStatus = selectedSummary
    ? gitStatusByPath.get(repoPathForSummary(selectedSummary))
    : undefined
  const hiddenNoiseCount = hideNoise ? summaries.filter((summary) => summary.isNoise).length : 0
  const emptyDiffMessage = normalizedFileFilter
    ? `No changed files match "${fileFilter.trim()}".`
    : hiddenNoiseCount > 0
      ? `0 shown; ${hiddenNoiseCount} hidden by Hide noise.`
      : 'No changes to display.'

  useEffect(() => {
    if (!selectionRequest?.path) return
    setSelectedPath(selectionRequest.path)
    setFileFilter('')
    setHideNoise(false)
  }, [selectionRequest])

  if (!diff)
    return (
      <div
        style={{
          color: 'var(--text-muted)',
          padding: 'var(--space-md)',
          fontSize: 'var(--font-size-sm)'
        }}
      >
        Run a task to see changes.
      </div>
    )
  if (diff.type === 'not_repo' || diff.type === 'no_changes')
    return (
      <div
        style={{
          color: 'var(--text-muted)',
          padding: 'var(--space-md)',
          fontSize: 'var(--font-size-sm)'
        }}
      >
        {diff.text || diff.statusText || 'No changes.'}
      </div>
    )
  if (diff.type === 'error')
    return (
      <div
        style={{
          color: 'var(--danger)',
          padding: 'var(--space-md)',
          fontSize: 'var(--font-size-sm)'
        }}
      >
        {diff.text}
      </div>
    )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DiffToolbar
        changedCount={filteredSummaries.length}
        totalCount={summaries.length}
        hideNoise={hideNoise}
        fileFilter={fileFilter}
        viewMode={viewMode}
        onHideNoiseChange={setHideNoise}
        onFileFilterChange={setFileFilter}
        onViewModeChange={setViewMode}
      />

      {filteredSummaries.length === 0 ? (
        <div
          style={{
            padding: 'var(--space-md)',
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-sm)'
          }}
        >
          {emptyDiffMessage}
        </div>
      ) : (
        <>
          <DiffFileList
            summaries={filteredSummaries}
            selectedPath={selectedSummary?.path}
            workspacePath={workspacePath}
            gitStatusByPath={gitStatusByPath}
            repoPathForSummary={repoPathForSummary}
            onSelectPath={setSelectedPath}
          />
          {selectedSummary && (
            <DiffDetail
              key={selectedSummary.path}
              summary={selectedSummary}
              gitStatus={selectedGitStatus}
              busyPath={busyPath}
              viewMode={viewMode}
              onOpenFile={onOpenFile}
              onStageFile={onStageFile}
              onUnstageFile={onUnstageFile}
            />
          )}
        </>
      )}
    </div>
  )
}

function DiffToolbar({
  changedCount,
  totalCount,
  hideNoise,
  fileFilter,
  viewMode,
  onHideNoiseChange,
  onFileFilterChange,
  onViewModeChange
}: DiffToolbarProps) {
  return (
    <div className="diff-studio-toolbar">
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
        {changedCount} of {totalCount} changed
      </span>
      <input
        className="diff-file-filter"
        type="search"
        aria-label="Filter changed files"
        value={fileFilter}
        onChange={(event) => onFileFilterChange(event.target.value)}
        placeholder="Filter files"
      />
      <label
        style={{
          fontSize: 'var(--font-size-xs)',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          color: 'var(--text-secondary)',
          cursor: 'pointer'
        }}
      >
        <input
          type="checkbox"
          checked={hideNoise}
          onChange={(event) => onHideNoiseChange(event.target.checked)}
        />
        Hide noise
      </label>
      <div className="diff-view-toggle" role="group" aria-label="Diff view mode">
        <button
          type="button"
          className={viewMode === 'inline' ? 'active' : ''}
          aria-pressed={viewMode === 'inline'}
          onClick={() => onViewModeChange('inline')}
        >
          Inline
        </button>
        <button
          type="button"
          className={viewMode === 'split' ? 'active' : ''}
          aria-pressed={viewMode === 'split'}
          onClick={() => onViewModeChange('split')}
        >
          Split
        </button>
      </div>
    </div>
  )
}

function DiffFileList({
  summaries,
  selectedPath,
  workspacePath,
  gitStatusByPath,
  repoPathForSummary,
  onSelectPath
}: DiffFileListProps) {
  const groupedSummaries = useMemo(() => {
    const groupOrder: Array<ReturnType<typeof diffStageGroup>> = [
      'mixed',
      'unstaged',
      'staged',
      'untracked',
      'other'
    ]
    const groups = new Map<ReturnType<typeof diffStageGroup>, DiffFileSummary[]>()
    for (const summary of summaries) {
      const group = diffStageGroup(summary, gitStatusByPath.get(repoPathForSummary(summary)))
      const entries = groups.get(group) ?? []
      entries.push(summary)
      groups.set(group, entries)
    }
    return groupOrder
      .map((group) => ({ group, summaries: groups.get(group) ?? [] }))
      .filter((section) => section.summaries.length > 0)
  }, [gitStatusByPath, repoPathForSummary, summaries])

  return (
    <div className="diff-file-list">
      {groupedSummaries.map((section) => (
        <section key={section.group} className="diff-file-section">
          <div className="diff-file-section-header">
            <span>{diffStageGroupLabel(section.group)}</span>
            <small>{section.summaries.length}</small>
          </div>
          {section.summaries.map((summary) => {
            const gitStatus = gitStatusByPath.get(repoPathForSummary(summary))
            return (
              <button
                type="button"
                key={summary.path}
                className={`diff-file-row ${selectedPath === summary.path ? 'selected' : ''}`}
                onClick={() => onSelectPath(summary.path)}
                aria-pressed={selectedPath === summary.path}
                title={`Show diff for ${summary.path}`}
              >
                <FileTypeIcon
                  path={summary.path}
                  size={14}
                  className="diff-file-type-icon"
                  workspacePath={workspacePath}
                />
                <span className="diff-file-name">{summary.path}</span>
                <span className={`diff-file-badge ${summary.status}`}>
                  {summary.additions !== undefined && summary.deletions !== undefined ? (
                    <>
                      <span className="diff-file-stat diff-file-stat-add">
                        +{summary.additions}
                      </span>
                      <span className="diff-file-stat-divider">|</span>
                      <span className="diff-file-stat diff-file-stat-delete">
                        -{summary.deletions}
                      </span>
                    </>
                  ) : (
                    summary.status
                  )}
                </span>
                {gitStatus && (
                  <span className="diff-file-state">
                    {gitStatus.staged && gitStatus.unstaged
                      ? 'S+U'
                      : gitStatus.staged
                        ? 'S'
                        : gitStatus.unstaged
                          ? 'U'
                          : ''}
                  </span>
                )}
              </button>
            )}
          )}
        </section>
      ))}
    </div>
  )
}

function DiffDetail({
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
  const usesDiffLines =
    Boolean(summary.diffText) && (previewKind === 'synthetic_new_file' || previewKind === 'git_diff')
  const parsedDiff = useMemo(
    () =>
      summary.diffText
        ? parseUnifiedDiff(summary.diffText, { maxLines: renderLineLimit })
        : null,
    [renderLineLimit, summary.diffText]
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
          <div
            style={{
              padding: 'var(--space-md)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--font-size-sm)',
              whiteSpace: 'pre-wrap'
            }}
          >
            {summary.diffText}
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
        <span>{summary.path}</span>
        <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          <button
            className="btn btn-sm btn-ghost"
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
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => void onStageFile?.(summary.path)}
                disabled={!canStageFile}
                title={canStageFile ? 'Stage this file' : 'No unstaged changes to stage'}
              >
                {isBusy ? 'Working' : 'Stage'}
              </button>
              <button
                className="btn btn-sm btn-ghost"
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
            className="btn btn-sm btn-ghost"
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
    if (section.lines.length === 0) {
      rows.push({
        id: `${sectionIndex}:empty`,
        kind: 'empty'
      })
      return
    }
    section.lines.forEach((line, lineIndex) => {
      rows.push({
        id: `${sectionIndex}:line:${lineIndex}`,
        kind: 'line',
        line
      })
    })
  })
  return rows
}

function DiffLines({
  parsed,
  viewMode,
  onShowMore,
  renderCapReached = false,
  showMoreLineCount,
  sourceOmittedLineCount,
  sourceTruncated = false
}: DiffLinesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 })
  const rows = useMemo(() => (parsed ? buildDiffRows(parsed) : []), [parsed])

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
  const visibleRange = (() => {
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

  const handleScroll = () => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    setViewport({
      height: scrollElement.clientHeight,
      scrollTop: scrollElement.scrollTop
    })
  }

  return (
    <div className="diff-lines-root">
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
            <button
              className="diff-lines-show-more"
              type="button"
              onClick={onShowMore}
            >
              Show {nextLineCount.toLocaleString()} more
            </button>
          )}
        </div>
      )}
      <div
        className={`diff-lines-stack ${useVirtualization ? 'virtualized' : ''}`}
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {currentVirtualHeader && (
          <div className="diff-lines-floating-header">{currentVirtualHeader}</div>
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
          {visibleRows.map((row) => renderDiffRow(row, viewMode))}
        </div>
      </div>
    </div>
  )
}

function renderDiffRow(row: DiffRenderRow, viewMode: DiffViewMode) {
  if (row.kind === 'sectionHeader') {
    return (
      <div key={row.id} className="diff-lines-section-header">
        {row.header}
      </div>
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
  return viewMode === 'split' ? (
    <SplitDiffLineRow key={row.id} line={row.line} />
  ) : (
    <DiffLineRow key={row.id} line={row.line} />
  )
}

function DiffLineRow({ line }: DiffLineRowProps) {
  const className = `diff-line ${line.kind === 'context' ? '' : line.kind}`.trim()
  return (
    <div className={className}>
      <span className="diff-line-gutter old">{line.oldLine ?? ''}</span>
      <span className="diff-line-gutter new">{line.newLine ?? ''}</span>
      <span className="diff-line-code">{line.text || ' '}</span>
    </div>
  )
}

const splitDiffText = (line: ParsedDiffLine, side: 'old' | 'new'): string => {
  if (line.kind === 'add' && side === 'old') return ''
  if (line.kind === 'del' && side === 'new') return ''
  if (line.kind === 'add') return line.text.replace(/^\+/, '')
  if (line.kind === 'del') return line.text.replace(/^-/, '')
  if (line.kind === 'context') return line.text.replace(/^ /, '')
  return line.text
}

function SplitDiffLineRow({ line }: DiffLineRowProps) {
  if (line.kind === 'meta') {
    return <div className="diff-line-split meta">{line.text || ' '}</div>
  }

  const className = `diff-line-split ${line.kind === 'context' ? '' : line.kind}`.trim()
  return (
    <div className={className}>
      <span className="diff-line-gutter old">{line.oldLine ?? ''}</span>
      <span className="diff-line-split-code old">{splitDiffText(line, 'old') || ' '}</span>
      <span className="diff-line-gutter new">{line.newLine ?? ''}</span>
      <span className="diff-line-split-code new">{splitDiffText(line, 'new') || ' '}</span>
    </div>
  )
}
