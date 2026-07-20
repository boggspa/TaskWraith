import fs from 'fs'
import { describe, expect, it } from 'vitest'
import {
  isEnsembleParentBusy,
  resolveAuthoritySeat,
  shouldDrainEnsembleMailbox
} from './EnsembleSubThreadMailboxDelivery'
import { shouldAutoResumeParent } from './AutoResumeParent'

const indexSource = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('EnsembleSubThreadReturnIntegration — source wiring', () => {
  it('routes ensemble parents to the authority-seat drain before the solo gate', () => {
    const drain = sourceBetween(
      'async function maybeDrainParentSubThreadMailbox(parentChatId: string): Promise<void> {',
      'async function dispatchParentRunWithPendingSubThreadMailbox('
    )
    // Ensemble branch must short-circuit before shouldAutoResumeParent.
    const ensembleBranch = drain.indexOf("parent.chatKind === 'ensemble'")
    const soloGate = drain.indexOf('shouldAutoResumeParent({')
    const ensembleDrainCall = drain.indexOf('maybeDrainEnsembleSubThreadMailbox(parentChatId)')

    expect(ensembleBranch).toBeGreaterThanOrEqual(0)
    expect(ensembleDrainCall).toBeGreaterThan(ensembleBranch)
    expect(soloGate).toBeGreaterThan(ensembleDrainCall)
    expect(drain).toContain(
      'Do not flip\n  // shouldAutoResumeParent\'s ensemble block'
    )
  })

  it('implements idle-gated authority delivery with directed startRound + claim/ack', () => {
    const ensembleDrain = sourceBetween(
      'async function maybeDrainEnsembleSubThreadMailbox(parentChatId: string): Promise<void> {',
      'async function maybeDrainParentSubThreadMailbox(parentChatId: string): Promise<void> {'
    )

    expect(ensembleDrain).toContain('shouldDrainEnsembleMailbox({')
    expect(ensembleDrain).toContain('isEnsembleParentBusy({')
    expect(ensembleDrain).toContain('resolveAuthoritySeat({')
    expect(ensembleDrain).toContain('createSubThreadMailboxDeliveryRunId(')
    expect(ensembleDrain).toContain('AppStore.claimSubThreadMailboxEvents(')
    expect(ensembleDrain).toContain('buildSubThreadMailboxContinuationPrompt(claimed.events)')
    expect(ensembleDrain).toContain('ensembleOrchestratorRef.startRound({')
    expect(ensembleDrain).toContain('dmTargetParticipantId: authority.participantId')
    expect(ensembleDrain).toContain("fanoutPolicy: 'off'")
    expect(ensembleDrain).toContain("startResult.status !== 'started'")
    expect(ensembleDrain).toContain('AppStore.acknowledgeSubThreadMailboxDelivery(')
    expect(ensembleDrain).toContain('AppStore.releaseSubThreadMailboxDelivery(')
    // Retain-on-busy: release claim if parent races busy after claim.
    expect(ensembleDrain).toContain('Ensemble parent became busy before authority-seat mailbox delivery.')
    // Delivery is under the hood (no synthetic transcript prompt card).
    expect(ensembleDrain).not.toContain('autoresume-prompt-')
    expect(ensembleDrain).toContain("ensembleDelivery: true")
  })

  it('keeps ordinary parent attach and solo auto-resume ensemble-blocked', () => {
    const attachment = sourceBetween(
      'async function dispatchParentRunWithPendingSubThreadMailbox(',
      '/**\n * Surface a sub-thread-dispatch failure'
    )
    expect(attachment).toContain("parent.chatKind === 'ensemble'")
    expect(attachment).toContain('return dispatch(payload, event)')

    // Solo gate must still refuse ensembles (never flip parentChatIsEnsemble false).
    expect(shouldAutoResumeParent({
      setting: true,
      returnResultToParent: true,
      parentChatExists: true,
      parentChatIsRunning: false,
      parentChatHasProvider: true,
      parentChatIsEnsemble: true
    })).toBe(false)
  })

  it('propagates failed/cancelled terminal evidence through the shared produce+drain path', () => {
    const producer = sourceBetween(
      'async function maybePropagateSubThreadResult(',
      'const SUBTHREAD_MAILBOX_DELIVERY_BATCH_LIMIT'
    )
    expect(producer).toContain("outcome: 'done' | 'requires_action' | 'failed' | 'cancelled'")
    expect(producer).toContain("terminal.outcome === 'failed'")
    expect(producer).toContain("terminal.outcome === 'cancelled'")
    expect(producer).toContain('outcome: terminal.outcome')
    expect(producer).toContain('await maybeDrainParentSubThreadMailbox(')
    // Projection stays projection-only until a separate delivery ack.
    expect(producer).toContain("providerContextVisibility: 'projection-only'")
  })
})

