import type { ProviderId } from '../../../main/store/types'
import {
  fleetWaveDensityTier,
  fleetWaveExceptions,
  fleetWaveRoleRollup,
  type FleetWaveAgentState,
  type FleetWaveTelemetry
} from '../../../shared/fleetWave'
import { NativeOrchestrationCard } from './NativeOrchestrationCard'

export interface FleetWaveCardProps {
  telemetry: FleetWaveTelemetry
  provider?: ProviderId
}

/**
 * Fourth NativeOrchestrationCard adapter — ephemeral/durable fleet progress.
 * Density ladder: ≤6 enumerate, 7–20 chips, 21+ aggregate (exceptions named).
 * Claude keeps the app accent (`useProviderAccent={!isClaude}`).
 */
export function FleetWaveCard({ telemetry, provider }: FleetWaveCardProps) {
  const agents = telemetry.agents || []
  const count = agents.length
  const tier = fleetWaveDensityTier(count)
  const settled = agents.filter((a) => a.status === 'completed' || a.status === 'failed').length
  const failed = agents.filter((a) => a.status === 'failed').length
  const waiting = agents.filter((a) => a.status === 'needs_approval').length
  const status =
    telemetry.status === 'needs_approval' || waiting > 0
      ? 'needs_approval'
      : telemetry.status === 'failed' || (failed > 0 && settled === count && count > 0)
        ? 'failed'
        : telemetry.status === 'completed' || (settled === count && count > 0)
          ? 'completed'
          : 'running'
  const isClaude = (provider || telemetry.parentProvider) === 'claude'
  const exceptions = fleetWaveExceptions(agents)
  const rollup = fleetWaveRoleRollup(agents)
  const progressFraction = count > 0 ? settled / count : undefined

  const statusLabel =
    status === 'needs_approval'
      ? `${waiting} waiting on you`
      : status === 'completed'
        ? 'Done'
        : status === 'failed'
          ? 'Failed'
          : 'Working in parallel.'

  const densityExtras =
    tier === 'aggregate' ? (
      <>
        <div className="fleet-wave-card-rollup" data-testid="fleet-wave-rollup">
          {rollup.map((row) => (
            <div key={row.role} className="fleet-wave-card-rollup-role">
              <strong>{row.role}s:</strong> {row.completed}/{row.total}
              {row.working ? ` (${row.working} working)` : ''}
              {row.failed ? ` (${row.failed} failed)` : ''}
              {row.waiting ? ` (${row.waiting} waiting)` : ''}
            </div>
          ))}
        </div>
        <div className="fleet-wave-card-exceptions">
          {exceptions.map((agent) => (
            <span key={agent.id} className={`fleet-wave-card-exception status-${agent.status}`}>
              {agent.label}
            </span>
          ))}
          {count - exceptions.length > 0 ? (
            <span className="fleet-wave-card-more">{count - exceptions.length} others healthy</span>
          ) : null}
        </div>
      </>
    ) : (
      <div className="fleet-wave-card-workers" data-testid="fleet-wave-workers">
        {agents.map((agent) => (
          <span key={agent.id} className={`fleet-wave-card-worker status-${agent.status}`}>
            {agent.label}
            {tier === 'enumerate' ? ` ${agentStatusSuffix(agent)}` : ''}
          </span>
        ))}
      </div>
    )

  return (
    <NativeOrchestrationCard
      cardClassName="fleet-wave-card"
      provider={(provider || telemetry.parentProvider || 'claude') as ProviderId}
      status={status === 'needs_approval' ? 'paused' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running'}
      statusLabel={statusLabel}
      isRunning={status === 'running' || status === 'needs_approval'}
      useProviderAccent={!isClaude}
      glyph={<span className="fleet-wave-card-glyph" aria-hidden="true">⬡</span>}
      name={count ? `Fleet · ${count} agents` : 'Fleet'}
      metaParts={[
        telemetry.parentProvider,
        count ? `${settled} of ${count} returned` : undefined,
        telemetry.durationMs != null ? `${Math.round(telemetry.durationMs / 1000)}s` : undefined
      ].filter(Boolean) as string[]}
      progressFraction={progressFraction}
      extras={densityExtras}
    />
  )
}

function agentStatusSuffix(agent: FleetWaveAgentState): string {
  if (agent.status === 'completed') return 'done'
  if (agent.status === 'failed') return 'failed'
  if (agent.status === 'needs_approval') return 'waiting'
  if (agent.status === 'working') return 'working'
  return 'queued'
}
