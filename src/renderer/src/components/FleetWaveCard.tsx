import { useId, type CSSProperties, type MouseEvent } from 'react'
import type { ProviderId } from '../../../main/store/types'
import type { SeatChangeSeatState } from '../../../shared/seatChange'
import {
  canAllowAllPendingApprovals,
  fleetWaveDensityTier,
  fleetWaveExceptions,
  fleetWaveGhostCellStates,
  fleetWaveRoleRollup,
  type FleetWaveAgentState,
  type FleetWaveTelemetry
} from '../../../shared/fleetWave'
import { NativeOrchestrationCard } from './NativeOrchestrationCard'
import { SeatStateChips, seatAccentVar } from './SeatChangeRow'
import { composedSeatRole } from '../lib/transcriptSeat'
import { ParticipantRoleIcon, participantRoleIconTitle } from './icons/ParticipantRoleIcon'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { providerDisplayName } from '../lib/AgentInvocationPresentation'
import { providerAccentVar, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'

/**
 * Per-agent accent for the in-flight states. A working agent used to wear the
 * generic running colour, which said nothing about whose agent it was — and a
 * wave may be multi-provider. Ollama and Pi route through
 * `resolveProviderHueClass` so a hosted Qwen paints its maker's hue rather
 * than the seat's. Settled states (done / failed) and the approval amber keep
 * their own meaning and never take this.
 */
function agentAccentStyle(agent: {
  provider?: string
  model?: string
  status?: string
}): CSSProperties | undefined {
  // Emitted ONLY for the state that reads it. Settled and waiting agents keep
  // the success / danger / warning tokens, so scoping the variable onto them
  // would be a style that does nothing and invites a later rule to consume it.
  if (agent.status !== 'working' || !agent.provider) return undefined
  const accent = providerAccentVar(resolveProviderHueClass(agent.provider, agent.model))
  return accent ? ({ '--accent': accent } as CSSProperties) : undefined
}

export interface FleetWaveCardProps {
  telemetry: FleetWaveTelemetry
  provider?: ProviderId
  /**
   * The seat that called the wave, resolved from the caller's RUN by the
   * transcript (never stamped on the card — see `seatFromChatRun`). Null on a
   * solo turn, which genuinely has no seat: the card then names the provider
   * rather than inventing one.
   */
  callerSeat?: SeatChangeSeatState | null
  onOpenSubThread?: (subThreadId: string) => void
  onOpenSubThreadInSidePanel?: (subThreadId: string) => void
  onAllowOnce?: (approvalId: string) => void
  onDeny?: (approvalId: string) => void
  onAllowAllSameScope?: (scopeKey: string) => void
}

const chipButtonStyle: CSSProperties = {
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  lineHeight: 'inherit'
}

/** Paths from taskwraith-ghost-monoline.svg (viewBox 0 0 128 128). */
const FLEET_WAVE_GHOST_PATHS = (
  <>
    <path d="M56 30H80L92 36L98 48V84H92L86 90L80 84L74 96L68 84L56 96L50 84H38V48L44 36Z" />
    <path d="M50 84V104" />
    <path d="M68 84V104" />
    <path d="M86 90V104" />
    <rect x="51" y="54" width="10" height="14" />
    <rect x="75" y="54" width="10" height="14" />
  </>
)

/**
 * Fourth NativeOrchestrationCard adapter — ephemeral/durable fleet progress.
 * Density ladder: ≤6 enumerate, 7–20 chips, 21+ aggregate (exceptions named).
 * The ghost density strip renders at EVERY tier — the little ghosts filling /
 * changing accent as agents settle are the card's progress read; only the
 * text treatment around them changes with density (2026-08-19: it was
 * aggregate-only, so the common ≤20-agent wave had no ghosts at all).
 *
 * The card wears the CALLER's provider accent — Claude included. It used to
 * keep the app accent, which left the commonest fleet reading as generic
 * app-blue with a bare lowercase provider id for a byline, naming neither the
 * caller nor the (possibly mixed) worker providers. Owner call 2026-08-19.
 */
export function FleetWaveCard({
  telemetry,
  provider,
  callerSeat,
  onOpenSubThread,
  onOpenSubThreadInSidePanel,
  onAllowOnce,
  onDeny,
  onAllowAllSameScope
}: FleetWaveCardProps) {
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
  const callerProvider = (provider || telemetry.parentProvider) as ProviderId | undefined
  const exceptions = fleetWaveExceptions(agents)
  const rollup = fleetWaveRoleRollup(agents)
  const progressFraction = count > 0 ? settled / count : undefined
  const canOpen = Boolean(onOpenSubThread || onOpenSubThreadInSidePanel)
  const pendingApprovals = telemetry.pendingApprovals || []

  const openAgent = (subThreadId: string) => {
    if (!subThreadId) return
    if (onOpenSubThreadInSidePanel) {
      onOpenSubThreadInSidePanel(subThreadId)
      return
    }
    onOpenSubThread?.(subThreadId)
  }

  const handleChipClick = (event: MouseEvent, subThreadId: string) => {
    event.stopPropagation()
    openAgent(subThreadId)
  }

  const statusLabel =
    status === 'needs_approval'
      ? `${waiting} waiting on you`
      : status === 'completed'
        ? 'Done'
        : status === 'failed'
          ? 'Failed'
          : 'Working in parallel'

  const renderAgentChip = (
    agent: FleetWaveAgentState,
    kind: 'worker' | 'exception',
    withStatusSuffix: boolean
  ) => {
    const openable = canOpen && Boolean(agent.id)
    const className = `fleet-wave-card-${kind} status-${agent.status}${openable ? ' clickable' : ''}`
    const label = withStatusSuffix ? `${agent.label} ${agentStatusSuffix(agent)}` : agent.label
    // A wave may be multi-provider, so the chip says which one ran it rather
    // than leaving the card's single caller accent to imply them all.
    const logo = agent.provider ? (
      <ProviderBrandLogoIcon
        provider={agent.provider as ProviderId}
        wrapperClassName="fleet-wave-card-worker-logo"
      />
    ) : null
    const chipTitle = agent.provider
      ? `${providerDisplayName(agent.provider)} · ${agent.label}`
      : agent.label
    const accentStyle = agentAccentStyle(agent)

    if (openable) {
      return (
        <button
          key={agent.id}
          type="button"
          className={className}
          style={{ ...chipButtonStyle, ...accentStyle }}
          title={`Open ${chipTitle}`}
          aria-label={`Open ${chipTitle}`}
          onClick={(event) => handleChipClick(event, agent.id)}
        >
          {logo}
          <span>{label}</span>
          <span className="fleet-wave-card-open" aria-hidden="true">
            ↗
          </span>
        </button>
      )
    }

    return (
      <span key={agent.id} className={className} title={chipTitle} style={accentStyle}>
        {logo}
        <span>{label}</span>
      </span>
    )
  }

  // Who called the fleet. The seat element is the same one the fan-out lane
  // card, sub-thread return, close-out table and question card use, so one
  // reading skill covers every "who" in the transcript. A seatless caller
  // (solo turn) keeps the provider label + mark — an unknown seat is not a
  // default one.
  const callerRole = composedSeatRole(callerSeat)
  const callerLead = callerSeat ? (
    <span className="fleet-wave-card-caller">
      {callerRole ? (
        <strong
          className="fleet-wave-card-caller-role"
          style={{ color: seatAccentVar(callerSeat) }}
          title={
            [participantRoleIconTitle(callerSeat.authority, callerSeat.stageRole), callerRole]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        >
          <ParticipantRoleIcon
            authority={callerSeat.authority}
            stageRole={callerSeat.stageRole}
            className="seat-role-icon"
          />
          {callerRole}
        </strong>
      ) : null}
      <SeatStateChips seat={callerSeat} className="fleet-wave-card-caller-seat" />
    </span>
  ) : callerProvider ? (
    <span className="fleet-wave-card-caller">
      <ProviderBrandLogoIcon
        provider={callerProvider}
        wrapperClassName="fleet-wave-card-caller-logo"
      />
      <span className="fleet-wave-card-caller-provider">
        {providerDisplayName(callerProvider)}
      </span>
    </span>
  ) : null

  const elevationRow =
    pendingApprovals.length > 0 ? (
      <FleetWaveElevationRow
        pendingApprovals={pendingApprovals}
        onAllowOnce={onAllowOnce}
        onDeny={onDeny}
        onAllowAllSameScope={onAllowAllSameScope}
      />
    ) : null

  const densityExtras =
    tier === 'aggregate' ? (
      <>
        <FleetWaveDensityStrip agents={agents} settled={settled} total={count} />
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
          {exceptions.map((agent) => renderAgentChip(agent, 'exception', false))}
          {count - exceptions.length > 0 ? (
            <span className="fleet-wave-card-more">{count - exceptions.length} others healthy</span>
          ) : null}
        </div>
        {elevationRow}
      </>
    ) : (
      <>
        <FleetWaveDensityStrip agents={agents} settled={settled} total={count} />
        <div className="fleet-wave-card-workers" data-testid="fleet-wave-workers">
          {agents.map((agent) => renderAgentChip(agent, 'worker', tier === 'enumerate'))}
        </div>
        {elevationRow}
      </>
    )

  return (
    <NativeOrchestrationCard
      cardClassName="fleet-wave-card"
      provider={(provider || telemetry.parentProvider || 'claude') as ProviderId}
      status={
        status === 'needs_approval'
          ? 'paused'
          : status === 'completed'
            ? 'completed'
            : status === 'failed'
              ? 'failed'
              : 'running'
      }
      statusLabel={statusLabel}
      isRunning={status === 'running' || status === 'needs_approval'}
      useProviderAccent
      glyph={
        <span className="fleet-wave-card-glyph" aria-hidden="true">
          {/* Mini ghost mark; stroke 7 user units ≈ 1.2px at the 14px slot
           * render of the 128-unit paths (same equation as the strip cells). */}
          <svg
            width={14}
            height={14}
            viewBox="0 0 128 128"
            fill="none"
            stroke="currentColor"
            strokeWidth={7}
            strokeLinejoin="round"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            {FLEET_WAVE_GHOST_PATHS}
          </svg>
        </span>
      }
      name={count ? `Fleet · ${count} agents` : 'Fleet'}
      metaLead={callerLead}
      metaParts={
        [
          count ? `${settled} of ${count} returned` : undefined,
          telemetry.durationMs != null ? `${Math.round(telemetry.durationMs / 1000)}s` : undefined
        ].filter(Boolean) as string[]
      }
      progressFraction={progressFraction}
      extras={densityExtras}
    />
  )
}

function FleetWaveDensityStrip({
  agents,
  settled,
  total
}: {
  agents: readonly FleetWaveAgentState[]
  settled: number
  total: number
}) {
  const ghostSymbolId = `fleet-wave-ghost${useId().replace(/:/g, '')}`
  const ghostCells = fleetWaveGhostCellStates(agents)

  return (
    <div
      className="fleet-wave-card-density"
      role="img"
      aria-label={`${settled} of ${total} settled`}
    >
      <svg
        width={0}
        height={0}
        aria-hidden="true"
        focusable="false"
        style={{ position: 'absolute' }}
      >
        <symbol id={ghostSymbolId} viewBox="0 0 128 128">
          {FLEET_WAVE_GHOST_PATHS}
        </symbol>
      </svg>
      {ghostCells.map((cell) => (
        <svg
          key={cell.id}
          className={`fleet-wave-card-cell status-${cell.status}`}
          style={agentAccentStyle(cell)}
          viewBox="0 0 128 128"
          aria-hidden="true"
          focusable="false"
        >
          <use href={`#${ghostSymbolId}`} />
        </svg>
      ))}
    </div>
  )
}

function FleetWaveElevationRow({
  pendingApprovals,
  onAllowOnce,
  onDeny,
  onAllowAllSameScope
}: {
  pendingApprovals: NonNullable<FleetWaveTelemetry['pendingApprovals']>
  onAllowOnce?: (approvalId: string) => void
  onDeny?: (approvalId: string) => void
  onAllowAllSameScope?: (scopeKey: string) => void
}) {
  const first = pendingApprovals[0]
  const total = pendingApprovals.length
  const hasActions = Boolean(onAllowOnce || onDeny || onAllowAllSameScope)
  const showAllowAll = Boolean(onAllowAllSameScope) && canAllowAllPendingApprovals(pendingApprovals)

  return (
    <div className="fleet-wave-card-elevation">
      <span className="fleet-wave-card-elevation-count">1 of {total}</span>
      <span className="fleet-wave-card-elevation-text">
        {first.postureLabel ? (
          <>
            <strong>{first.postureLabel}</strong>
            {' — '}
          </>
        ) : null}
        {first.summary}
        {!hasActions ? ' Review pending approvals to continue.' : null}
      </span>
      {hasActions ? (
        <div className="fleet-wave-card-elevation-actions">
          {onAllowOnce ? (
            <button
              type="button"
              className="fleet-wave-card-elevation-btn primary"
              onClick={() => onAllowOnce(first.approvalId)}
            >
              Allow once
            </button>
          ) : null}
          {onDeny ? (
            <button
              type="button"
              className="fleet-wave-card-elevation-btn"
              onClick={() => onDeny(first.approvalId)}
            >
              Deny
            </button>
          ) : null}
          {showAllowAll ? (
            <button
              type="button"
              className="fleet-wave-card-elevation-btn primary"
              onClick={() => onAllowAllSameScope?.(first.scopeKey)}
            >
              Allow all
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function agentStatusSuffix(agent: FleetWaveAgentState): string {
  if (agent.status === 'completed') return 'done'
  if (agent.status === 'failed') return 'failed'
  if (agent.status === 'needs_approval') return 'waiting'
  if (agent.status === 'working') return 'working'
  return 'queued'
}
