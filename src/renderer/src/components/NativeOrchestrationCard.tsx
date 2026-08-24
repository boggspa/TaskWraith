import { useState, type CSSProperties, type ReactNode } from 'react'
import type { ProviderId } from '../../../main/store/types'

/**
 * Shared chassis for TaskWraith's "Native orchestration" transcript cards —
 * provider-run orchestration surfaced as one status affordance instead of raw
 * tool rows. Current adapters: WorkflowCard (Claude Workflow), ReviewCard
 * (Codex Code Review), CodexMultiAgentCard (Codex Multi-agent).
 *
 * Deliberately renders the EXACT `.claude-workflow-card` DOM the original
 * Claude-only card established (header button + glyph + name + optional status
 * pill or adapter-owned trailing telemetry + chevron, meta line, progress bar,
 * optional current-line/extras/expandable body) so the existing CSS in
 * 07-composer-shells.css and the
 * renderToStaticMarkup tests keep working unchanged — adapters differ only in
 * what they feed it, never in structure.
 *
 * Honesty contract: the chassis never invents content. Counts, progress and
 * detail only render when an adapter passes them; a running card without
 * `progressFraction` shows the indeterminate meter, never a fabricated
 * percentage.
 */
export interface NativeOrchestrationCardProps {
  /** Extra class hooks on the root, e.g. 'review-card' or 'multi-agent-card'. */
  cardClassName?: string
  /** Provider that produced the orchestration — drives `data-provider` and,
   * when `useProviderAccent`, the `--provider-accent` tint. */
  provider: ProviderId
  /** Normalized status slug — becomes the `status-<status>` classes. */
  status: string
  /** Human status pill content. Omit when adapter-owned header telemetry replaces it. */
  statusLabel?: ReactNode
  /** True while the episode is live — drives the pulse dot + meter animation. */
  isRunning: boolean
  /** Card glyph (identicon / bespoke icon). Rendered inside the glyph slot. */
  glyph: ReactNode
  /** Card title, e.g. 'Codex Multi-agent'. */
  name: string
  /** Optional adapter-owned content at the right side of the header. */
  headerTrailing?: ReactNode
  /** Meta line segments, joined with ' · '. */
  metaParts: string[]
  /**
   * Optional rich element opening the meta line, ahead of `metaParts` — for an
   * adapter that must name WHO rather than describe what (the fleet card's
   * caller seat). Omitting it leaves the meta line byte-identical.
   */
  metaLead?: ReactNode
  /** Tint chrome + glyph with `--provider-<id>-color`. Claude passes false to
   * keep the app's global `--accent` (its historical look). */
  useProviderAccent: boolean
  /** Optional resolved brand accent (for model-backed Pi/Ollama caller seats). */
  providerAccentOverride?: string
  /** Determinate progress in [0,1] while running. Omit for the indeterminate
   * meter — adapters must only pass this for REAL observed progress. */
  progressFraction?: number
  /** Optional live "currently: …" line shown while running. */
  currentLine?: ReactNode
  /** Optional rows between the progress meter and the expandable body (phase
   * chips, subagent chips, evidence notes). Always visible. */
  extras?: ReactNode
  /** Expandable body content. Presence enables the header chevron. */
  detail?: ReactNode
}

export function formatTokenCount(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

export function formatDuration(ms: number | undefined): string | undefined {
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

export function NativeOrchestrationCard({
  cardClassName,
  provider,
  status,
  statusLabel,
  isRunning,
  glyph,
  name,
  headerTrailing,
  metaParts,
  metaLead,
  useProviderAccent,
  providerAccentOverride,
  progressFraction,
  currentLine,
  extras,
  detail
}: NativeOrchestrationCardProps) {
  const hasDetail = Boolean(detail)
  const [expanded, setExpanded] = useState(false)

  const rootStyle: CSSProperties | undefined = useProviderAccent
    ? ({
        '--provider-accent':
          providerAccentOverride || `var(--provider-${provider}-color, var(--accent))`
      } as CSSProperties)
    : undefined

  const determinate =
    isRunning &&
    typeof progressFraction === 'number' &&
    Number.isFinite(progressFraction) &&
    progressFraction >= 0

  return (
    <div
      className={`claude-workflow-card${cardClassName ? ` ${cardClassName}` : ''} status-${status}`}
      data-provider={provider}
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
          {glyph}
        </span>
        <span className="claude-workflow-card-name">{name}</span>
        {headerTrailing}
        {statusLabel ? (
          <span className={`claude-workflow-card-status status-${status}`}>
            {isRunning && <span className="claude-workflow-card-pulse" aria-hidden />}
            {statusLabel}
          </span>
        ) : null}
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

      <div
        className={`claude-workflow-card-meta${metaLead ? ' has-meta-lead' : ''}`}
      >
        {metaLead}
        {metaLead && metaParts.length > 0 ? (
          <span className="claude-workflow-card-meta-sep" aria-hidden>
            ·
          </span>
        ) : null}
        {metaParts.join(' · ')}
      </div>

      <div
        className={`claude-workflow-card-progress status-${status}`}
        role="presentation"
        aria-hidden
      >
        {determinate ? (
          <span
            className="determinate"
            style={{ width: `${Math.round(Math.min(1, progressFraction!) * 100)}%` }}
          />
        ) : (
          <span className={isRunning ? 'indeterminate' : 'settled'} />
        )}
      </div>

      {isRunning && currentLine && (
        <div className="claude-workflow-card-current">{currentLine}</div>
      )}

      {extras}

      {expanded && hasDetail && <div className="claude-workflow-card-body">{detail}</div>}
    </div>
  )
}
