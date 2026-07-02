import { describe, expect, it } from 'vitest'
import {
  buildEnsembleYieldToolResult,
  ENSEMBLE_YIELD_NO_ACTIVE_RUN_MESSAGE
} from './EnsembleYieldToolResult'

describe('buildEnsembleYieldToolResult', () => {
  it('surfaces a message and error when ensemble_yield cannot resolve an active run', () => {
    expect(
      buildEnsembleYieldToolResult({
        yielded: false,
        reason: 'Needs repair.',
        target: 'Fixman'
      })
    ).toEqual({
      ok: false,
      tool: 'ensemble_yield',
      reason: 'Needs repair.',
      target: 'Fixman',
      message: ENSEMBLE_YIELD_NO_ACTIVE_RUN_MESSAGE,
      error: 'no_active_run'
    })
  })

  it('keeps successful ensemble_yield payloads concise', () => {
    expect(
      buildEnsembleYieldToolResult({
        yielded: true,
        reason: 'Gate complete.',
        target: 'Bossman'
      })
    ).toEqual({
      ok: true,
      tool: 'ensemble_yield',
      reason: 'Gate complete.',
      target: 'Bossman'
    })
  })
})
