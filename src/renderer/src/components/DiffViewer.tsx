import { useMemo, useState } from 'react'
import type { DiffFileSummary, DiffPreviewKind } from '../../../main/store/types'
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
}

interface DiffToolbarProps {
  changedCount: number
  hideNoise: boolean
  onHideNoiseChange: (hideNoise: boolean) => void
}

interface DiffFileListProps {
  summaries: DiffFileSummary[]
  selectedPath?: string
  workspacePath?: string
  onSelectPath: (path: string) => void
}

interface DiffDetailProps {
  summary: DiffFileSummary
}

interface DiffLineRowProps {
  line: ParsedDiffLine
}

const DIFF_DETAIL_RENDER_LINE_LIMIT = DEFAULT_DIFF_RENDER_LINE_LIMIT

export function DiffViewer({ diff, workspacePath }: DiffViewerProps) {
  const [hideNoise, setHideNoise] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

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

  const summaries = diff.summaries || []
  const filteredSummaries = hideNoise ? summaries.filter((s) => !s.isNoise) : summaries

  const selectedSummary =
    filteredSummaries.find((s) => s.path === selectedPath) || filteredSummaries[0] || null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DiffToolbar
        changedCount={filteredSummaries.length}
        hideNoise={hideNoise}
        onHideNoiseChange={setHideNoise}
      />

      {filteredSummaries.length === 0 ? (
        <div
          style={{
            padding: 'var(--space-md)',
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-sm)'
          }}
        >
          No changes to display.
        </div>
      ) : (
        <>
          <DiffFileList
            summaries={filteredSummaries}
            selectedPath={selectedSummary?.path}
            workspacePath={workspacePath}
            onSelectPath={setSelectedPath}
          />
          {selectedSummary && <DiffDetail summary={selectedSummary} />}
        </>
      )}
    </div>
  )
}

function DiffToolbar({ changedCount, hideNoise, onHideNoiseChange }: DiffToolbarProps) {
  return (
    <div className="diff-studio-toolbar">
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
        {changedCount} changed
      </span>
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

function DiffFileList({ summaries, selectedPath, workspacePath, onSelectPath }: DiffFileListProps) {
  return (
    <div className="diff-file-list">
      {summaries.map((summary) => (
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
                <span className="diff-file-stat diff-file-stat-add">+{summary.additions}</span>
                <span className="diff-file-stat-divider">|</span>
                <span className="diff-file-stat diff-file-stat-delete">-{summary.deletions}</span>
              </>
            ) : (
              summary.status
            )}
          </span>
        </button>
      ))}
    </div>
  )
}

function DiffDetail({ summary }: DiffDetailProps) {
  const { copiedId, copy } = useCopyFeedback()
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
