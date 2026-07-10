import type { ProviderId, ToolActivity } from '../../../main/store/types'
import type { CodexReviewStatus, CodexReviewTelemetry } from '../../../shared/codexReview'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import {
  NativeOrchestrationCard,
  formatDuration,
  formatTokenCount
} from './NativeOrchestrationCard'

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

/**
 * Transcript card for a Codex native code-review run — a lightweight RUN-STATUS
 * affordance anchored to the synthesized `codex_review` activity. Shows what is
 * honestly available (target, status, duration, tokens, model). It deliberately
 * shows NO finding count / severity / verdict: Codex emits no structured
 * findings, so any such number would be fabricated. The actual review findings
 * appear in the transcript as the streamed assistant text, not here.
 *
 * Adapter over the shared NativeOrchestrationCard chassis (which renders the
 * `.claude-workflow-card` layout) with the `.review-card` hook; the Codex
 * identicon + brand accent come from the shared per-provider glyph treatment.
 */
export function ReviewCard({ activity, provider }: ReviewCardProps) {
  const telemetry: CodexReviewTelemetry = activity.reviewSummary ?? {}
  const cardProvider: ProviderId =
    (telemetry.provider as ProviderId | undefined) ?? provider ?? 'codex'
  const status: CodexReviewStatus = telemetry.status ?? 'unknown'

  const tokens = formatTokenCount(telemetry.totalTokens)
  const elapsed = formatDuration(telemetry.durationMs)

  const metaParts: string[] = ['Review']
  if (telemetry.target) metaParts.push(telemetry.target)
  if (tokens) metaParts.push(`${tokens} tokens`)
  if (elapsed) metaParts.push(elapsed)
  if (telemetry.model) metaParts.push(telemetry.model)

  return (
    <NativeOrchestrationCard
      cardClassName="review-card"
      provider={cardProvider}
      status={status}
      statusLabel={STATUS_LABEL[status]}
      isRunning={status === 'running'}
      useProviderAccent
      glyph={<AgentIdentityIcon seed={activity.id} size={16} title="Codex Review" />}
      name="Codex Review"
      metaParts={metaParts}
      detail={
        telemetry.error ? (
          <div className="claude-workflow-card-error">{telemetry.error}</div>
        ) : undefined
      }
    />
  )
}
