import { useMemo, useState } from 'react'
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
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
}

interface DiffToolbarProps {
  changedCount: number
  totalCount: number
  hideNoise: boolean
  fileFilter: string
  onHideNoiseChange: (hideNoise: boolean) => void
  onFileFilterChange: (fileFilter: string) => void
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
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
}

interface DiffLineRowProps {
  line: ParsedDiffLine
}

const DIFF_DETAIL_RENDER_LINE_LIMIT = DEFAULT_DIFF_RENDER_LINE_LIMIT

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
  onOpenFile,
  onStageFile,
  onUnstageFile
}: DiffViewerProps) {
  const [hideNoise, setHideNoise] = useState(true)
  const [fileFilter, setFileFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

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
        onHideNoiseChange={setHideNoise}
        onFileFilterChange={setFileFilter}
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
              summary={selectedSummary}
              gitStatus={selectedGitStatus}
              busyPath={busyPath}
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
  onHideNoiseChange,
  onFileFilterChange
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
  onOpenFile,
  onStageFile,
  onUnstageFile
}: DiffDetailProps) {
  const { copiedId, copy } = useCopyFeedback()
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
  const parsedDiff = useMemo(
    () =>
      summary.diffText
        ? parseUnifiedDiff(summary.diffText, { maxLines: DIFF_DETAIL_RENDER_LINE_LIMIT })
        : null,
    [summary.diffText]
  )

  const renderPreview = () => {
    const kind: DiffPreviewKind = summary.previewKind || 'none'
    switch (kind) {
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
          <DiffLines parsed={parsedDiff} />
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
      {renderPreview()}
    </div>
  )
}

function DiffLines({ parsed }: { parsed: ParsedUnifiedDiff | null }) {
  if (!parsed || parsed.sections.length === 0) {
    return <div className="diff-lines-section">No diff hunks to display.</div>
  }

  return (
    <div className="diff-lines-stack">
      {parsed.truncated && (
        <div className="diff-lines-truncated" role="note">
          Showing first {parsed.renderedLineCount.toLocaleString()} lines.{' '}
          {parsed.omittedLineCount.toLocaleString()} more omitted.
        </div>
      )}
      {parsed.sections.map((section, sectionIndex) => (
        <div key={sectionIndex} className="diff-lines-section">
          {section.header ? (
            <div className="diff-lines-section-header">{section.header}</div>
          ) : null}
          {section.lines.length === 0 ? (
            <div className="diff-line">No content in this section.</div>
          ) : (
            section.lines.map((line, index) => <DiffLineRow key={index} line={line} />)
          )}
        </div>
      ))}
    </div>
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
