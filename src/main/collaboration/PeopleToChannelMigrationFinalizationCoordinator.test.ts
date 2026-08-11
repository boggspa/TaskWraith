import { describe, expect, it } from 'vitest'

import { PeopleToChannelMigrationLegacyWriteGate } from './PeopleToChannelMigrationLegacyWriteGate'
import type { PeopleToChannelMigrationExecution } from './PeopleToChannelMigrationExecutionStore'
import type { PeopleToChannelMigrationFinalizationExecution } from './PeopleToChannelMigrationFinalizationExecutionStore'
import type { PeopleToChannelMigrationRecoveryRecord } from './PeopleToChannelMigrationRecoveryStore'
import {
  PeopleToChannelMigrationFinalizationCoordinator,
  PeopleToChannelMigrationFinalizationCoordinatorError
} from './PeopleToChannelMigrationFinalizationCoordinator'

const PLAN_ID = 'a'.repeat(64)
const PLAN_DIGEST = 'b'.repeat(64)
const SOURCE_DIGEST = 'c'.repeat(64)
const CHANNEL_STATE_DIGEST = 'd'.repeat(64)
const CUTOVER_STATE_DIGEST = 'e'.repeat(64)
const FINALIZATION_DIGEST = 'f'.repeat(64)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function initialExecution(): PeopleToChannelMigrationExecution {
  return {
    planDigest: PLAN_DIGEST,
    plan: { planId: PLAN_ID, sourceDigest: SOURCE_DIGEST },
    base: { policies: [], pendingAdmissionReissues: [] }
  } as unknown as PeopleToChannelMigrationExecution
}

function finalization(
  overrides: Partial<PeopleToChannelMigrationFinalizationExecution> = {}
): PeopleToChannelMigrationFinalizationExecution {
  return {
    initialPlanId: PLAN_ID,
    initialPlanDigest: PLAN_DIGEST,
    channelStateDigest: CHANNEL_STATE_DIGEST,
    cutoverStateDigest: CUTOVER_STATE_DIGEST,
    scope: {
      schemaVersion: 1,
      retireShareIds: ['ordinary_one', 'ordinary_two'],
      retainedWorkspaceBootstrapShareIds: ['p5_bootstrap']
    },
    delta: {
      base: { policies: [], pendingAdmissionReissues: [] },
      history: { metadataMutations: [] }
    } as unknown as PeopleToChannelMigrationExecution,
    finalizationDigest: FINALIZATION_DIGEST,
    ...overrides
  } as PeopleToChannelMigrationFinalizationExecution
}

function recovery(
  phase: 'cutover_applied' | 'finalizing' | 'committed' = 'cutover_applied'
): PeopleToChannelMigrationRecoveryRecord {
  return {
    planId: PLAN_ID,
    planDigest: PLAN_DIGEST,
    sourceDigest: SOURCE_DIGEST,
    channelStateDigest: CHANNEL_STATE_DIGEST,
    cutoverStateDigest: CUTOVER_STATE_DIGEST,
    phase,
    ...(phase === 'cutover_applied' ? {} : { finalizationDigest: FINALIZATION_DIGEST })
  } as PeopleToChannelMigrationRecoveryRecord
}

function harness(
  args: {
    recoveryPhase?: 'cutover_applied' | 'finalizing' | 'committed'
    execution?: PeopleToChannelMigrationFinalizationExecution
    shareIds?: string[]
    crashAt?: string
  } = {}
) {
  let currentRecovery = recovery(args.recoveryPhase)
  let storedExecution =
    args.recoveryPhase === 'cutover_applied' ? null : (args.execution ?? finalization())
  let shareIds = [...(args.shareIds ?? ['ordinary_one', 'ordinary_two', 'p5_bootstrap'])]
  const calls: string[] = []
  const gate = new PeopleToChannelMigrationLegacyWriteGate()
  const fire = (stage: string) => {
    calls.push(stage)
    if (args.crashAt === stage) throw new Error(`injected crash at ${stage}`)
  }
  const coordinator = new PeopleToChannelMigrationFinalizationCoordinator({
    recovery: {
      load: () => clone(currentRecovery),
      beginFinalization: ({ planId, finalizationDigest }) => {
        expect(planId).toBe(PLAN_ID)
        expect(finalizationDigest).toBe(FINALIZATION_DIGEST)
        currentRecovery = recovery('finalizing')
        calls.push('recovery.begin')
        return clone(currentRecovery)
      },
      completeFinalization: ({ planId }) => {
        expect(planId).toBe(PLAN_ID)
        currentRecovery = recovery('committed')
        calls.push('recovery.complete')
        return clone(currentRecovery)
      }
    },
    initialExecution: { load: () => initialExecution() },
    finalizationExecution: {
      prepareBeforeRecoveryFence: (execution) => {
        storedExecution = clone(execution)
        calls.push('execution.persist')
      },
      loadForRecoveryFence: ({ initialPlanId, initialPlanDigest, finalizationDigest }) => {
        expect(initialPlanId).toBe(PLAN_ID)
        expect(initialPlanDigest).toBe(PLAN_DIGEST)
        expect(finalizationDigest).toBe(FINALIZATION_DIGEST)
        if (!storedExecution) throw new Error('missing fenced execution')
        calls.push('execution.load')
        return clone(storedExecution)
      }
    },
    legacyWriteGate: gate,
    logs: {
      apply: () => {
        calls.push('logs.apply')
        return { writtenChannelIds: [], alreadyAppliedChannelIds: [] }
      }
    },
    channels: {
      applyMigrationBatch: () => {
        calls.push('metadata.apply')
        return { applied: false, channelIds: [] }
      }
    },
    people: {
      listShares: () => shareIds.map((shareId) => ({ shareId })),
      retireSharesForChannelMigration: (ids) => {
        calls.push(`people.retire:${ids.join(',')}`)
        shareIds = shareIds.filter((shareId) => !ids.includes(shareId))
        return ids.length
      }
    },
    now: () => 1_000,
    afterStage: fire
  })
  return {
    coordinator,
    gate,
    calls,
    recovery: () => clone(currentRecovery),
    execution: () => storedExecution && clone(storedExecution),
    shareIds: () => [...shareIds]
  }
}

