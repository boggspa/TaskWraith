import { describe, expect, it } from 'vitest'
import {
  ENSEMBLE_STAGE_ROLE_OPTIONS,
  normalizeEnsembleStageRole
} from './ensembleStageRoles'

describe('ensembleStageRoles', () => {
  it('offers the four orchestrator stages', () => {
    expect(ENSEMBLE_STAGE_ROLE_OPTIONS.map((option) => option.id)).toEqual([
      'scout',
      'worker',
      'reviewer',
      'background'
    ])
  })

  it('normalizes picker values: valid stages pass, everything else clears', () => {
    expect(normalizeEnsembleStageRole('scout')).toBe('scout')
    expect(normalizeEnsembleStageRole('worker')).toBe('worker')
    expect(normalizeEnsembleStageRole('reviewer')).toBe('reviewer')
    expect(normalizeEnsembleStageRole('background')).toBe('background')
    // The "Any (by permissions)" option and junk both clear the stage.
    expect(normalizeEnsembleStageRole('')).toBeUndefined()
    expect(normalizeEnsembleStageRole('boss')).toBeUndefined()
    expect(normalizeEnsembleStageRole(undefined)).toBeUndefined()
    expect(normalizeEnsembleStageRole(null)).toBeUndefined()
  })
})
