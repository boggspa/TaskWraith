import { describe, expect, it } from 'vitest'
import {
  isAuthorityTerminalStatus,
  isEnsembleParentBusy,
  resolveAuthoritySeat,
  shouldDrainEnsembleMailbox,
  type EnsembleMailboxRosterParticipant,
  type ShouldDrainEnsembleMailboxInput
} from './EnsembleSubThreadMailboxDelivery'

const boss: EnsembleMailboxRosterParticipant = {
  id: 'boss-id',
  provider: 'grok',
  role: 'Boss',
  enabled: true
}
const captain: EnsembleMailboxRosterParticipant = {
  id: 'captain-id',
  provider: 'claude',
  role: 'Captain',
  enabled: true
}
const worker: EnsembleMailboxRosterParticipant = {
  id: 'worker-id',
  provider: 'codex',
  role: 'Worker',
  enabled: true
}

const drainHappy: ShouldDrainEnsembleMailboxInput = {
  autoResumeSetting: true,
  parentChatExists: true,
  parentChatIsEnsemble: true,
  parentBusy: false,
  hasDeliverableEvents: true,
  authoritySeatResolvable: true,
  deliveryRuntimeReady: true
}

describe('isAuthorityTerminalStatus', () => {
  it('flags failed/unreachable/cancelled/skipped as terminal', () => {
    expect(isAuthorityTerminalStatus('failed')).toBe(true)
    expect(isAuthorityTerminalStatus('unreachable')).toBe(true)
    expect(isAuthorityTerminalStatus('cancelled')).toBe(true)
    expect(isAuthorityTerminalStatus('skipped')).toBe(true)
  })

  it('does not treat live or answered seats as terminal', () => {
    expect(isAuthorityTerminalStatus('idle')).toBe(false)
    expect(isAuthorityTerminalStatus('running')).toBe(false)
    expect(isAuthorityTerminalStatus('answered')).toBe(false)
    expect(isAuthorityTerminalStatus('yielded')).toBe(false)
    expect(isAuthorityTerminalStatus(undefined)).toBe(false)
  })
})

describe('isEnsembleParentBusy', () => {
  it('is busy when any parent run is active', () => {
    expect(
      isEnsembleParentBusy({
        parentChatHasActiveRun: true,
        ensembleRoundDispatchLive: false
      })
    ).toBe(true)
  })

  it('is busy when the ensemble round is still dispatch-live (Continuous mid-hop)', () => {
    expect(
      isEnsembleParentBusy({
        parentChatHasActiveRun: false,
        ensembleRoundDispatchLive: true
      })
    ).toBe(true)
  })

  it('is idle only when neither signal is set', () => {
    expect(
      isEnsembleParentBusy({
        parentChatHasActiveRun: false,
        ensembleRoundDispatchLive: false
      })
    ).toBe(false)
  })
})

describe('resolveAuthoritySeat', () => {
  it('prefers the assigned Boss when available', () => {
    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: boss.id,
        secondInCommandParticipantId: captain.id,
        participants: [boss, captain, worker]
      })
    ).toEqual({
      participantId: boss.id,
      role: 'boss',
      provider: 'grok',
      seatRoleLabel: 'Boss'
    })
  })

  it('falls through to Captain when Boss is disabled', () => {
    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: boss.id,
        secondInCommandParticipantId: captain.id,
        participants: [{ ...boss, enabled: false }, captain, worker]
      })
    ).toMatchObject({
      participantId: captain.id,
      role: 'second_in_command',
      provider: 'claude',
      bossUnavailableReason: 'Boss is disabled'
    })
  })

  it('falls through to Captain when Boss is missing from the roster', () => {
    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: 'stale-boss',
        secondInCommandParticipantId: captain.id,
        participants: [captain, worker]
      })
    ).toMatchObject({
      participantId: captain.id,
      role: 'second_in_command',
      bossUnavailableReason: 'no Boss is assigned'
    })
  })

  it('falls through when a live round marked Boss failed/unreachable', () => {
    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: boss.id,
        secondInCommandParticipantId: captain.id,
        participants: [boss, captain],
        roundLive: true,
        roundParticipantStates: [
          { participantId: boss.id, status: 'failed', lastFailureReason: 'provider crash' }
        ]
      })
    ).toMatchObject({
      participantId: captain.id,
      role: 'second_in_command',
      bossUnavailableReason: 'provider crash'
    })
  })

  it('falls through on soft quota unavailability', () => {
    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: boss.id,
        secondInCommandParticipantId: captain.id,
        participants: [boss, captain],
        bossSoftUnavailable: true
      })
    ).toMatchObject({
      participantId: captain.id,
      role: 'second_in_command',
      bossUnavailableReason: 'Boss hit a provider quota wall'
    })
  })

  it('does not treat historical terminal status as unavailable when the round is not live', () => {
    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: boss.id,
        secondInCommandParticipantId: captain.id,
        participants: [boss, captain],
        roundLive: false,
        roundParticipantStates: [{ participantId: boss.id, status: 'failed' }]
      })
    ).toMatchObject({ participantId: boss.id, role: 'boss' })
  })

  it('returns null when Boss is unavailable and Captain is missing/disabled', () => {
    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: boss.id,
        secondInCommandParticipantId: captain.id,
        participants: [{ ...boss, enabled: false }, { ...captain, enabled: false }]
      })
    ).toBeNull()

    expect(
      resolveAuthoritySeat({
        bossmanParticipantId: boss.id,
        participants: [{ ...boss, enabled: false }, worker]
      })
    ).toBeNull()
  })

  it('returns null when no authority ids are configured', () => {
    expect(
      resolveAuthoritySeat({
        participants: [worker]
      })
    ).toBeNull()
  })

  it('does not promote Captain while Boss is still available', () => {
    const seat = resolveAuthoritySeat({
      bossmanParticipantId: boss.id,
      secondInCommandParticipantId: captain.id,
      participants: [boss, captain]
    })
    expect(seat?.role).toBe('boss')
    expect(seat?.participantId).toBe(boss.id)
  })
})

describe('shouldDrainEnsembleMailbox', () => {
  it('returns true on the idle + join-ready + authority-ready happy path', () => {
    expect(shouldDrainEnsembleMailbox(drainHappy)).toBe(true)
  })

  it('retains when the parent is busy (active run or live Continuous hop)', () => {
    expect(shouldDrainEnsembleMailbox({ ...drainHappy, parentBusy: true })).toBe(false)
  })

  it('retains when no deliverable (join-ready) events exist', () => {
    expect(
      shouldDrainEnsembleMailbox({ ...drainHappy, hasDeliverableEvents: false })
    ).toBe(false)
  })

  it('retains when authority cannot be resolved', () => {
    expect(
      shouldDrainEnsembleMailbox({ ...drainHappy, authoritySeatResolvable: false })
    ).toBe(false)
  })

  it('retains when the delivery runtime is not ready', () => {
    expect(
      shouldDrainEnsembleMailbox({ ...drainHappy, deliveryRuntimeReady: false })
    ).toBe(false)
  })

  it('respects the auto-resume setting and missing parent', () => {
    expect(shouldDrainEnsembleMailbox({ ...drainHappy, autoResumeSetting: false })).toBe(false)
    expect(shouldDrainEnsembleMailbox({ ...drainHappy, parentChatExists: false })).toBe(false)
  })

  it('never drains a non-ensemble parent (solo path stays separate)', () => {
    expect(
      shouldDrainEnsembleMailbox({ ...drainHappy, parentChatIsEnsemble: false })
    ).toBe(false)
  })
})
