import { useMemo, useState } from 'react'
import type { ToolActivity } from '../../../main/store/types'
import {
  parseWorkflowScriptMeta,
  type ClaudeWorkflowStatus,
  type ClaudeWorkflowTelemetry
} from '../../../shared/claudeWorkflow'
import { WorkflowGlyphIcon } from './AppChromeSymbols'

interface ClaudeWorkflowCardProps {
  activity: ToolActivity
}

const STATUS_LABEL: Record<ClaudeWorkflowStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  paused: 'Paused',
  unknown: 'Workflow'
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

function scriptFromParameters(parameters: Record<string, unknown> | undefined): string | undefined {
  if (!parameters) return undefined
  const script = parameters.script
  if (typeof script === 'string' && script.trim()) return script
  return undefined
}

/**
 * Transcript card for a Claude-native `Workflow` tool run — the multi-agent
 * orchestration the Claude desktop app shows its own card for. TaskWraith can't
 * control the workflow, so this is display-only: it shows the live aggregate
 * telemetry that leaks through the Agent SDK stream (name, status, tokens, tool
 * count, elapsed, sub-agent count) plus the phase list parsed from the workflow
 * script. The per-sub-agent token table the desktop card shows is NOT in the
 * wire protocol and is intentionally omitted, not faked.
 */
export function ClaudeWorkflowCard({ activity }: ClaudeWorkflowCardProps) {
  const telemetry: ClaudeWorkflowTelemetry = activity.workflowSummary ?? {}
  const parsedMeta = useMemo(
    () => parseWorkflowScriptMeta(scriptFromParameters(activity.parameters)),
    [activity.parameters]
  )

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
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`claude-workflow-card status-${status}`} data-provider="claude">
      <button
        type="button"
        className="claude-workflow-card-header"
        aria-expanded={hasDetail ? expanded : undefined}
        disabled={!hasDetail}
        onClick={hasDetail ? () => setExpanded((current) => !current) : undefined}
      >
        <span className="claude-workflow-card-glyph" aria-hidden>
          <WorkflowGlyphIcon />
        </span>
        <span className="claude-workflow-card-name">{name}</span>
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

      {isRunning && telemetry.lastToolName && (
        <div className="claude-workflow-card-current">
          currently: <span>{telemetry.lastToolName}</span>
        </div>
      )}

      {phases.length > 0 && (
        <div className="claude-workflow-card-phases">
          <span className="claude-workflow-card-phases-label">Phases</span>
          {phases.map((phase, index) => (
            <span key={`${phase}-${index}`} className="claude-workflow-card-phase">
              {phase}
            </span>
          ))}
        </div>
      )}

      {expanded && hasDetail && (
        <div className="claude-workflow-card-body">
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
        </div>
      )}
    </div>
  )
}
