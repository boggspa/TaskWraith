import { describe, expect, it } from 'vitest'
import type { EnsembleConfig } from '../../../main/store/types'
import {
  buildEnsembleRosterPresetFromConfig,
  type EnsembleRosterPreset
} from '../lib/ensembleRosterPresets'
import {
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
})
