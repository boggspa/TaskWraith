import { describe, expect, it } from 'vitest'
import {
  ENSEMBLE_ROLE_PRESET_CUSTOM,
  ENSEMBLE_ROLE_PRESETS,
  resolveRolePresetId,
  roleLabelForPresetId
} from './ensembleRolePresets'

describe('ensembleRolePresets', () => {
  it('resolves known preset labels', () => {
    expect(resolveRolePresetId('Reviewer')).toBe('reviewer')
    expect(resolveRolePresetId('worker')).toBe('worker')
    expect(resolveRolePresetId('Designer')).toBe('designer')
  })

  it('falls back to custom for unknown roles', () => {
    expect(resolveRolePresetId('Codex Lead')).toBe(ENSEMBLE_ROLE_PRESET_CUSTOM)
    expect(resolveRolePresetId('')).toBe(ENSEMBLE_ROLE_PRESET_CUSTOM)
  })

  it('maps preset ids back to labels', () => {
    expect(roleLabelForPresetId('planner')).toBe('Planner')
    expect(roleLabelForPresetId(ENSEMBLE_ROLE_PRESET_CUSTOM)).toBeNull()
  })

  it('includes the expected starter presets', () => {
    const labels = ENSEMBLE_ROLE_PRESETS.map((preset) => preset.label)
    expect(labels).toContain('Explorer')
    expect(labels).toContain('Designer')
    expect(labels).toContain('Worker')
    expect(labels).toContain('Reviewer')
  })
})
