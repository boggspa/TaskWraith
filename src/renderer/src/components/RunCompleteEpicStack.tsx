import { useCallback, type ReactNode } from 'react'
import type { SeatChangeLink } from '../../../shared/seatChange'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { getProviderLabel } from '../lib/providerLabels'
import {
  CLOSEOUT_COMMIT_TABLE_LIMIT,
  CLOSEOUT_SUBAGENT_TABLE_LIMIT,
  type CloseoutCommit,
  type CloseoutParticipantTable,
  type CloseoutSubagentDelegation
} from '../lib/taskWraithCloseoutMessage'
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
function CloseoutStatusGlyph({ status }: { status: string }): ReactNode {
  const label = status.trim() || 'Unknown'
  const slug = label.toLowerCase().replace(/\s+/g, '-')
  return (
    <span
      className={`ensemble-above-chip-status status-${slug} closeout-status-glyph`}
      role="img"
      aria-label={label}
      title={label}
    >
      <ParticipantStatusIcon status={label} />
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

/** Build synthetic unified-diff text from a commit's file list so the
 *  DiffHoverPreviewOverlay can render it as a series of file-name sections. */
function buildCommitFilesDiffText(commit: CloseoutCommit): string | null {
  if (!commit.files || commit.files.length === 0) return null
  return commit.files
    .map((f) => {
      let stats = ''
      if (typeof f.additions === 'number' || typeof f.deletions === 'number') {
        const parts: string[] = []
        if (typeof f.additions === 'number') parts.push(`+${f.additions}`)
        if (typeof f.deletions === 'number') parts.push(`−${f.deletions}`)
        stats = `  ${parts.join(' ')}`
      }
      let body = ''
      if (f.hunks && f.hunks.trim()) {
        body = f.hunks
          .trim()
          .split('\n')
          .map((line) => ` ${line}`)
          .join('\n')
      } else {
        body = ' '
      }
      return `@@ -0,0 +1,1 @@ ${f.path}${stats}\n${body}`
    })
    .join('\n')
}

/** Commit hover open delay — matches TranscriptPanel's file-change hover delay. */
const COMMIT_FILES_HOVER_OPEN_DELAY_MS = 900
const COMMIT_FILES_HOVER_CLOSE_DELAY_MS = 1400

export function RunCompleteEpicStack({
  participantTable,
  subagentDelegations,
  commits,
  fileChanges
}: {
  participantTable?: CloseoutParticipantTable | null
  subagentDelegations?: CloseoutSubagentDelegation[] | null
  commits?: CloseoutCommit[] | null
  fileChanges?: ReactNode
}): ReactNode {
  const rows = participantTable?.rows || []
  const allSubagentRows = Array.isArray(subagentDelegations) ? subagentDelegations : []
  const subagentRows = allSubagentRows.slice(0, CLOSEOUT_SUBAGENT_TABLE_LIMIT)
  const subagentOverflow = Math.max(0, allSubagentRows.length - subagentRows.length)
  const allCommitRows = Array.isArray(commits) ? commits : []
  const commitRows = allCommitRows.slice(0, CLOSEOUT_COMMIT_TABLE_LIMIT)
  const commitOverflow = Math.max(0, allCommitRows.length - commitRows.length)
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

  const openCommitFilesPill = useCallback(
    (
      event: { currentTarget: HTMLElement },
      commit: CloseoutCommit,
      options?: { focusTarget?: DiffHoverPreviewState['focusTarget']; immediate?: boolean }
    ) => {
      const anchorElement = event.currentTarget
      const produce = (): DiffHoverPreviewState | null => {
        if (!anchorElement.isConnected) return null
        const diffText = buildCommitFilesDiffText(commit)
        if (!diffText) return null
        return {
          anchor: anchorElement.getBoundingClientRect(),
          boundary: diffHoverPreviewBoundaryForElement(anchorElement),
          summary: {
            actionLabel: `Commit ${commit.hash.slice(0, 9)}`,
            path: `Commit ${commit.hash.slice(0, 9)}${commit.subject ? ` — ${commit.subject}` : ''}`,
            status: commit.stats || 'commit',
            diffText,
            source: 'run-summary'
          },
          focusTarget: options?.focusTarget
        }
      }
      if (options?.immediate || options?.focusTarget) {
        const next = produce()
        if (next) showCommitFilesPill(next)
        return
      }
      scheduleShowCommitFilesPill(produce)
    },
    [scheduleShowCommitFilesPill, showCommitFilesPill]
  )

  const anyCommitHasFiles = commitRows.some((c) => c.files && c.files.length > 0)
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
          <div className="file-change-summary-list run-complete-epic-list" role="table">
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
          <div className="file-change-summary-list run-complete-epic-list" role="table">
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
                <div className="run-complete-epic-row" role="row" key={row.subThreadId}>
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
                    <CloseoutStatusGlyph status={glyphKey} />
                    <span className="run-complete-epic-subagent-status">{statusLabel}</span>
                  </span>
                </div>
              )
            })}
            {subagentOverflow > 0 && (
              <div className="run-complete-epic-row is-overflow" role="row">
                <span role="cell" className="run-complete-epic-overflow">
                  {subagentOverflow} more sub-thread{subagentOverflow === 1 ? '' : 's'} not shown.
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {fileChanges}

      {hasCommits && (
        <section className="file-change-summary-card run-complete-epic-card" aria-label="Commits">
          <div className="file-change-summary-header">
            <strong>Commits</strong>
            <div className="file-change-summary-meta">
              <span>
                {commitRows.length} commit{commitRows.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <div className="file-change-summary-list run-complete-epic-list" role="table">
            <div className="run-complete-epic-row is-header is-commits" role="row">
              <span role="columnheader">Seat</span>
              <span role="columnheader">Changes</span>
              <span role="columnheader">Message</span>
              <span role="columnheader">Hash</span>
            </div>
            {commitRows.map((commit) => {
              const seatLink = asSeatLink(commit.seatLink)
              const hasFiles = commit.files && commit.files.length > 0
              return (
                <div
                  className={`run-complete-epic-row is-commits${hasFiles ? ' has-commit-files' : ''}`}
                  role="row"
                  key={commit.hash}
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
                    hasFiles ? scheduleCloseCommitFilesPill : undefined
                  }
                  onFocus={
                    hasFiles
                      ? (event) =>
                          openCommitFilesPill(event, commit, {
                            focusTarget: 'preview'
                          })
                      : undefined
                  }
                  onBlur={hasFiles ? scheduleCloseCommitFilesPill : undefined}
                >
                  <span className="run-complete-epic-seat" role="cell">
                    {seatLink ? (
                      <SeatChangeInlineStrip link={seatLink} />
                    ) : (
                      <span className="run-complete-epic-seat-fallback">—</span>
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
                  </span>
                </div>
              )
            })}
            {commitOverflow > 0 && (
              <div className="run-complete-epic-row is-commits is-overflow" role="row">
                <span role="cell" className="run-complete-epic-overflow">
                  {commitOverflow} more commit{commitOverflow === 1 ? '' : 's'} not shown.
                </span>
              </div>
            )}
          </div>
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
    </div>
  )
}
