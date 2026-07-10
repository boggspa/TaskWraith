import { useMemo } from 'react'
import type { ProviderId, ToolActivity } from '../../../main/store/types'
import {
  parseWorkflowScriptMeta,
  type ClaudeWorkflowStatus,
  type ClaudeWorkflowTelemetry
} from '../../../shared/claudeWorkflow'
import { WorkflowGlyphIcon } from './AppChromeSymbols'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import {
  NativeOrchestrationCard,
  formatDuration,
  formatTokenCount
} from './NativeOrchestrationCard'

interface WorkflowCardProps {
  activity: ToolActivity
  /** Resolved provider that produced this orchestration run (from telemetry or
   * the chat/ensemble attribution). Drives the glyph + accent. Defaults to
   * claude for backward compatibility with the original Claude-only card. */
  provider?: ProviderId
}

const STATUS_LABEL: Record<ClaudeWorkflowStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  paused: 'Paused',
  unknown: 'Workflow'
}

function scriptFromParameters(parameters: Record<string, unknown> | undefined): string | undefined {
  if (!parameters) return undefined
  const script = parameters.script
  if (typeof script === 'string' && script.trim()) return script
  return undefined
}

/**
 * Transcript card for a provider-native multi-agent orchestration run — the
 * cousin of the Claude desktop app's workflow card. TaskWraith can't control the
 * orchestration (it runs inside the provider subprocess), so this is display-only:
 * it shows the live aggregate telemetry that leaks through the provider stream
 * (name, status, tokens, tool count, elapsed, sub-agent count) plus any phase
 * list parsed from the run script. The per-sub-agent token table the Claude
 * desktop card shows is NOT in any provider's wire protocol and is intentionally
 * omitted, not faked.
 *
 * Adapter over the shared NativeOrchestrationCard chassis. Provider-appropriate
 * identity: Claude keeps its bespoke `WorkflowGlyphIcon` and the app's global
 * `--accent`; every other provider gets a seeded design-assets agent identicon
 * tinted with its own `--provider-<id>-color`. Only ONE glyph is shown — it
 * represents the orchestration as a whole, because no per-sub-agent identity is
 * carried on the wire (`agentCount` is a bare number).
 */
export function WorkflowCard({ activity, provider }: WorkflowCardProps) {
  const telemetry: ClaudeWorkflowTelemetry = activity.workflowSummary ?? {}
  const parsedMeta = useMemo(
    () => parseWorkflowScriptMeta(scriptFromParameters(activity.parameters)),
    [activity.parameters]
  )

  const cardProvider: ProviderId =
    (telemetry.provider as ProviderId | undefined) ?? provider ?? 'claude'
  const isClaude = cardProvider === 'claude'
  const status: ClaudeWorkflowStatus = telemetry.status ?? 'unknown'
  const isRunning = status === 'running'
  const name = telemetry.workflowName || parsedMeta.name || 'Workflow'
  const description = telemetry.description || parsedMeta.description
  const phases = parsedMeta.phases ?? []

  const tokens = formatTokenCount(telemetry.totalTokens)
  const elapsed = formatDuration(telemetry.durationMs)
  const agentCount =
    typeof telemetry.agentCount === 'number' && telemetry.agentCount > 0
      ? telemetry.agentCount
      : undefined
  const toolUses =
    typeof telemetry.toolUses === 'number' && telemetry.toolUses > 0
      ? telemetry.toolUses
      : undefined

  const metaParts: string[] = ['Workflow']
  if (agentCount !== undefined) metaParts.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`)
  if (tokens) metaParts.push(`${tokens} tokens`)
  if (toolUses !== undefined) metaParts.push(`${toolUses} tool${toolUses === 1 ? '' : 's'}`)
  if (elapsed) metaParts.push(elapsed)

  const hasDetail = Boolean(
    description || telemetry.summary || telemetry.outputFile || telemetry.error || phases.length > 0
  )

  return (
    <NativeOrchestrationCard
      provider={cardProvider}
      status={status}
      statusLabel={STATUS_LABEL[status]}
      isRunning={isRunning}
      useProviderAccent={!isClaude}
      glyph={
        isClaude ? (
          <WorkflowGlyphIcon />
        ) : (
          <AgentIdentityIcon seed={activity.id} size={16} title={name} />
        )
      }
      name={name}
      metaParts={metaParts}
      currentLine={
        telemetry.lastToolName ? (
          <>
            currently: <span>{telemetry.lastToolName}</span>
          </>
        ) : undefined
      }
      extras={
        phases.length > 0 ? (
          <div className="claude-workflow-card-phases">
            <span className="claude-workflow-card-phases-label">Phases</span>
            {phases.map((phase, index) => (
              <span key={`${phase}-${index}`} className="claude-workflow-card-phase">
                {phase}
              </span>
            ))}
          </div>
        ) : undefined
      }
      detail={
        hasDetail ? (
          <>
            {description && <p className="claude-workflow-card-description">{description}</p>}
            {telemetry.summary && (
              <div className="claude-workflow-card-section">
                <div className="claude-workflow-card-section-title">Summary</div>
                <p>{telemetry.summary}</p>
              </div>
            )}
            {telemetry.error && <div className="claude-workflow-card-error">{telemetry.error}</div>}
            {telemetry.outputFile && (
              <div className="claude-workflow-card-output" title={telemetry.outputFile}>
                Result saved to <code>{telemetry.outputFile}</code>
              </div>
            )}
          </>
        ) : undefined
      }
    />
  )
}
