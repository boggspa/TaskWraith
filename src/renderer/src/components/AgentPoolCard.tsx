import type { DragEvent, JSX } from 'react'
import { getProviderLabel } from '../lib/providerLabels'
import { pooledAgentIconProps, type PooledAgent } from '../lib/ensembleAgentPool'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import type { PooledAgentStatsSummary } from '../../../main/store/types'

interface AgentPoolCardProps {
  agent: PooledAgent
  isActive: boolean
  stats?: PooledAgentStatsSummary
  onSelect: (agentId: string) => void
  onDelete: (agent: PooledAgent) => void
  /** Phase 1c — drag the card (via its grip) into a preset participant list. */
  onDragStart?: (event: DragEvent<HTMLSpanElement>, agent: PooledAgent) => void
  onDragEnd?: (event: DragEvent<HTMLSpanElement>) => void
  draggable?: boolean
}

function modelSubtitle(agent: PooledAgent): string {
  const provider = getProviderLabel(agent.config.provider)
  const model = agent.config.model && agent.config.model !== 'cli-default' ? agent.config.model : ''
  return model ? `${provider} · ${model}` : provider
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * A single pooled-Agent card: identity icon + nickname + provider/model
 * subtitle + (Phase 2) a compact stat strip. Click selects it for editing in
 * the band's editor; the trash affordance removes it. Draggable in Phase 1c.
 */
export function AgentPoolCard({
  agent,
  isActive,
  stats,
  onSelect,
  onDelete,
  onDragStart,
  onDragEnd,
  draggable = false
}: AgentPoolCardProps): JSX.Element {
  const icon = pooledAgentIconProps(agent)
  return (
    <div
      className={`agent-pool-card${isActive ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      onClick={() => onSelect(agent.agentId)}
      onKeyDown={(event) => {
        // Only the card itself — not a bubbled keypress from the nested delete
        // button (Enter/Space on a focused button fires its own keydown).
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(agent.agentId)
        }
      }}
    >
      {draggable && (
        // Drag is scoped to this grip (a non-interactive span), NOT the whole
        // card — native `draggable` on a clickable element suppresses onClick in
        // Electron's Chromium (the EnsembleParticipantsAboveRow lesson).
        <span
          className="agent-pool-card-grip"
          draggable
          onDragStart={onDragStart ? (event) => onDragStart(event, agent) : undefined}
          onDragEnd={onDragEnd}
          onClick={(event) => event.stopPropagation()}
          title="Drag into a preset"
          aria-hidden
        >
          ⠿
        </span>
      )}
      <AgentIdentityIcon
        name={icon.name}
        seed={icon.seed}
        color={icon.color}
        size={28}
        className="agent-pool-card-icon"
      />
      <div className="agent-pool-card-body">
        <span className="agent-pool-card-name">{agent.identity.nickname}</span>
        <span className="agent-pool-card-sub">{modelSubtitle(agent)}</span>
        {stats && stats.runs > 0 && (
          <span className="agent-pool-card-stats" title="Work done across threads as this agent">
            {stats.runs} run{stats.runs === 1 ? '' : 's'} · {compact(stats.tokensTotal)} tok
            {stats.linesAdded + stats.linesRemoved > 0
              ? ` · +${compact(stats.linesAdded)}/-${compact(stats.linesRemoved)}`
              : ''}
          </span>
        )}
      </div>
      <button
        type="button"
        className="agent-pool-card-delete"
        onClick={(event) => {
          event.stopPropagation()
          onDelete(agent)
        }}
        title="Delete this agent"
        aria-label={`Delete ${agent.identity.nickname}`}
      >
        ✕
      </button>
    </div>
  )
}
