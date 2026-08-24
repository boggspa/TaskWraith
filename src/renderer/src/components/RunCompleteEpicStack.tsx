import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SeatChangeLink } from '../../../shared/seatChange'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { getProviderLabel } from '../lib/providerLabels'
import {
  buildCloseoutCommitWindow,
  buildCloseoutSubagentWindow,
  CLOSEOUT_COMMIT_TABLE_LIMIT,
  CLOSEOUT_SUBAGENT_TABLE_LIMIT,
  type CloseoutCommit,
  type CloseoutParticipantTable,
  type CloseoutSubagentDelegation
} from '../lib/taskWraithCloseoutMessage'
import {
  SUBAGENT_INVOCATION_TOOLTIP_ID,
  SubagentInvocationHoverCard,
  type SubagentInvocationHoverState
} from './SubagentInvocationHoverCard'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { ParticipantStatusIcon } from './icons/ParticipantStatusIcon'
import { SeatChangeInlineStrip } from './SeatChangeRow'
import {
  DIFF_HOVER_PREVIEW_TOOLTIP_ID,
  DiffHoverPreviewOverlay,
  type DiffHoverPreviewState,
  diffHoverPreviewBoundaryForElement,
  useDiffHoverPreviewDismiss,
  useDiffHoverPreviewState
} from './DiffHoverPreview'

function asSeatLink(value: unknown): SeatChangeLink | null {
  if (!value || typeof value !== 'object') return null
  const link = value as SeatChangeLink
  if (
    typeof link.participantId !== 'string' ||
    !link.participantId ||
    !link.before ||
    !link.after ||
    typeof link.before !== 'object' ||
    typeof link.after !== 'object'
  ) {
    return null
  }
  return link
}

function CloseoutCommitStats({ stats }: { stats?: string }): ReactNode {
  if (!stats) return '—'

  return (
    <span className="run-complete-epic-stats-value">
      {stats.split(/([+]\d[\d,]*|[−-]\d[\d,]*)/g).map((part, index) => {
        if (part.startsWith('+')) {
          return (
            <span className="composer-diff-add" key={`${index}-${part}`}>
              {part}
            </span>
          )
        }
        if (/^[−-]\d/.test(part)) {
          return (
            <span className="composer-diff-del" key={`${index}-${part}`}>
              {part}
            </span>
          )
        }
        return part
      })}
    </span>
  )
}

/** Same glyph vocabulary as the old close-out markdown table / roster chips. */
function CloseoutStatusGlyph({ status, label }: { status: string; label?: string }): ReactNode {
  const accessibleLabel = label?.trim() || status.trim() || 'Unknown'
  const slug = (status.trim() || 'unknown').toLowerCase().replace(/\s+/g, '-')
  return (
    <span
      className={`ensemble-above-chip-status status-${slug} closeout-status-glyph`}
      role="img"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <ParticipantStatusIcon status={status} />
    </span>
  )
}

function subagentStatusLabel(status: CloseoutSubagentDelegation['status']): string {
  switch (status) {
    case 'created':
      return 'Created'
    case 'running':
      return 'Active'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'returned':
      return 'Returned'
    default:
      return 'Unknown'
  }
}

/** Map sub-thread closeout statuses onto ParticipantStatusIcon vocabulary. */
function subagentStatusGlyphKey(status: CloseoutSubagentDelegation['status']): string {
  switch (status) {
    case 'returned':
    case 'completed':
      return 'answered'
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'created':
    case 'unknown':
    default:
      return 'pending'
  }
}

function subagentRouteLabel(row: CloseoutSubagentDelegation): string {
  const target = getProviderLabel(row.provider)
  if (!row.parentProvider) return target
  return `${getProviderLabel(row.parentProvider)} → ${target}`
}

