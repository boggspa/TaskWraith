import { describe, expect, it } from 'vitest'
import {
  buildEnsembleYieldToolResult,
  ENSEMBLE_YIELD_ALREADY_SETTLED_MESSAGE,
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

  it('acknowledges a late yield from a run that already settled', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: { kind: 'already_settled' },
        reason: 'Handoff already recorded.'
      })
    ).toEqual({
      ok: true,
      tool: 'ensemble_yield',
      reason: 'Handoff already recorded.',
      message: ENSEMBLE_YIELD_ALREADY_SETTLED_MESSAGE
    })
  })

  it('acknowledges an active-fan-out authority hold without failing or settling the provider', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: {
          kind: 'fanout_handoff_held',
          message:
            'Fan-out handoff held: the current Boss/Captain remains responsible until the wave settles.',
          activeLaneCount: 3,
          eligibleManagerParticipantIds: ['captain'],
          suggestedAliases: ['Captain', 'Kimi K3']
        },
        reason: 'Let the reviewer take over.',
        target: 'Reviewer'
      })
    ).toEqual({
      ok: true,
      tool: 'ensemble_yield',
      reason: 'Let the reviewer take over.',
      target: 'Reviewer',
      action: 'held_for_active_fanout',
      message:
        'Fan-out handoff held: the current Boss/Captain remains responsible until the wave settles.',
      activeLaneCount: 3,
      eligibleManagerParticipantIds: ['captain'],
      suggestedAliases: ['Captain', 'Kimi K3']
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

  it('keeps a later-pass authority active until it makes an explicit routing decision', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: {
          kind: 'authority_routing_decision_required',
          pass: 3,
          requirement: 'later_pass_selection'
        },
        reason: 'No routing change.'
      })
    ).toMatchObject({
      ok: false,
      error: 'authority_routing_decision_required',
      message: expect.stringContaining('Continuous pass 3')
    })
  })

  it('asks tagged authority call-ins to target a participant or explicitly opt out', () => {
    expect(
      buildEnsembleYieldToolResult({
        outcome: {
          kind: 'authority_routing_decision_required',
          pass: 1,
          requirement: 'tagged_intervention'
        }
      })
    ).toMatchObject({
      ok: false,
      error: 'authority_routing_decision_required',
      message: expect.stringContaining('skip_intervention')
    })
  })
})
