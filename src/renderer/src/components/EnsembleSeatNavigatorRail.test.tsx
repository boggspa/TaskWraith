import { readFileSync } from 'node:fs'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import { EnsembleSeatNavigatorRail } from './EnsembleSeatNavigatorRail'

function makeParticipant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: 'ensemble-claude',
    provider: 'claude',
    enabled: true,
    role: 'Explorer',
    instructions: '',
    order: 1,
    model: 'claude-opus-4-7',
    permissionPresetId: 'read_only',
    ...overrides
  }
}

/** Walk the hook-free component's JSX for the seat chip button elements. */
function seatChipButtons(
  participants: EnsembleParticipant[],
  selectedParticipantId: string | null,
  onSelectParticipant: (participantId: string) => void
): ReactElement<{ onClick: () => void; 'data-participant-id': string }>[] {
  const rail = EnsembleSeatNavigatorRail({
    participants,
    selectedParticipantId,
    onSelectParticipant
  }) as ReactElement<{ children: ReactElement<{ children: unknown }>[] }>
  const [, list] = rail.props.children
  return list.props.children as ReactElement<{
    onClick: () => void
    'data-participant-id': string
  }>[]
}

describe('EnsembleSeatNavigatorRail', () => {
  const participants = [
    makeParticipant({ id: 'planner', role: 'Planner', model: 'claude-opus-4-7' }),
    makeParticipant({
      id: 'builder',
      provider: 'codex',
      role: 'Builder',
      model: 'gpt-5.6-sol',
      order: 2
    })
  ]

  it('renders every seat as a tab and marks the selected one', () => {
    const html = renderToStaticMarkup(
      <EnsembleSeatNavigatorRail
        participants={participants}
        selectedParticipantId="builder"
        onSelectParticipant={() => undefined}
      />
    )

    expect(html).toContain('>Seats</span>')
    expect(html).toContain('aria-label="Configure Planner"')
    expect(html).toContain('aria-label="Configure Builder"')
    expect(html).toMatch(/data-participant-id="builder"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/data-participant-id="planner"[^>]*aria-pressed="false"/)
    expect(html).toContain('>GPT-5.6-Sol</span>')
  })

  it('keeps a disabled seat selectable — dimmed, never attribute-disabled', () => {
    const html = renderToStaticMarkup(
      <EnsembleSeatNavigatorRail
        participants={[makeParticipant({ id: 'benched', role: 'Benched', enabled: false })]}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
      />
    )

    expect(html).toContain('is-disabled-seat')
    expect(html).not.toContain('disabled=""')
  })

  it('selects the clicked seat and no-ops on the already-selected tab', () => {
    const onSelectParticipant = vi.fn()
    const [plannerChip, builderChip] = seatChipButtons(participants, 'builder', onSelectParticipant)

    expect(plannerChip.props['data-participant-id']).toBe('planner')
    plannerChip.props.onClick()
    expect(onSelectParticipant).toHaveBeenCalledTimes(1)
    expect(onSelectParticipant).toHaveBeenCalledWith('planner')

    builderChip.props.onClick()
    expect(onSelectParticipant).toHaveBeenCalledTimes(1)
  })

  it('scrolls horizontally and renders seat tabs without pill chrome', () => {
    const css = readFileSync(
      new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
      'utf8'
    )
    const listRule = css.match(/\.ensemble-seat-navigator-list\s*\{([^}]*)\}/)?.[1]
    const chipRule = css.match(/\.ensemble-seat-navigator-chip\s*\{([^}]*)\}/)?.[1]

    expect(listRule).toBeDefined()
    expect(listRule).toContain('overflow-x: auto;')
    expect(chipRule).toBeDefined()
    expect(chipRule).toContain('border: 0;')
    expect(chipRule).toContain('border-bottom: 1px solid transparent;')
    expect(chipRule).not.toContain('999px')
  })

  it('gives the ordinary picker popovers a full-width bottom row for the rail', () => {
    const css = readFileSync(
      new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
      'utf8'
    )

    // Permission popover (flex): the rail wraps below the column.
    expect(css).toContain(
      '.composer-combined-picker-popover.has-bottom-content:not(.is-ensemble-add-participant) {'
    )
    // Unified model popover (fixed height): the rail gets its own grid track.
    expect(css).toMatch(
      /is-unified-provider-picker\.has-bottom-content:not\(\s*\.is-ensemble-add-participant\s*\)\s*\{[^}]*grid-template-rows: minmax\(0, 1fr\) auto;/
    )
  })

  it('is mounted by BOTH composer pickers and drives the shared chip selection', () => {
    const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')

    expect(
      composerSource.match(/bottomContent=\{renderEnsembleSeatNavigatorRail\(\)\}/g)
    ).toHaveLength(2)
    // Scoped to the helper body: the two strings below also exist elsewhere in
    // Composer.tsx (the above-row chips), so a whole-file match proves nothing.
    const railHelper = composerSource.match(
      /const renderEnsembleSeatNavigatorRail[\s\S]*?\n {2}\}/
    )?.[0]
    expect(railHelper).toBeDefined()
    expect(railHelper).toContain('<EnsembleSeatNavigatorRail')
    expect(railHelper).toContain('onSelectParticipant={handleSelectParticipant}')
    expect(railHelper).toContain('seatParticipants.length < 2')
  })
})
