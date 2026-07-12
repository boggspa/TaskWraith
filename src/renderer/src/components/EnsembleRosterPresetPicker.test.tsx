import { describe, expect, it } from 'vitest'
import type { EnsembleConfig } from '../../../main/store/types'
import {
  buildEnsembleRosterPresetFromConfig,
  type EnsembleRosterPreset
} from '../lib/ensembleRosterPresets'
import {
  defaultRosterOverwritePreset,
  rosterPresetSelectionForEnsemble,
  rosterPresetMenuMeta,
  rosterPresetTriggerLabel,
  savedRosterPresetForEnsemble
} from './EnsembleRosterPresetPicker'

function preset(participantCount: number): EnsembleRosterPreset {
  return {
    id: 'preset-1',
    name: 'Visual UI Architect',
    createdAt: 1,
    updatedAt: 1,
    orchestrationMode: 'turn_bound',
    maxParticipants: 6,
    participants: Array.from({ length: participantCount }, (_, index) => ({
      provider: index % 2 === 0 ? 'claude' : 'codex',
      enabled: true,
      role: `Participant ${index + 1}`,
      instructions: '',
      order: index + 1
    }))
  }
}

function ensemble(): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 6,
    orchestrationMode: 'turn_bound',
    participants: [
      {
        id: 'participant-1',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan carefully.',
        order: 1,
        model: 'claude-sonnet-4-6',
        linkedProviderSessionId: null
      },
      {
        id: 'participant-2',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Implement the plan.',
        order: 2,
        model: 'gpt-5.5-codex',
        linkedProviderSessionId: null
      }
    ]
  }
}

describe('EnsembleRosterPresetPicker', () => {
  it('summarizes saved roster contents for the picker menu', () => {
    const message = rosterPresetMenuMeta(preset(3))

    expect(message).toContain('3 participants')
    expect(message).toContain('Turn')
  })

  it('uses the singular participant label in the picker menu', () => {
    expect(rosterPresetMenuMeta(preset(1))).toContain('1 participant')
  })

  it('falls back to the generic trigger label for an unsaved roster', () => {
    expect(rosterPresetTriggerLabel(null)).toBe('Roster Presets')
    expect(rosterPresetTriggerLabel('')).toBe('Roster Presets')
  })

  it('truncates saved roster names after fifteen characters', () => {
    expect(rosterPresetTriggerLabel('123456789012345')).toBe('123456789012345')
    expect(rosterPresetTriggerLabel('1234567890123456')).toBe('123456789012345…')
  })

  it('finds the saved roster matching the current ensemble', () => {
    const current = ensemble()
    const saved = buildEnsembleRosterPresetFromConfig('Visual UI Architect', current, 1)

    expect(savedRosterPresetForEnsemble(current, [saved])?.name).toBe('Visual UI Architect')
    expect(
      savedRosterPresetForEnsemble(
        {
          ...current,
          participants: current.participants.map((participant, index) =>
            index === 0 ? { ...participant, role: 'Changed' } : participant
          )
        },
        [saved]
      )
    ).toBeNull()
  })

  it('does not guess an overwrite target for an unassociated drifted roster', () => {
    const current = ensemble()
    const saved = buildEnsembleRosterPresetFromConfig('Visual UI Architect', current, 1)
    const other = { ...preset(1), id: 'preset-2', name: 'Most recent', updatedAt: 2 }
    const drifted = {
      ...current,
      participants: current.participants.map((participant, index) =>
        index === 0 ? { ...participant, instructions: 'Different live goal.' } : participant
      )
    }

    expect(defaultRosterOverwritePreset(drifted, [other, saved])).toBeNull()
    expect(defaultRosterOverwritePreset(current, [other, saved])?.id).toBe(saved.id)
  })

  it('retains a loaded preset as the deterministic Save target after roster edits', () => {
    const current = ensemble()
    const saved = buildEnsembleRosterPresetFromConfig('Visual UI Architect', current, 1)
    const associated = { ...current, activeRosterPresetId: saved.id }
    const cleanSelection = rosterPresetSelectionForEnsemble(associated, [saved])
    const drifted = {
      ...associated,
      participants: associated.participants.map((participant, index) =>
        index === 0 ? { ...participant, instructions: 'A revised live goal.' } : participant
      )
    }
    const dirtySelection = rosterPresetSelectionForEnsemble(drifted, [saved])

    expect(cleanSelection).toEqual({ preset: saved, hasUnsavedChanges: false })
    expect(dirtySelection).toEqual({ preset: saved, hasUnsavedChanges: true })
    expect(defaultRosterOverwritePreset(drifted, [saved])?.id).toBe(saved.id)
  })

  it('keeps explicit loaded identity even when drift matches another saved preset', () => {
    const firstConfig = ensemble()
    const first = buildEnsembleRosterPresetFromConfig('First', firstConfig, 1)
    const secondConfig = {
      ...firstConfig,
      participants: firstConfig.participants.map((participant, index) =>
        index === 0 ? { ...participant, role: 'Changed' } : participant
      )
    }
    const second = buildEnsembleRosterPresetFromConfig('Second', secondConfig, 2)
    const live = { ...secondConfig, activeRosterPresetId: first.id }

    expect(rosterPresetSelectionForEnsemble(live, [second, first])).toEqual({
      preset: first,
      hasUnsavedChanges: true
    })
  })
})
