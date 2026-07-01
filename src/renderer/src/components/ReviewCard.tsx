import { useState, type CSSProperties } from 'react'
import type { ProviderId, ToolActivity } from '../../../main/store/types'
import type { CodexReviewStatus, CodexReviewTelemetry } from '../../../shared/codexReview'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'

interface ReviewCardProps {
  activity: ToolActivity
  /** Resolved provider (codex today). Drives glyph + accent. */
  provider?: ProviderId
}

const STATUS_LABEL: Record<CodexReviewStatus, string> = {
  running: 'Reviewing',
  completed: 'Reviewed',
  failed: 'Failed',
  stopped: 'Stopped',
  unknown: 'Review'
}

function formatTokenCount(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`
}

/**
 * Transcript card for a Codex native code-review run — a lightweight RUN-STATUS
 * affordance anchored to the synthesized `codex_review` activity. Shows what is
 * honestly available (target, status, duration, tokens, model). It deliberately
 * shows NO finding count / severity / verdict: Codex emits no structured
 * findings, so any such number would be fabricated. The actual review findings
 * appear in the transcript as the streamed assistant text, not here.
 *
 * Reuses the `.claude-workflow-card` layout (provider-generic since the workflow
 * card generalization) with a `.review-card` hook; the Codex identicon + brand
 * accent come from the shared per-provider glyph treatment.
 */
export function ReviewCard({ activity, provider }: ReviewCardProps) {
  const telemetry: CodexReviewTelemetry = activity.reviewSummary ?? {}
  const cardProvider: ProviderId =
    (telemetry.provider as ProviderId | undefined) ?? provider ?? 'codex'
  const status: CodexReviewStatus = telemetry.status ?? 'unknown'
  const isRunning = status === 'running'

  const tokens = formatTokenCount(telemetry.totalTokens)
  const elapsed = formatDuration(telemetry.durationMs)

  const metaParts: string[] = ['Review']
  if (telemetry.target) metaParts.push(telemetry.target)
  if (tokens) metaParts.push(`${tokens} tokens`)
  if (elapsed) metaParts.push(elapsed)
  if (telemetry.model) metaParts.push(telemetry.model)

  const hasDetail = Boolean(telemetry.error)
  const [expanded, setExpanded] = useState(false)

  const rootStyle: CSSProperties = {
    '--provider-accent': `var(--provider-${cardProvider}-color, var(--accent))`
  } as CSSProperties

  return (
    <div
      className={`claude-workflow-card review-card status-${status}`}
      data-provider={cardProvider}
      style={rootStyle}
    >
      <button
        type="button"
        className="claude-workflow-card-header"
        aria-expanded={hasDetail ? expanded : undefined}
        disabled={!hasDetail}
        onClick={hasDetail ? () => setExpanded((current) => !current) : undefined}
      >
        <span className="claude-workflow-card-glyph" aria-hidden>
          <AgentIdentityIcon seed={activity.id} size={16} title="Codex Review" />
        </span>
        <span className="claude-workflow-card-name">Codex Review</span>
        <span className={`claude-workflow-card-status status-${status}`}>
          {isRunning && <span className="claude-workflow-card-pulse" aria-hidden />}
          {STATUS_LABEL[status]}
        </span>
        {hasDetail && (
          <svg
            className={`claude-workflow-card-chevron ${expanded ? 'expanded' : ''}`}
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="3,4.5 6,7.5 9,4.5" />
          </svg>
        )}
      </button>

      <div className="claude-workflow-card-meta">{metaParts.join(' · ')}</div>

      <div
        className={`claude-workflow-card-progress status-${status}`}
        role="presentation"
        aria-hidden
      >
        <span className={isRunning ? 'indeterminate' : 'settled'} />
      </div>

      {expanded && telemetry.error && (
        <div className="claude-workflow-card-body">
          <div className="claude-workflow-card-error">{telemetry.error}</div>
        </div>
      )}
    </div>
  )
}