function commitFileTotals(commit: CloseoutCommit): {
  additions?: number
  deletions?: number
} {
  let additions = 0
  let deletions = 0
  let hasAdditions = false
  let hasDeletions = false
  for (const file of commit.files || []) {
    if (typeof file.additions === 'number') {
      additions += file.additions
      hasAdditions = true
    }
    if (typeof file.deletions === 'number') {
      deletions += file.deletions
      hasDeletions = true
    }
  }
  return {
    ...(hasAdditions ? { additions } : {}),
    ...(hasDeletions ? { deletions } : {})
  }
}

/** Commit hover open delay — matches TranscriptPanel's file-change hover delay. */
const COMMIT_FILES_HOVER_OPEN_DELAY_MS = 900
const COMMIT_FILES_HOVER_CLOSE_DELAY_MS = 1400
// Matched to the commit pill: a deliberate dwell before the bubble appears,
// and a slow close so crossing into it mid-read never snaps it away.
const SUBAGENT_INVOCATION_HOVER_OPEN_DELAY_MS = 900
const SUBAGENT_INVOCATION_HOVER_CLOSE_DELAY_MS = 1400

export interface CommitFilePreviewLoadResult {
  files: NonNullable<CloseoutCommit['files']>
  totalFiles: number
}

export interface CommitAttributionFallback {
  text: string
  title?: string
}

export interface CommitSelectionState {
  selectedHashes: ReadonlySet<string>
  onToggle: (commit: CloseoutCommit) => void
}

type CommitFilePreviewCacheEntry =
  | { status: 'loading'; promise: Promise<CommitFilePreviewLoadResult | null> }
  | { status: 'loaded'; result: CommitFilePreviewLoadResult }
  | { status: 'unavailable' }

const COMMIT_FILES_LOADING_MESSAGE = 'Loading files changed by this commit…'
const COMMIT_FILES_UNAVAILABLE_MESSAGE =
  'Commit files are unavailable. Reload TaskWraith and hover this row again.'
const COMMIT_FILES_EMPTY_MESSAGE = 'No changed files were reported for this commit.'

