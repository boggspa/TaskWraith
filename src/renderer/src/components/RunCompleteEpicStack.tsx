import type { ReactNode } from 'react'
import type { SeatChangeLink } from '../../../shared/seatChange'
import {
  CLOSEOUT_COMMIT_TABLE_LIMIT,
  type CloseoutCommit,
  type CloseoutParticipantTable
} from '../lib/taskWraithCloseoutMessage'
import { ParticipantStatusIcon } from './icons/ParticipantStatusIcon'
import { SeatChangeInlineStrip } from './SeatChangeRow'

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

export function RunCompleteEpicStack({
  participantTable,
  commits,
  fileChanges
}: {
  participantTable?: CloseoutParticipantTable | null
  commits?: CloseoutCommit[] | null
  fileChanges?: ReactNode
}): ReactNode {
  const rows = participantTable?.rows || []
  const allCommitRows = Array.isArray(commits) ? commits : []
  const commitRows = allCommitRows.slice(0, CLOSEOUT_COMMIT_TABLE_LIMIT)
  const commitOverflow = Math.max(0, allCommitRows.length - commitRows.length)
  const hasParticipants = rows.length > 0
  const hasCommits = commitRows.length > 0
  if (!hasParticipants && !fileChanges && !hasCommits) return null

  return (
    <div className="run-complete-epic-stack">
      {hasParticipants && (
        <section className="file-change-summary-card run-complete-epic-card" aria-label="Participants">
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
              <span role="columnheader">Hash</span>
              <span role="columnheader">Message</span>
              <span role="columnheader">Seat</span>
              <span role="columnheader">Changes</span>
            </div>
            {commitRows.map((commit) => {
              const seatLink = asSeatLink(commit.seatLink)
              return (
                <div
                  className="run-complete-epic-row is-commits"
                  role="row"
                  key={commit.hash}
                >
                  <span className="run-complete-epic-hash" role="cell">
                    <code>{commit.hash.slice(0, 9)}</code>
                  </span>
                  <span className="run-complete-epic-subject" role="cell" title={commit.subject}>
                    {commit.subject || '—'}
                  </span>
                  <span className="run-complete-epic-seat" role="cell">
                    {seatLink ? (
                      <SeatChangeInlineStrip link={seatLink} />
                    ) : (
                      <span className="run-complete-epic-seat-fallback">—</span>
                    )}
                  </span>
                  <span className="run-complete-epic-stats" role="cell">
                    {commit.stats || '—'}
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
    </div>
  )
}
