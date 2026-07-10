import type { ProviderId, ToolActivity } from '../../../main/store/types'
import type {
  CodexMultiAgentStatus,
  CodexMultiAgentTelemetry,
  CodexSubagentState
} from '../../../shared/codexMultiAgent'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import {
  NativeOrchestrationCard,
  formatDuration,
  formatTokenCount
} from './NativeOrchestrationCard'

interface CodexMultiAgentCardProps {
  activity: ToolActivity
  /** Resolved provider (codex today). Drives glyph + accent. */
  provider?: ProviderId
}

const STATUS_LABEL: Record<CodexMultiAgentStatus, string> = {
  delegating: 'Delegating',
  working: 'Working in parallel',
  synthesizing: 'Synthesizing',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unknown: 'Multi-agent'
}

const SUBAGENT_STATUS_LABEL: Record<CodexSubagentState['status'], string> = {
  spawned: 'spawned',
  working: 'working',
  completed: 'done',
  failed: 'failed',
  interrupted: 'interrupted'
}

/** Live "currently: …" copy from the last observed coordination action. */
function coordinationLine(tool: string | undefined): string | undefined {
  const value = (tool || '').toLowerCase()
  if (!value) return undefined
  if (value === 'wait' || value === 'wait_agent') return 'waiting on subagents'
  if (value === 'send_message' || value === 'send') return 'messaging a subagent'
  if (value === 'followup_task') return 'assigning follow-up work'
  if (value === 'interrupt' || value === 'interrupt_agent') return 'interrupting a subagent'
  if (value === 'list_agents') return 'checking subagent status'
  return undefined
}

/**
 * Transcript card for a Codex native Multi-agent episode — the root agent
 * delegating work to parallel subagents and synthesizing their results.
 * Anchored to the synthesized `codex_multi_agent` activity; an adapter over
 * the shared NativeOrchestrationCard chassis with a `.multi-agent-card` hook.
 *
 * Honesty rules (matching the shared telemetry model):
 * - Everything shown comes from explicit provider events. Subagent chips and
 *   counts render ONLY at `detailLevel: 'full'` (identities observed); at
 *   `'detected'` the card says delegation was detected without inventing
 *   numbers, and the meter stays indeterminate.
 * - Determinate progress = settled/observed subagents — real transitions, not
 *   an estimate. No observed subagents → indeterminate while running.
 * - Subagent labels are the plaintext `task_name` tail of the agent path; the
 *   encrypted spawn/message payloads are never decoded or rendered.
 * - "synthesized their results" is only claimed when the synthesis phase was
 *   actually observed before a successful settle.
 */
export function CodexMultiAgentCard({ activity, provider }: CodexMultiAgentCardProps) {
  const telemetry: CodexMultiAgentTelemetry = activity.multiAgentSummary ?? {}
  const cardProvider: ProviderId =
    (telemetry.provider as ProviderId | undefined) ?? provider ?? 'codex'
  const status: CodexMultiAgentStatus = telemetry.status ?? 'unknown'
  const isRunning = status === 'delegating' || status === 'working' || status === 'synthesizing'

  const fullDetail = telemetry.detailLevel === 'full'
  const subagents = fullDetail ? (telemetry.subagents ?? []) : []
  const settledCount = subagents.filter(
    (agent) =>
      agent.status === 'completed' || agent.status === 'failed' || agent.status === 'interrupted'
  ).length

  const tokens = formatTokenCount(telemetry.totalTokens)
  const elapsed = formatDuration(telemetry.durationMs)

  const metaParts: string[] = ['Multi-agent']
  if (subagents.length > 0) {
    metaParts.push(`${subagents.length} subagent${subagents.length === 1 ? '' : 's'}`)
  }
  if (tokens) metaParts.push(`${tokens} tokens`)
  if (elapsed) metaParts.push(elapsed)

  // Real observed progress only: settled/observed at full detail. Indeterminate
  // otherwise — never a fabricated percentage.
  const progressFraction =
    isRunning && subagents.length > 0 ? settledCount / subagents.length : undefined

  const currently =
    status === 'synthesizing'
      ? 'synthesizing results'
      : coordinationLine(telemetry.lastCoordination)

  // Evidence-level copy. Level 3 (no explicit detection) never reaches this
  // card — the anchor only exists after an explicit provider event.
  const evidenceNote = !fullDetail
    ? 'Parallel delegation detected — per-subagent details are not available for this run.'
    : status === 'completed' && telemetry.synthesized
      ? `Delegated to ${subagents.length} subagent${subagents.length === 1 ? '' : 's'} in parallel and synthesized their results.`
      : undefined

  return (
    <NativeOrchestrationCard
      cardClassName="multi-agent-card"
      provider={cardProvider}
      status={status}
      statusLabel={STATUS_LABEL[status]}
      isRunning={isRunning}
      useProviderAccent
      glyph={<AgentIdentityIcon seed={activity.id} size={16} title="Codex Multi-agent" />}
      name="Codex Multi-agent"
      metaParts={metaParts}
      progressFraction={progressFraction}
      currentLine={
        currently ? (
          <>
            currently: <span>{currently}</span>
          </>
        ) : undefined
      }
      extras={
        <>
          {subagents.length > 0 && (
            <div className="claude-workflow-card-phases multi-agent-card-agents">
              <span className="claude-workflow-card-phases-label">Subagents</span>
              {subagents.map((agent) => (
                <span
                  key={agent.id}
                  className={`claude-workflow-card-phase multi-agent-card-agent status-${agent.status}`}
                  title={`${agent.taskName || 'subagent'} — ${SUBAGENT_STATUS_LABEL[agent.status]}`}
                >
                  {agent.taskName || 'subagent'}
                  <span className="multi-agent-card-agent-state">
                    {SUBAGENT_STATUS_LABEL[agent.status]}
                  </span>
                </span>
              ))}
            </div>
          )}
          {evidenceNote && <div className="multi-agent-card-note">{evidenceNote}</div>}
        </>
      }
      detail={
        telemetry.error ? (
          <div className="claude-workflow-card-error">{telemetry.error}</div>
        ) : undefined
      }
    />
  )
}
