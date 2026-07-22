import { describe, expect, it } from 'vitest'
import {
  buildEnsembleYieldToolResult,
  ENSEMBLE_YIELD_NO_ACTIVE_RUN_MESSAGE
} from './EnsembleYieldToolResult'

describe('buildEnsembleYieldToolResult', () => {
  it('surfaces a message and error when ensemble_yield cannot resolve an active run', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: { kind: 'no_active_run' },
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

  it('reports successful authority routing with action metadata', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: {
          kind: 'yielded',
          routing: {
            ok: true,
            action: 'promoted',
            targetParticipantId: 'ensemble-codex'
          }
        },
        reason: 'Gate complete.',
        target: 'Worker'
      })
    ).toEqual({
      ok: true,
      tool: 'ensemble_yield',
      reason: 'Gate complete.',
      target: 'Worker',
      action: 'promoted',
      targetParticipantId: 'ensemble-codex'
    })
  })

  it('marks unresolved authority yields as tool errors', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: {
          kind: 'yielded',
          routing: {
            ok: false,
            reason: 'unresolved',
            target: 'NonExistentProvider'
          }
        },
        target: 'NonExistentProvider'
      })
    ).toMatchObject({
      ok: false,
      error: 'unresolved',
      target: 'NonExistentProvider'
    })
  })

  it('keeps targetless yields concise', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: { kind: 'yielded' },
        reason: 'Gate complete.'
      })
    ).toEqual({
      ok: true,
      tool: 'ensemble_yield',
      reason: 'Gate complete.'
    })
  })

  it('surfaces hop_limit rejections from planned re-summon yields', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: {
          kind: 'yielded',
          routing: { ok: false, reason: 'hop_limit', target: 'Worker' }
        },
        target: 'Worker'
      })
    ).toMatchObject({
      ok: false,
      error: 'hop_limit',
      target: 'Worker'
    })
  })

  it('reports non-authority yield-to-user as success', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: {
          kind: 'yielded',
          routing: { ok: true, action: 'user' }
        },
        reason: 'Need the user.',
        target: 'user'
      })
    ).toMatchObject({
      ok: true,
      action: 'user',
      target: 'user'
    })
  })
})
