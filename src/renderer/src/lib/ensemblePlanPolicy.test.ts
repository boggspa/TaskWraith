import { describe, expect, it } from 'vitest'
import { resolveEnsemblePlanOwner, shouldSurfaceProposedPlanCard } from './ensemblePlanPolicy'

describe('resolveEnsemblePlanOwner', () => {
  it('uses the Boss participant as the plan owner for ensemble chats', () => {
    expect(
      resolveEnsemblePlanOwner({
        chatKind: 'ensemble',
        bossmanParticipantId: ' boss ',
        fallbackOwnerParticipantId: 'last-speaker'
      })
    ).toBe('boss')
  })

  it('falls back to the chosen final speaker when no Boss is configured', () => {
    expect(
      resolveEnsemblePlanOwner({
        chatKind: 'ensemble',
        fallbackOwnerParticipantId: 'last-speaker'
      })
    ).toBe('last-speaker')
  })

  it('does not pick a plan owner for non-ensemble chats', () => {
    expect(
      resolveEnsemblePlanOwner({
        chatKind: 'single',
        bossmanParticipantId: 'boss',
        fallbackOwnerParticipantId: 'last-speaker'
      })
    ).toBeNull()
  })
})

describe('shouldSurfaceProposedPlanCard', () => {
  it('allows solo plan cards in plan mode', () => {
    expect(
      shouldSurfaceProposedPlanCard({
        chatKind: 'single',
        isPlanMode: true
      })
    ).toBe(true)
  })

  it('allows explicit solo proposed-plan blocks outside plan mode', () => {
    expect(
      shouldSurfaceProposedPlanCard({
        chatKind: 'single',
        hasExplicitProposedPlanBlock: true
      })
    ).toBe(true)
  })

  it('surfaces an ensemble plan only for the resolved owner', () => {
    expect(
      shouldSurfaceProposedPlanCard({
        chatKind: 'ensemble',
        isPlanMode: true,
        bossmanParticipantId: 'boss',
        messageParticipantId: 'boss'
      })
    ).toBe(true)
    expect(
      shouldSurfaceProposedPlanCard({
        chatKind: 'ensemble',
        isPlanMode: true,
        bossmanParticipantId: 'boss',
        messageParticipantId: 'worker'
      })
    ).toBe(false)
  })

  it('uses the fallback owner for ensemble chats without a Boss', () => {
    expect(
      shouldSurfaceProposedPlanCard({
        chatKind: 'ensemble',
        hasExplicitProposedPlanBlock: true,
        fallbackOwnerParticipantId: 'final-speaker',
        messageParticipantId: 'final-speaker'
      })
    ).toBe(true)
  })

  it('suppresses ensemble plan cards when no deterministic owner exists', () => {
    expect(
      shouldSurfaceProposedPlanCard({
        chatKind: 'ensemble',
        isPlanMode: true,
        messageParticipantId: 'participant'
      })
    ).toBe(false)
  })

  it('does not surface plan cards when there is no plan signal', () => {
    expect(
      shouldSurfaceProposedPlanCard({
        chatKind: 'single'
      })
    ).toBe(false)
  })
})