describe('EnsembleSubThreadReturnIntegration — acceptance pure matrix', () => {
  const roster = [
    { id: 'boss', provider: 'grok', role: 'Boss', enabled: true },
    { id: 'captain', provider: 'claude', role: 'Captain', enabled: true },
    { id: 'worker', provider: 'codex', role: 'Worker', enabled: true }
  ]

  it('A1 idle deliver: join-ready + idle + authority resolvable → drain true', () => {
    const seat = resolveAuthoritySeat({
      bossmanParticipantId: 'boss',
      secondInCommandParticipantId: 'captain',
      participants: roster
    })
    expect(seat?.participantId).toBe('boss')
    expect(
      shouldDrainEnsembleMailbox({
        autoResumeSetting: true,
        parentChatExists: true,
        parentChatIsEnsemble: true,
        parentBusy: isEnsembleParentBusy({
          parentChatHasActiveRun: false,
          ensembleRoundDispatchLive: false
        }),
        hasDeliverableEvents: true,
        authoritySeatResolvable: Boolean(seat),
        deliveryRuntimeReady: true
      })
    ).toBe(true)
  })

  it('A2 busy retain: active run or live Continuous hop → drain false', () => {
    expect(
      shouldDrainEnsembleMailbox({
        autoResumeSetting: true,
        parentChatExists: true,
        parentChatIsEnsemble: true,
        parentBusy: isEnsembleParentBusy({
          parentChatHasActiveRun: true,
          ensembleRoundDispatchLive: false
        }),
        hasDeliverableEvents: true,
        authoritySeatResolvable: true,
        deliveryRuntimeReady: true
      })
    ).toBe(false)

    expect(
      shouldDrainEnsembleMailbox({
        autoResumeSetting: true,
        parentChatExists: true,
        parentChatIsEnsemble: true,
        parentBusy: isEnsembleParentBusy({
          parentChatHasActiveRun: false,
          ensembleRoundDispatchLive: true
        }),
        hasDeliverableEvents: true,
        authoritySeatResolvable: true,
        deliveryRuntimeReady: true
      })
    ).toBe(false)
  })

  it('A3 solo path unchanged: ensemble gate refuses non-ensemble; solo gate refuses ensemble', () => {
    expect(
      shouldDrainEnsembleMailbox({
        autoResumeSetting: true,
        parentChatExists: true,
        parentChatIsEnsemble: false,
        parentBusy: false,
        hasDeliverableEvents: true,
        authoritySeatResolvable: true,
        deliveryRuntimeReady: true
      })
    ).toBe(false)

    expect(
      shouldAutoResumeParent({
        setting: true,
        returnResultToParent: true,
        parentChatExists: true,
        parentChatIsRunning: false,
        parentChatHasProvider: true,
        parentChatIsEnsemble: false
      })
    ).toBe(true)
  })

  it('Captain covers when Boss is soft-unavailable (quota wall)', () => {
    const seat = resolveAuthoritySeat({
      bossmanParticipantId: 'boss',
      secondInCommandParticipantId: 'captain',
      participants: roster,
      bossSoftUnavailable: true
    })
    expect(seat).toMatchObject({
      participantId: 'captain',
      role: 'second_in_command'
    })
  })
})
