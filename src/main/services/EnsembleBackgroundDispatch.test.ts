import { describe, expect, it } from 'vitest'
import {
  backgroundDispatchFailureStatusLine,
  isBackgroundDispatchFailure,
  preflightBackgroundDispatchTarget
} from './EnsembleBackgroundDispatch'
import type { EnsembleParticipant } from '../store/types'

const bgParticipant: EnsembleParticipant = {
  id: 'background-shell',
  provider: 'codex',
  enabled: true,
  role: 'Shell helper',
  instructions: 'Run checks.',
  order: 2,
  permissionPresetId: 'read_only',
  stageRole: 'background'
}

describe('preflightBackgroundDispatchTarget', () => {
  it('passes when admission preconditions are satisfied', () => {
    expect(
      preflightBackgroundDispatchTarget({
        concurrentLanesEnabled: true,
        runtimeCancelled: false,
        targetParticipant: bgParticipant,
        fanoutDispatchState: null,
        budgetBlockReason: null
      })
    ).toEqual({ ok: true })
  })

  it('rejects when parallel lanes are disabled', () => {
    const result = preflightBackgroundDispatchTarget({
      concurrentLanesEnabled: false,
      runtimeCancelled: false,
      targetParticipant: bgParticipant,
      fanoutDispatchState: null,
      budgetBlockReason: null
    })
    expect(result).toEqual({ ok: false, reason: 'concurrent_lanes_disabled' })
    expect(isBackgroundDispatchFailure(result)).toBe(true)
  })

  it('rejects when the BG seat already has an active lane', () => {
    expect(
      preflightBackgroundDispatchTarget({
        concurrentLanesEnabled: true,
        runtimeCancelled: false,
        targetParticipant: bgParticipant,
        fanoutDispatchState: 'active',
        budgetBlockReason: null
      })
    ).toEqual({ ok: false, reason: 'already_active' })
  })

  it('rejects when fan-out budget is exhausted', () => {
    expect(
      preflightBackgroundDispatchTarget({
        concurrentLanesEnabled: true,
        runtimeCancelled: false,
        targetParticipant: bgParticipant,
        fanoutDispatchState: null,
        budgetBlockReason: 'fan-out budget exhausted (1/1)'
      })
    ).toEqual({
      ok: false,
      reason: 'budget_blocked',
      detail: 'fan-out budget exhausted (1/1)'
    })
  })

  it('rejects missing or disabled targets', () => {
    expect(
      preflightBackgroundDispatchTarget({
        concurrentLanesEnabled: true,
        runtimeCancelled: false,
        targetParticipant: undefined,
        fanoutDispatchState: null,
        budgetBlockReason: null
      })
    ).toEqual({ ok: false, reason: 'target_missing' })
    expect(
      preflightBackgroundDispatchTarget({
        concurrentLanesEnabled: true,
        runtimeCancelled: false,
        targetParticipant: { ...bgParticipant, enabled: false },
        fanoutDispatchState: null,
        budgetBlockReason: null
      })
    ).toEqual({ ok: false, reason: 'target_missing' })
  })

  it('rejects when the round runtime is cancelled', () => {
    expect(
      preflightBackgroundDispatchTarget({
        concurrentLanesEnabled: true,
        runtimeCancelled: true,
        targetParticipant: bgParticipant,
        fanoutDispatchState: null,
        budgetBlockReason: null
      })
    ).toEqual({ ok: false, reason: 'cancelled' })
  })
})

describe('backgroundDispatchFailureStatusLine', () => {
  it('includes optional display name and detail', () => {
    expect(
      backgroundDispatchFailureStatusLine(
        { ok: false, reason: 'budget_blocked', detail: 'fan-out budget exhausted (1/1)' },
        'CodexBG'
      )
    ).toBe(
      'Background dispatch not launched for CodexBG: budget_blocked (fan-out budget exhausted (1/1)).'
    )
  })
})