describe('PeopleToChannelMigrationFinalizationCoordinator', () => {
  it('quiesces, fences, converges terminal history/metadata, retires ordinary People, and receipts', () => {
    const active = harness()
    const captured = finalization()

    const result = active.coordinator.run({
      retainedWorkspaceBootstrapShareIds: ['p5_bootstrap'],
      capture: () => captured
    })

    expect(result).toMatchObject({
      phase: 'committed',
      planId: PLAN_ID,
      finalizationDigest: FINALIZATION_DIGEST,
      retireShareIds: ['ordinary_one', 'ordinary_two'],
      retainedWorkspaceBootstrapShareIds: ['p5_bootstrap'],
      recovery: { phase: 'committed' }
    })
    expect(active.calls).toEqual([
      'write_gate_quiesced',
      'execution.persist',
      'finalization_execution_durable',
      'recovery.begin',
      'recovery_fenced',
      'logs.apply',
      'logs_durable',
      'metadata.apply',
      'metadata_durable',
      'people.retire:ordinary_one,ordinary_two',
      'legacy_retired',
      'recovery.complete',
      'receipt_durable'
    ])
    expect(active.shareIds()).toEqual(['p5_bootstrap'])
    expect(() => active.gate.assertOrdinaryWriteAllowed('p5_bootstrap')).not.toThrow()
    expect(() => active.gate.assertOrdinaryWriteAllowed('ordinary_one')).toThrow()
  })

  it('recovers from the durable fence without recapturing or changing the P5 scope', () => {
    const first = harness({ crashAt: 'recovery_fenced' })
    const captured = finalization()
    expect(() =>
      first.coordinator.run({
        retainedWorkspaceBootstrapShareIds: ['p5_bootstrap'],
        capture: () => captured
      })
    ).toThrow('injected crash at recovery_fenced')
    expect(first.recovery().phase).toBe('finalizing')
    expect(first.execution()).toEqual(captured)

    const resumed = harness({
      recoveryPhase: 'finalizing',
      execution: first.execution()!,
      shareIds: first.shareIds()
    })
    expect(
      resumed.coordinator.run({
        capture: () => {
          throw new Error('must not recapture after recovery fence')
        },
        retainedWorkspaceBootstrapShareIds: []
      })
    ).toMatchObject({ phase: 'committed' })
    expect(resumed.calls).toEqual([
      'execution.load',
      'write_gate_quiesced',
      'logs.apply',
      'logs_durable',
      'metadata.apply',
      'metadata_durable',
      'people.retire:ordinary_one,ordinary_two',
      'legacy_retired',
      'recovery.complete',
      'receipt_durable'
    ])
    expect(resumed.shareIds()).toEqual(['p5_bootstrap'])
  })

  it('blocks an unsupported policy or pending-admission state delta before it fences or retires', () => {
    const active = harness()
    const changed = finalization({
      delta: {
        base: {
          policies: [
            {
              channelId: 'channel_one',
              memberId: 'member_one',
              sourceShareId: 'ordinary_one',
              sourceCollaboratorId: 'person_one',
              rules: { appendComment: true },
              requiresHostApproval: false,
              fullHistory: false
            }
          ],
          pendingAdmissionReissues: []
        },
        history: { metadataMutations: [] }
      } as unknown as PeopleToChannelMigrationExecution
    })

    expect(() =>
      active.coordinator.run({
        retainedWorkspaceBootstrapShareIds: ['p5_bootstrap'],
        capture: () => changed
      })
    ).toThrow(PeopleToChannelMigrationFinalizationCoordinatorError)
    expect(active.calls).toEqual(['write_gate_quiesced'])
    expect(active.recovery().phase).toBe('cutover_applied')
    expect(active.shareIds()).toEqual(['ordinary_one', 'ordinary_two', 'p5_bootstrap'])
  })

  it('fails closed rather than treating a partial legacy retirement as recovered', () => {
    const active = harness({
      recoveryPhase: 'finalizing',
      shareIds: ['ordinary_one', 'p5_bootstrap']
    })

    expect(() => active.coordinator.run()).toThrow(/legacy scope is partial or changed/)
    expect(active.calls).toEqual(['execution.load', 'write_gate_quiesced'])
  })
})