export function RunCompleteEpicStack({
  participantTable,
  subagentDelegations,
  commits,
  fileChanges,
  loadCommitFiles,
  commitRowLimit = CLOSEOUT_COMMIT_TABLE_LIMIT,
  subagentRowLimit = CLOSEOUT_SUBAGENT_TABLE_LIMIT,
  commitAttributionLabel = 'Seat',
  commitAttributionFallback,
  commitNumbering = false,
  commitSelection,
  commitHashAdornment,
  commitCountLabel
}: {
  participantTable?: CloseoutParticipantTable | null
  subagentDelegations?: CloseoutSubagentDelegation[] | null
  commits?: CloseoutCommit[] | null
  fileChanges?: ReactNode
  loadCommitFiles?: (commit: CloseoutCommit) => Promise<CommitFilePreviewLoadResult | null>
  /** `null` renders the complete stack; Task Complete keeps its bounded default. */
  commitRowLimit?: number | null
  /** null renders every sub-thread and hides the expander (inspector surfaces). */
  subagentRowLimit?: number | null
  commitAttributionLabel?: string
  commitAttributionFallback?: (commit: CloseoutCommit) => CommitAttributionFallback | null
  commitNumbering?: boolean
  commitSelection?: CommitSelectionState
  commitHashAdornment?: (commit: CloseoutCommit) => ReactNode
  commitCountLabel?: ReactNode
}): ReactNode {
  const rows = participantTable?.rows || []
  const allSubagentRows = Array.isArray(subagentDelegations) ? subagentDelegations : []
  // Expandable, like the File changes card in this same stack. The old hard
  // slice printed "N more not shown", which named evidence the reader then had
  // no way to reach.
  const [subagentVisibleCount, setSubagentVisibleCount] = useState(
    subagentRowLimit ?? CLOSEOUT_SUBAGENT_TABLE_LIMIT
  )
  const subagentWindow = useMemo(
    () =>
      subagentRowLimit === null
        ? null
        : buildCloseoutSubagentWindow(allSubagentRows, subagentVisibleCount),
    [allSubagentRows, subagentRowLimit, subagentVisibleCount]
  )
  const subagentRows = subagentWindow ? subagentWindow.items : allSubagentRows
  const showMoreSubagents = useCallback(() => {
    setSubagentVisibleCount(
      (current) =>
        buildCloseoutSubagentWindow(allSubagentRows, current).nextCount
    )
  }, [allSubagentRows])
  const showFewerSubagents = useCallback(() => {
    setSubagentVisibleCount(CLOSEOUT_SUBAGENT_TABLE_LIMIT)
  }, [])
  const allCommitRows = Array.isArray(commits) ? commits : []
  // Same treatment as the Sub-threads table above and the File changes card
  // below: the hard slice printed "N more commits not shown", naming evidence
  // the reader then had no way to reach.
  const [commitVisibleCount, setCommitVisibleCount] = useState(
    commitRowLimit ?? CLOSEOUT_COMMIT_TABLE_LIMIT
  )
  const commitWindow = useMemo(
    () =>
      commitRowLimit === null ? null : buildCloseoutCommitWindow(allCommitRows, commitVisibleCount),
    [allCommitRows, commitRowLimit, commitVisibleCount]
  )
  const commitRows = commitWindow ? commitWindow.items : allCommitRows
  const showMoreCommits = useCallback(() => {
    setCommitVisibleCount((current) => buildCloseoutCommitWindow(allCommitRows, current).nextCount)
  }, [allCommitRows])
  const showFewerCommits = useCallback(() => {
    setCommitVisibleCount(CLOSEOUT_COMMIT_TABLE_LIMIT)
  }, [])
  const hasParticipants = rows.length > 0
  const hasSubagents = subagentRows.length > 0
  const hasCommits = commitRows.length > 0

  // ── Commit-files mouseover pill ──────────────────────────────────────
  const {
    closePreview: closeCommitFilesPill,
    keepPreviewOpen: keepCommitFilesPillOpen,
    preview: commitFilesPill,
    scheduleClosePreview: scheduleCloseCommitFilesPill,
    scheduleShowPreview: scheduleShowCommitFilesPill,
    showPreview: showCommitFilesPill
  } = useDiffHoverPreviewState(COMMIT_FILES_HOVER_CLOSE_DELAY_MS, COMMIT_FILES_HOVER_OPEN_DELAY_MS)

  useDiffHoverPreviewDismiss(commitFilesPill, closeCommitFilesPill)

  // ── Sub-thread Agent-Invocation bubble ───────────────────────────────
  // Same dwell contract as the commit pill beside it, over the row the
  // reader is already looking at.
  const {
    closePreview: closeSubagentCard,
    keepPreviewOpen: keepSubagentCardOpen,
    preview: subagentCard,
    scheduleClosePreview: scheduleCloseSubagentCard,
    scheduleShowPreview: scheduleShowSubagentCard
  } = useDiffHoverPreviewState<SubagentInvocationHoverState>(
    SUBAGENT_INVOCATION_HOVER_CLOSE_DELAY_MS,
    SUBAGENT_INVOCATION_HOVER_OPEN_DELAY_MS
  )
  useDiffHoverPreviewDismiss(subagentCard, closeSubagentCard, '.subagent-invocation-hover-card')

  const openSubagentCard = useCallback(
    (event: { currentTarget: HTMLElement }, row: CloseoutSubagentDelegation) => {
      const element = event.currentTarget
      // Measured when the timer fires, not when it is scheduled: the row can
      // scroll or unmount during the dwell (same rule as the commit pill).
      scheduleShowSubagentCard(() => {
        if (!element.isConnected) return null
        return {
          anchor: element.getBoundingClientRect(),
          boundary: diffHoverPreviewBoundaryForElement(element),
          row
        }
      })
    },
    [scheduleShowSubagentCard]
  )

  const hoveredCommitHashRef = useRef<string | null>(null)
  const commitFileCacheRef = useRef<Map<string, CommitFilePreviewCacheEntry>>(new Map())

  const openCommitFilesPill = useCallback(
    (
      event: { currentTarget: HTMLElement },
      commit: CloseoutCommit,
      options?: { focusTarget?: DiffHoverPreviewState['focusTarget']; immediate?: boolean }
    ) => {
      const anchorElement = event.currentTarget
      hoveredCommitHashRef.current = commit.hash
      const buildPreview = (
        files: NonNullable<CloseoutCommit['files']>,
        totalFiles: number,
        emptyMessage?: string,
        emptyFooterLabel?: string
      ): DiffHoverPreviewState | null => {
        if (!anchorElement.isConnected) return null
        if (files.length === 0 && !emptyMessage) return null
        const totals = commitFileTotals({ ...commit, files })
        return {
          anchor: anchorElement.getBoundingClientRect(),
          boundary: diffHoverPreviewBoundaryForElement(anchorElement),
          summary: {
            actionLabel: `Commit ${commit.hash.slice(0, 9)}`,
            path: `Commit ${commit.hash.slice(0, 9)}${commit.subject ? ` — ${commit.subject}` : ''}`,
            status: commit.stats || 'commit',
            additions: totals.additions,
            deletions: totals.deletions,
            files,
            fileCount: totalFiles,
            emptyMessage,
            emptyFooterLabel,
            source: 'run-summary'
          },
          focusTarget: options?.focusTarget
        }
      }
      const produce = (): DiffHoverPreviewState | null => {
        if (commit.files && commit.files.length > 0) {
          return buildPreview(commit.files, commit.files.length)
        }
        const cached = commitFileCacheRef.current.get(commit.hash)
        if (cached?.status === 'loaded') {
          return cached.result.files.length
            ? buildPreview(cached.result.files, cached.result.totalFiles)
            : buildPreview([], 0, COMMIT_FILES_EMPTY_MESSAGE, 'No files reported')
        }
        if (cached?.status === 'unavailable') {
          return buildPreview([], 0, COMMIT_FILES_UNAVAILABLE_MESSAGE, 'Reload required')
        }
        if (cached?.status === 'loading') {
          return buildPreview([], 0, COMMIT_FILES_LOADING_MESSAGE, 'Loading files…')
        }
        if (!loadCommitFiles) return null

        const pending = Promise.resolve()
          .then(() => loadCommitFiles(commit))
          .then((result) => {
            commitFileCacheRef.current.set(
              commit.hash,
              result ? { status: 'loaded', result } : { status: 'unavailable' }
            )
            if (hoveredCommitHashRef.current === commit.hash && anchorElement.isConnected) {
              const nextPreview = result
                ? result.files.length
                  ? buildPreview(result.files, result.totalFiles)
                  : buildPreview([], 0, COMMIT_FILES_EMPTY_MESSAGE, 'No files reported')
                : buildPreview([], 0, COMMIT_FILES_UNAVAILABLE_MESSAGE, 'Reload required')
              if (nextPreview) showCommitFilesPill(nextPreview)
            }
            return result
          })
          .catch(() => {
            commitFileCacheRef.current.set(commit.hash, { status: 'unavailable' })
            if (hoveredCommitHashRef.current === commit.hash && anchorElement.isConnected) {
              const nextPreview = buildPreview(
                [],
                0,
                COMMIT_FILES_UNAVAILABLE_MESSAGE,
                'Reload required'
              )
              if (nextPreview) showCommitFilesPill(nextPreview)
            }
            return null
          })
        commitFileCacheRef.current.set(commit.hash, { status: 'loading', promise: pending })
        return buildPreview([], 0, COMMIT_FILES_LOADING_MESSAGE, 'Loading files…')
      }
      if (options?.immediate || options?.focusTarget) {
        const next = produce()
        if (next) showCommitFilesPill(next)
        return
      }
      scheduleShowCommitFilesPill(produce)
    },
    [loadCommitFiles, scheduleShowCommitFilesPill, showCommitFilesPill]
  )

  const leaveCommitFilesRow = useCallback(() => {
    hoveredCommitHashRef.current = null
    scheduleCloseCommitFilesPill()
  }, [scheduleCloseCommitFilesPill])

  const anyCommitHasFiles =
    Boolean(loadCommitFiles) ||
    allCommitRows.some((commit) => commit.files && commit.files.length > 0)
  // ──────────────────────────────────────────────────────────────────────

  if (!hasParticipants && !hasSubagents && !fileChanges && !hasCommits) return null

  return (
    <div className="run-complete-epic-stack">
      {hasParticipants && (
        <section
          className="file-change-summary-card run-complete-epic-card"
          aria-label="Participants"
        >
          <div className="file-change-summary-header">
            <strong>Participants</strong>
            <div className="file-change-summary-meta">
              <span>
                {rows.length} seat{rows.length === 1 ? '' : 's'}
                {participantTable?.totalWorkLabel ? ` · ${participantTable.totalWorkLabel}` : ''}
              </span>
            </div>
          </div>
          <div
            className="file-change-summary-list run-complete-epic-list"
            role="table"
            aria-label="Participants"
          >
            <div className="run-complete-epic-row is-header" role="row">
              <span role="columnheader">Seat</span>
              <span className="run-complete-epic-work" role="columnheader">
                Turns & Tokens
              </span>
            </div>
            {rows.map((row) => {
              const seatLink = asSeatLink(row.seatLink)
              return (
                <div className="run-complete-epic-row" role="row" key={row.participantId}>
                  <span className="run-complete-epic-seat" role="cell">
                    {seatLink ? (
                      <SeatChangeInlineStrip link={seatLink} />
                    ) : (
                      <span className="run-complete-epic-seat-fallback">{row.seatText}</span>
                    )}
                  </span>
                  <span className="run-complete-epic-work" role="cell">
                    <span>{row.workLabel}</span>
                    <CloseoutStatusGlyph status={row.status} />
                  </span>
                </div>
              )
            })}
            {participantTable?.totalWorkLabel && (
              <div className="run-complete-epic-row is-total" role="row">
                <span role="cell">
                  <strong>Round Total</strong>
                </span>
                <span className="run-complete-epic-work" role="cell">
                  <strong>{participantTable.totalWorkLabel}</strong>
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {hasSubagents && (
        <section
          className="file-change-summary-card run-complete-epic-card"
          aria-label="Sub-threads"
        >
          <div className="file-change-summary-header">
            <strong>Sub-threads</strong>
            <div className="file-change-summary-meta">
              <span>
                {allSubagentRows.length} sub-thread{allSubagentRows.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <div
            className="file-change-summary-list run-complete-epic-list"
            role="table"
            aria-label="Sub-threads"
          >
            <div className="run-complete-epic-row is-header" role="row">
              <span role="columnheader">Agent</span>
              <span className="run-complete-epic-work" role="columnheader">
                Route & Status
              </span>
            </div>
            {subagentRows.map((row) => {
              const identity = assignAgentIdentityFromSeed(row.identitySeed || row.subThreadId)
              const statusLabel = subagentStatusLabel(row.status)
              const glyphKey = subagentStatusGlyphKey(row.status)
              return (
                <div
                  className="run-complete-epic-row has-subagent-invocation"
                  role="row"
                  key={row.subThreadId}
                  tabIndex={0}
                  aria-describedby={
                    subagentCard?.row.subThreadId === row.subThreadId
                      ? SUBAGENT_INVOCATION_TOOLTIP_ID
                      : undefined
                  }
                  onMouseEnter={(event) => openSubagentCard(event, row)}
                  onMouseLeave={scheduleCloseSubagentCard}
                  onFocus={(event) => openSubagentCard(event, row)}
                  onBlur={scheduleCloseSubagentCard}
                >
                  <span className="run-complete-epic-seat" role="cell">
                    <span
                      className="run-complete-epic-subagent"
                      title={row.title || identity.name}
                    >
                      <AgentIdentityIcon
                        name={identity.key}
                        color={identity.accent}
                        size={18}
                        className="run-complete-epic-subagent-icon"
                      />
                      <span className="run-complete-epic-subagent-name">{identity.name}</span>
                      {row.title ? (
                        <span className="run-complete-epic-subagent-title">{row.title}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="run-complete-epic-work" role="cell">
                    <span title={subagentRouteLabel(row)}>{subagentRouteLabel(row)}</span>
                    <CloseoutStatusGlyph status={glyphKey} label={statusLabel} />
                    <span className="run-complete-epic-subagent-status">{statusLabel}</span>
                  </span>
                </div>
              )
            })}
          </div>
          {subagentWindow?.canShowMore ? (
            <button
              className="run-complete-epic-row is-overflow run-complete-epic-subagent-more"
              type="button"
              aria-expanded={false}
              aria-label={`Show ${subagentWindow.nextShowCount} more sub-threads`}
              onClick={showMoreSubagents}
            >
              Show {subagentWindow.nextShowCount} more sub-thread
              {subagentWindow.nextShowCount === 1 ? '' : 's'}
            </button>
          ) : subagentWindow?.canShowFewer ? (
            <button
              className="run-complete-epic-row is-overflow run-complete-epic-subagent-more"
              type="button"
              aria-expanded
              aria-label="Show fewer sub-threads"
              onClick={showFewerSubagents}
            >
              Show fewer sub-threads
            </button>
          ) : null}
        </section>
      )}

      {fileChanges}

      {hasCommits && (
        <section className="file-change-summary-card run-complete-epic-card" aria-label="Commits">
          <div className="file-change-summary-header">
            <strong>Commits</strong>
            <div className="file-change-summary-meta">
              <span>
                {commitCountLabel ??
                  `${allCommitRows.length} commit${allCommitRows.length === 1 ? '' : 's'}`}
              </span>
            </div>
          </div>
          <div
            className="file-change-summary-list run-complete-epic-list"
            role="table"
            aria-label="Commits"
          >
            <div
              className={`run-complete-epic-row is-header is-commits${commitNumbering ? ' has-commit-numbers' : ''}`}
              role="row"
            >
              {commitNumbering && (
                <span className="run-complete-epic-number" role="columnheader">
                  #
                </span>
              )}
              <span role="columnheader">{commitAttributionLabel}</span>
              <span role="columnheader">Changes</span>
              <span role="columnheader">Message</span>
              <span role="columnheader">Hash</span>
            </div>
            {commitRows.map((commit, index) => {
              const seatLink = asSeatLink(commit.seatLink)
              const hasFiles = Boolean(commit.files?.length || loadCommitFiles)
              const fallbackAttribution = commitAttributionFallback?.(commit) || null
              const selectable = Boolean(commitSelection)
              const selected = commitSelection?.selectedHashes.has(commit.hash) || false
              return (
                <div
                  className={`run-complete-epic-row is-commits${commitNumbering ? ' has-commit-numbers' : ''}${hasFiles ? ' has-commit-files' : ''}${selectable ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}`}
                  role="row"
                  key={commit.hash}
                  tabIndex={hasFiles || selectable ? 0 : undefined}
                  aria-selected={selectable ? selected : undefined}
                  aria-describedby={
                    hasFiles &&
                    commitFilesPill?.summary.path ===
                      `Commit ${commit.hash.slice(0, 9)}${commit.subject ? ` — ${commit.subject}` : ''}`
                      ? DIFF_HOVER_PREVIEW_TOOLTIP_ID
                      : undefined
                  }
                  onMouseEnter={
                    hasFiles
                      ? (event) => openCommitFilesPill(event, commit)
                      : undefined
                  }
                  onMouseLeave={
                    hasFiles ? leaveCommitFilesRow : undefined
                  }
                  onFocus={
                    hasFiles
                      ? (event) =>
                          openCommitFilesPill(event, commit, {
                            focusTarget: 'preview'
                          })
                      : undefined
                  }
                  onBlur={hasFiles ? leaveCommitFilesRow : undefined}
                  onClick={
                    selectable
                      ? (event) => {
                          const target = event.target as HTMLElement
                          if (target.closest('a, button, input')) return
                          commitSelection?.onToggle(commit)
                        }
                      : undefined
                  }
                  onKeyDown={
                    selectable
                      ? (event) => {
                          if (event.target !== event.currentTarget) return
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          commitSelection?.onToggle(commit)
                        }
                      : undefined
                  }
                >
                  {commitNumbering && (
                    <span
                      className="run-complete-epic-number"
                      role="cell"
                      aria-label={`Commit ${index + 1}`}
                    >
                      #{index + 1}
                    </span>
                  )}
                  <span className="run-complete-epic-seat" role="cell">
                    {selectable && (
                      <input
                        className="run-complete-epic-commit-checkbox"
                        type="checkbox"
                        checked={selected}
                        aria-label={`${selected ? 'Deselect' : 'Select'} commit ${commit.hash.slice(0, 9)}${commit.subject ? `: ${commit.subject}` : ''}`}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => commitSelection?.onToggle(commit)}
                      />
                    )}
                    {seatLink ? (
                      <SeatChangeInlineStrip link={seatLink} />
                    ) : (
                      <span
                        className="run-complete-epic-seat-fallback"
                        title={fallbackAttribution?.title}
                      >
                        {fallbackAttribution?.text || '—'}
                      </span>
                    )}
                  </span>
                  <span className="run-complete-epic-stats" role="cell">
                    <CloseoutCommitStats stats={commit.stats} />
                  </span>
                  <span className="run-complete-epic-subject" role="cell" title={commit.subject}>
                    {commit.subject || '—'}
                  </span>
                  <span className="run-complete-epic-hash" role="cell">
                    <code>{commit.hash.slice(0, 9)}</code>
                    {commitHashAdornment?.(commit)}
                  </span>
                </div>
              )
            })}
          </div>
          {commitWindow?.canShowMore ? (
            <button
              className="run-complete-epic-row is-overflow run-complete-epic-commit-more"
              type="button"
              aria-expanded={false}
              aria-label={`Show ${commitWindow.nextShowCount} more commits`}
              onClick={showMoreCommits}
            >
              Show {commitWindow.nextShowCount} more commit
              {commitWindow.nextShowCount === 1 ? '' : 's'}
            </button>
          ) : commitWindow?.canShowFewer ? (
            <button
              className="run-complete-epic-row is-overflow run-complete-epic-commit-more"
              type="button"
              aria-expanded
              aria-label="Show fewer commits"
              onClick={showFewerCommits}
            >
              Show fewer commits
            </button>
          ) : null}
        </section>
      )}

      {anyCommitHasFiles && (
        <DiffHoverPreviewOverlay
          onFocus={keepCommitFilesPillOpen}
          onBlur={scheduleCloseCommitFilesPill}
          onMouseEnter={keepCommitFilesPillOpen}
          onMouseLeave={scheduleCloseCommitFilesPill}
          preview={commitFilesPill}
        />
      )}

      {hasSubagents && (
        <SubagentInvocationHoverCard
          onFocus={keepSubagentCardOpen}
          onBlur={scheduleCloseSubagentCard}
          onMouseEnter={keepSubagentCardOpen}
          onMouseLeave={scheduleCloseSubagentCard}
          preview={subagentCard}
        />
      )}
    </div>
  )
}
