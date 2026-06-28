import { describe, expect, it } from 'vitest'
import type { EnsembleRosterPreset } from '../lib/ensembleRosterPresets'
import { rosterPresetApplyConfirmationMessage } from './EnsembleRosterPresetPicker'

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

describe('EnsembleRosterPresetPicker', () => {
  it('warns that applying a preset replaces unsaved roster edits', () => {
    const message = rosterPresetApplyConfirmationMessage(preset(3))

    expect(message).toContain('replaces the current ensemble roster')
    expect(message).toContain('"Visual UI Architect"')
    expect(message).toContain('3 participants')
    expect(message).toContain('Unsaved participant edits')
  })

  it('uses the singular participant label in the confirmation copy', () => {
    expect(rosterPresetApplyConfirmationMessage(preset(1))).toContain('1 participant')
  })
})
