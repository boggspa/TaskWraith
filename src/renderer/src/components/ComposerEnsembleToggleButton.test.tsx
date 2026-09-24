import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  buildEnsembleParticipantAddMutation,
  buildEnsembleParticipantRemoveMutation,
  type EnsembleParticipantAddDraft
} from './EnsembleParticipantsAboveRow'

const source = readFileSync(new URL('./ComposerEnsembleToggleButton.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const css = readFileSync(
  new URL('../assets/css/39-ensemble-roster-popover.css', import.meta.url),
  'utf8'
)

const participants: EnsembleParticipant[] = [
  {
    id: 'builder',
    provider: 'codex',
    enabled: true,
    role: 'Builder',
    instructions: 'Build it.',
    order: 1,
    model: 'gpt-5.6-sol'
  },
  {
    id: 'reviewer',
    provider: 'claude',
    enabled: true,
    role: 'Reviewer',
    instructions: 'Review it.',
    order: 2,
    model: 'claude-fable-5'
  }
]

describe('ComposerEnsembleToggleButton participant manager', () => {
  it('dispatches a changed On/Off selection after closing its popover', () => {
    const selectionStart = source.indexOf('const selectMode = (nextEnabled: boolean): void => {')
    const selectionEnd = source.indexOf('\n  const modeToggleTitle', selectionStart)
    const selection = source.slice(selectionStart, selectionEnd)

    expect(selectionStart).toBeGreaterThan(-1)
    expect(selection).toContain('if (modeToggleDisabled) return')
    expect(selection.indexOf('setOpen(false)')).toBeLessThan(
      selection.indexOf('if (nextEnabled !== enabled) onToggle(nextEnabled)')
    )
  })

  it('does not treat an active collaboration as a veto on collapsing to solo', () => {
    const collapseStart = appSource.indexOf('const handleCollapseEnsembleToSoloForChat = async (')
    const collapseEnd = appSource.indexOf(
      '\n  const handleCollapseEnsembleToSolo = async (',
      collapseStart
    )
    const collapse = appSource.slice(collapseStart, collapseEnd)

    expect(collapseStart).toBeGreaterThan(-1)
    expect(collapseEnd).toBeGreaterThan(collapseStart)
    expect(collapse).not.toContain('collaboratingChatIds')
    expect(collapse).not.toContain('Stop sharing before switching')
    expect(collapse).toContain("targetKind: 'single'")
  })

  it('keeps the popover trigger enabled while locking only On/Off mode changes', () => {
    const modeControlStart = source.indexOf('const segmentedModeControl = (')
    const modeControlEnd = source.indexOf('\n\n  const popover =', modeControlStart)
    const modeControl = source.slice(modeControlStart, modeControlEnd)
    const triggerStart = source.indexOf('className={`composer-ensemble-toggle-button')
    const triggerEnd = source.indexOf('</button>', triggerStart)
    const trigger = source.slice(triggerStart, triggerEnd)

    expect(modeControlStart).toBeGreaterThan(-1)
    expect(modeControl.match(/\n\s+disabled=\{modeToggleDisabled\}/g)).toHaveLength(2)
    expect(modeControl).toContain('aria-disabled={modeToggleDisabled}')
    expect(modeControl).toContain('title={modeToggleTitle}')
    expect(source).toContain('if (modeToggleDisabled) return')
    expect(triggerStart).toBeGreaterThan(-1)
    expect(trigger).not.toContain('disabled=')
    expect(trigger).toContain('aria-haspopup="dialog"')
  })

  it('builds an add mutation immediately after the selected participant', () => {
    const draft: EnsembleParticipantAddDraft = {
      provider: 'kimi',
      model: 'kimi-k3',
      enabled: true,
      authority: 'agent',
      autoApprovalsEnabled: false,
      role: 'Researcher',
      instructions: 'Research the request.'
    }

    const result = buildEnsembleParticipantAddMutation(participants, 'builder', draft)

    expect(result.mutation).toMatchObject({
      action: 'add',
      authority: 'agent',
      autoApprovalsEnabled: false,
      participant: {
        id: result.participantId,
        provider: 'kimi',
        model: 'kimi-k3',
        role: 'Researcher',
        order: 2
      }
    })
  })

  it('builds a selected-seat removal and moves selection to its predecessor', () => {
    expect(buildEnsembleParticipantRemoveMutation(participants, 'reviewer')).toEqual({
      mutation: { action: 'remove', participantId: 'reviewer' },
      nextSelection: 'builder'
    })
    expect(buildEnsembleParticipantRemoveMutation(participants, 'missing')).toBeNull()
  })

  it('places one add/remove manager on the same mode row as On/Off', () => {
    const rowStart = source.indexOf('className="composer-ensemble-toggle-mode-row"')
    const managerStart = source.indexOf('<EnsembleAddParticipantButton', rowStart)
    const segmentedStart = source.indexOf('{segmentedModeControl}', managerStart)

    expect(rowStart).toBeGreaterThan(-1)
    expect(managerStart).toBeGreaterThan(rowStart)
    expect(segmentedStart).toBeGreaterThan(managerStart)
    expect(source).toContain("content: 'Add / remove participant'")
    expect(source).toContain('className="composer-ensemble-participant-remove-action"')
    expect(source).toContain('popoverClassName="is-ensemble-roster-nested-picker"')
    expect(css).toContain('.composer-ensemble-toggle-mode-row {')
    expect(css).toContain('.composer-ensemble-participant-manager-trigger {')
  })
})
