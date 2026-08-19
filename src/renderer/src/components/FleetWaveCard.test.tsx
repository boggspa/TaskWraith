import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FleetWaveAgentState, FleetWaveTelemetry } from '../../../shared/fleetWave'
import { findClickableByClassName } from '../test/reactElementTree'
import { FleetWaveCard } from './FleetWaveCard'

function agent(index: number, overrides: Partial<FleetWaveAgentState> = {}): FleetWaveAgentState {
  return {
    id: `agent-${index}`,
    label: `worker-${index}`,
    role: 'worker',
    status: 'working',
    ...overrides
  }
}

function agents(
  count: number,
  map?: (i: number) => Partial<FleetWaveAgentState>
): FleetWaveAgentState[] {
  return Array.from({ length: count }, (_, i) => agent(i + 1, map?.(i + 1)))
}

function telemetry(overrides: Partial<FleetWaveTelemetry> = {}): FleetWaveTelemetry {
  return {
    status: 'running',
    parentProvider: 'claude',
    agents: agents(2),
    ...overrides
  }
}

describe('FleetWaveCard', () => {
  it('renders the shared workflow card shell with fleet-wave-card', () => {
    const html = renderToStaticMarkup(<FleetWaveCard telemetry={telemetry()} />)
    expect(html).toContain('claude-workflow-card')
    expect(html).toContain('fleet-wave-card')
  })

  describe('provider accent', () => {
    it('tints Claude with its own brand accent like every other caller', () => {
      // Owner call 2026-08-19: the fleet card read as generic app-blue and gave
      // no clue whose fleet it was. It now inherits the CALLER's accent, so the
      // old `useProviderAccent={!isClaude}` exception is deliberately inverted
      // here — do not restore it (same shape as the ghost-strip pin).
      const html = renderToStaticMarkup(
        <FleetWaveCard telemetry={telemetry({ parentProvider: 'claude' })} provider="claude" />
      )
      expect(html).toContain('data-provider="claude"')
      expect(html).toContain('--provider-accent')
      expect(html).toContain('var(--provider-claude-color')
    })

    it('renders a non-Claude provider with a brand accent', () => {
      const html = renderToStaticMarkup(
        <FleetWaveCard telemetry={telemetry({ parentProvider: 'codex' })} provider="codex" />
      )
      expect(html).toContain('data-provider="codex"')
      expect(html).toContain('--provider-accent')
      expect(html).toContain('var(--provider-codex-color')
    })
  })

  it('enumerates ≤6 agents with status suffix chips (done/working)', () => {
    const html = renderToStaticMarkup(
      <FleetWaveCard
        telemetry={telemetry({
          agents: [
            agent(1, { label: 'audit_css', status: 'completed' }),
            agent(2, { label: 'audit_tests', status: 'working' }),
            agent(3, { label: 'audit_docs', status: 'pending' }),
            agent(4, { label: 'audit_types', status: 'completed' }),
            agent(5, { label: 'audit_lint', status: 'working' }),
            agent(6, { label: 'audit_build', status: 'completed' })
          ]
        })}
      />
    )
    expect(html).toContain('data-testid="fleet-wave-workers"')
    expect(html).toContain('fleet-wave-card-worker status-completed')
    expect(html).toContain('fleet-wave-card-worker status-working')
    expect(html).toContain('audit_css done')
    expect(html).toContain('audit_tests working')
    expect(html).toContain('Fleet · 6 agents')
    // The ghost strip fills/accents per agent at EVERY tier, not only 21+.
    expect(html).toContain('fleet-wave-card-density')
    expect(html).toContain('fleet-wave-card-cell status-completed')
    expect(html).toContain('fleet-wave-card-cell status-working')
    expect(html).toContain('fleet-wave-card-cell status-pending')
  })

  it('chips 7–20 agents without status suffix text or multi-agent state class', () => {
    const html = renderToStaticMarkup(
      <FleetWaveCard
        telemetry={telemetry({
          agents: agents(8, (i) => ({
            label: `chip-${i}`,
            status: i % 2 === 0 ? 'completed' : 'working'
          }))
        })}
      />
    )
    expect(html).toContain('data-testid="fleet-wave-workers"')
    expect(html).toContain('chip-1')
    expect(html).toContain('chip-8')
    expect(html).not.toContain('multi-agent-card-agent-state')
    expect(html).not.toContain('chip-1 working')
    expect(html).not.toContain('chip-2 done')
    expect(html).toContain('Fleet · 8 agents')
    // Chips drop the text suffix, but the ghost strip still carries status.
    expect(html).toContain('fleet-wave-card-density')
    expect(html).toContain('fleet-wave-card-cell status-completed')
    expect(html).toContain('fleet-wave-card-cell status-working')
  })

  it('aggregates 21+ agents with density strip, rollup, named exceptions, and healthy others', () => {
    const list = agents(21, (i) => ({
      label: `fleet-${i}`,
      role: i <= 3 ? 'scout' : i >= 20 ? 'reviewer' : 'worker',
      status:
        i === 5 ? 'failed' : i === 6 ? 'needs_approval' : i % 3 === 0 ? 'completed' : 'working'
    }))
    const html = renderToStaticMarkup(<FleetWaveCard telemetry={telemetry({ agents: list })} />)
    expect(html).toContain('fleet-wave-card-density')
    expect(html).toContain('role="img"')
    expect(html).toMatch(/aria-label="[^"]*7 of 21[^"]*"/)
    expect(html).toContain('fleet-wave-card-cell status-failed')
    expect(html).toContain('fleet-wave-card-cell status-needs_approval')
    expect(html).toContain('fleet-wave-card-cell status-completed')
    expect(html).toContain('fleet-wave-card-cell status-working')
    expect(html).toContain('data-testid="fleet-wave-rollup"')
    expect(html).toContain('fleet-wave-card-rollup')
    expect(html).toContain('scouts:')
    expect(html).toContain('workers:')
    expect(html).toContain('reviewers:')
    expect(html).toContain('fleet-5')
    expect(html).toContain('fleet-6')
    expect(html).toContain('fleet-wave-card-exception status-failed')
    expect(html).toContain('fleet-wave-card-exception status-needs_approval')
    expect(html).toContain('19 others healthy')
    expect(html).not.toContain('data-testid="fleet-wave-workers"')
    expect(html).toContain('Fleet · 21 agents')
  })

  it('renders the ghost density strip at every tier, workers row intact', () => {
    // 2026-08-19: the strip used to be aggregate-only (21+), so the common
    // 8-agent wave showed text chips with no ghosts — the intended design has
    // the little ghosts filling/changing accent as agents settle at ANY size.
    const html = renderToStaticMarkup(
      <FleetWaveCard telemetry={telemetry({ agents: agents(20) })} />
    )
    expect(html).toContain('fleet-wave-card-density')
    expect(html).toContain('data-testid="fleet-wave-workers"')
  })

  it('renders a read-only elevation row when pendingApprovals are present without action props', () => {
    const html = renderToStaticMarkup(
      <FleetWaveCard
        telemetry={telemetry({
          agents: agents(3),
          pendingApprovals: [
            {
              approvalId: 'a1',
              scopeKey: 'write:types',
              summary: 'Widen write scope for types',
              postureLabel: 'workspace write'
            }
          ]
        })}
      />
    )
    expect(html).toContain('fleet-wave-card-elevation')
    expect(html).toContain('fleet-wave-card-elevation-count')
    expect(html).toContain('1 of 1')
    expect(html).toContain('Widen write scope for types')
    expect(html).not.toContain('fleet-wave-card-elevation-actions')
    expect(html).not.toContain('Allow all')
  })

  it('shows Allow all only when every pending approval shares one scopeKey', () => {
    const sameScope = renderToStaticMarkup(
      <FleetWaveCard
        telemetry={telemetry({
          agents: agents(3),
          pendingApprovals: [
            { approvalId: 'a1', scopeKey: 'write:types', summary: 'First' },
            { approvalId: 'a2', scopeKey: 'write:types', summary: 'Second' }
          ]
        })}
        onAllowOnce={() => {}}
        onDeny={() => {}}
        onAllowAllSameScope={() => {}}
      />
    )
    expect(sameScope).toContain('1 of 2')
    expect(sameScope).toContain('fleet-wave-card-elevation-actions')
    expect(sameScope).toContain('Allow once')
    expect(sameScope).toContain('Deny')
    expect(sameScope).toContain('Allow all')

    const mixedScope = renderToStaticMarkup(
      <FleetWaveCard
        telemetry={telemetry({
          agents: agents(3),
          pendingApprovals: [
            { approvalId: 'a1', scopeKey: 'write:types', summary: 'First' },
            { approvalId: 'a2', scopeKey: 'shell', summary: 'Second' }
          ]
        })}
        onAllowOnce={() => {}}
        onDeny={() => {}}
        onAllowAllSameScope={() => {}}
      />
    )
    expect(mixedScope).toContain('Allow once')
    expect(mixedScope).toContain('Deny')
    expect(mixedScope).not.toContain('Allow all')
  })

  it('names the card Fleet · N agents', () => {
    const html = renderToStaticMarkup(
      <FleetWaveCard telemetry={telemetry({ agents: agents(4) })} />
    )
    expect(html).toContain('Fleet · 4 agents')
    expect(html).toContain('claude-workflow-card-name')
  })

  describe('caller identity', () => {
    const callerSeat = {
      provider: 'claude',
      model: 'Claude Fable 5',
      role: 'SolBoss',
      seatNumber: 1,
      authority: 'boss' as const,
      permissionPresetId: 'workspace_write'
    }

    it('names the caller with the shared seat element, not a bare provider id', () => {
      // The meta line used to read a raw lowercase "claude", which named
      // neither the caller nor the workers' providers unambiguously.
      const html = renderToStaticMarkup(
        <FleetWaveCard telemetry={telemetry()} provider="claude" callerSeat={callerSeat} />
      )
      expect(html).toContain('seat-state-chips')
      expect(html).toContain('fleet-wave-card-caller')
      expect(html).toContain('SolBoss')
      expect(html).not.toMatch(/claude-workflow-card-meta[^>]*>claude/)
    })

    it('falls back to the provider label when the caller run records no seat', () => {
      // Solo turns genuinely have no seat; naming one would be a lie, but the
      // raw id is still not what a reader should see.
      const html = renderToStaticMarkup(
        <FleetWaveCard telemetry={telemetry({ parentProvider: 'mistral' })} provider="mistral" />
      )
      expect(html).toContain('fleet-wave-card-caller')
      expect(html).toContain('Mistral')
      expect(html).not.toContain('seat-state-chips')
    })

    it('gives every worker chip its own provider logo', () => {
      // A multi-provider fleet is the whole reason allowMultiProvider exists —
      // the chip has to say which provider ran it.
      const html = renderToStaticMarkup(
        <FleetWaveCard
          telemetry={telemetry({
            allowMultiProvider: true,
            agents: [
              agent(1, { provider: 'mistral', label: 'CAM7-market-v2' }),
              agent(2, { provider: 'codex', label: 'CAM8-inn-v2' })
            ]
          })}
          provider="claude"
        />
      )
      expect(html).toContain('data-provider-logo="mistral"')
      expect(html).toContain('data-provider-logo="codex"')
    })

    it('omits the chip logo when an agent records no provider', () => {
      const html = renderToStaticMarkup(<FleetWaveCard telemetry={telemetry()} provider="claude" />)
      expect(html).not.toContain('fleet-wave-card-worker-logo')
    })
  })

  it('opens a worker sub-thread from a chip without bubbling', () => {
    const onOpenSubThreadInSidePanel = vi.fn()
    const stopPropagation = vi.fn()
    const tree = FleetWaveCard({
      telemetry: telemetry({
        agents: [agent(1, { id: 'sub-worker-1', label: 'audit_css', status: 'working' })]
      }),
      onOpenSubThread: () => {},
      onOpenSubThreadInSidePanel
    })
    const extras = (tree as { props: { extras?: unknown } }).props.extras

    findClickableByClassName(extras as never, 'fleet-wave-card-worker').props.onClick?.({
      stopPropagation
    })

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onOpenSubThreadInSidePanel).toHaveBeenCalledWith('sub-worker-1')
  })
})
