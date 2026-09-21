import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  HOST_QUEUED_START_PHASES,
  type HostCommand,
  type HostQueuedStartPhase
} from '../shared/hostProtocol'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostDomainDeltaPublishResult, HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type {
  HostCommandReceiptActor,
  HostCommandReceiptLookupResult,
  HostCommandReceiptPhaseUpdateResult,
  HostCommandReceiptRecord
} from './HostCommandReceiptStore'
import type { HostMutationObservationFamilies } from './HostMutationObservationScope'
import {
  createHostQueuedStartPublication,
  createHostQueuedStartStartedSlot,
  diffScopedStartEffects,
  provesQueuedStartEffects,
  QUEUED_START_EFFECT_FAMILIES,
  QUEUED_START_EXCLUDED_OBSERVATION_KEYS,
  type HostQueuedStartStartedView
} from './HostQueuedStartPublication'

const actor = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
} satisfies HostCommandReceiptActor

function command(commandId: string, threadId = 'thread-1'): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `idem-${commandId}`,
    name: 'composer.send',
    actor: {
      actorId: actor.actorId,
      clientId: actor.clientId,
      clientClass: actor.clientClass
    },
    target: { threadId },
    arguments: { text: 'hi' },
    issuedAt: '2026-01-01T00:00:00.000Z'
  }
}

function emptyFamilies(): HostMutationObservationFamilies {
  return {
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    },
    workspaces: [],
    threads: [{ id: 'thread-1' } as HostMutationObservationFamilies['threads'][number]],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: {} as HostMutationObservationFamilies['usage'],
    artifacts: [],
    warnings: []
  }
}

function runRow(
  runId: string,
  providerOutcome: 'running' | 'completed' = 'running'
): HostMutationObservationFamilies['runs'][number] {
  return {
    runId,
    threadId: 'thread-1',
    providerId: 'codex',
    providerOutcome
  } as HostMutationObservationFamilies['runs'][number]
}

function startedThread(): HostMutationObservationFamilies['threads'][number] {
  return { id: 'thread-1', messageCount: 1, updatedAt: 2 } as never
}

function startIdentity(commandId = 'cmd-1', threadId = 'thread-1') {
  return { commandId, threadId }
}

function startEffects(
  before: HostMutationObservationFamilies,
  after: HostMutationObservationFamilies,
  identity = startIdentity()
): HostDomainEffectDto[] {
  const result = diffScopedStartEffects(before, after, identity)
  expect(result.kind).toBe('effects')
  if (result.kind !== 'effects') throw new Error('expected effects')
  return [...result.effects]
}

function startedAfter(
  commandId = 'cmd-1',
  extra: Partial<HostMutationObservationFamilies> = {}
): HostMutationObservationFamilies {
  return {
    ...emptyFamilies(),
    runs: [runRow(commandId)],
    threads: [startedThread()],
    ...extra
  }
}

function pendingReceipt(commandId: string, fingerprint: string): HostCommandReceiptRecord {
  return {
    schemaVersion: 1,
    commandId,
    idempotencyKey: `idem-${commandId}`,
    commandFingerprint: fingerprint,
    status: 'pending',
    actor,
    target: { kind: 'thread', threadId: 'thread-1' },
    authority: { decision: 'allowed' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    commandName: 'composer.send',
    generation: 1,
    cursor: 1
  } as HostCommandReceiptRecord
}

function startedView(
  commandId: string,
  fingerprint: string,
  overrides: Partial<HostQueuedStartStartedView> = {}
): HostQueuedStartStartedView {
  return {
    commandId,
    threadId: 'thread-1',
    fingerprint,
    phase: 'started',
    startedEvidence: true,
    terminalOutcome: null,
    ...overrides
  }
}

describe('diffScopedStartEffects / provesQueuedStartEffects', () => {
  it('publishes the closed start-effect families (run + thread + ensemble round) and classifies every observation key', () => {
    expect(QUEUED_START_EFFECT_FAMILIES).toEqual(['run', 'thread', 'round'])
    expect(Object.keys(QUEUED_START_EXCLUDED_OBSERVATION_KEYS).sort()).toEqual(
      [
        'approvals',
        'artifacts',
        'channels',
        'health',
        'missions',
        'participants',
        'providers',
        'questions',
        'routing',
        'schedules',
        'usage',
        'warnings',
        'workspaces'
      ].sort()
    )
    const before = emptyFamilies()
    const after = startedAfter()
    const effects = startEffects(before, after)
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'upsert', family: 'run', entityId: 'cmd-1' }),
        expect.objectContaining({ kind: 'upsert', family: 'thread', entityId: 'thread-1' })
      ])
    )
    expect(effects).toHaveLength(2)
    expect(effects.some((effect) => effect.family === 'round')).toBe(false)
    expect(provesQueuedStartEffects(effects, startIdentity())).toBe(true)
    expect(provesQueuedStartEffects(effects, startIdentity('other'))).toBe(false)
    expect(provesQueuedStartEffects(effects, startIdentity('cmd-1', 'other-thread'))).toBe(false)
  })

  it('does not attribute concurrent same-thread families, other runs, or unpublishable channel diffs', () => {
    const before = emptyFamilies()
    const after = startedAfter('cmd-1', {
      runs: [runRow('cmd-1'), runRow('other-run')],
      missions: [{ missionId: 'mission-1', threadId: 'thread-1' } as never],
      rounds: [{ roundId: 'round-1', threadId: 'thread-1' } as never],
      questions: [{ questionId: 'q-1', threadId: 'thread-1' } as never],
      approvals: [{ approvalId: 'a-1', threadId: 'thread-1' } as never],
      channels: [{ channelId: 'ch-1', threadId: 'thread-1' } as never],
      health: {
        hostStatus: 'degraded',
        connectionPhase: 'live',
        supervised: false,
        freshness: 'live'
      },
      usage: { availability: 'available' } as never,
      routing: { defaultProviderId: 'codex' } as never,
      warnings: [{ warningId: 'w-1' } as never]
    })
    const effects = startEffects(before, after)
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'upsert', family: 'run', entityId: 'cmd-1' }),
        expect.objectContaining({ kind: 'upsert', family: 'thread', entityId: 'thread-1' })
      ])
    )
    expect(effects.some((effect) => effect.entityId === 'other-run')).toBe(false)
    expect(effects.some((effect) => effect.family === 'mission')).toBe(false)
    expect(effects.some((effect) => effect.family === 'round')).toBe(false)
    expect(effects.some((effect) => effect.family === 'question')).toBe(false)
    expect(effects.some((effect) => effect.family === 'approval')).toBe(false)
    expect(effects.some((effect) => effect.family === 'channel')).toBe(false)
    expect(effects.some((effect) => effect.family === 'health')).toBe(false)
    expect(effects.some((effect) => effect.family === 'usage')).toBe(false)
    expect(effects.some((effect) => effect.family === 'routing')).toBe(false)
    expect(effects.some((effect) => effect.family === 'warning')).toBe(false)
    expect(provesQueuedStartEffects(effects, startIdentity())).toBe(true)
  })

  it('does not treat a run-only or thread-only diff as complete start proof', () => {
    const before = emptyFamilies()
    const runOnly = startEffects(before, { ...emptyFamilies(), runs: [runRow('cmd-1')] })
    expect(runOnly).toEqual([
      expect.objectContaining({ kind: 'upsert', family: 'run', entityId: 'cmd-1' })
    ])
    expect(provesQueuedStartEffects(runOnly, startIdentity())).toBe(false)
    const threadOnly = startEffects(before, { ...emptyFamilies(), threads: [startedThread()] })
    expect(threadOnly).toEqual([
      expect.objectContaining({ kind: 'upsert', family: 'thread', entityId: 'thread-1' })
    ])
    expect(provesQueuedStartEffects(threadOnly, startIdentity())).toBe(false)
  })

  it('fails closed when AFTER contains duplicate command-run rows', () => {
    const after = startedAfter('cmd-1', {
      runs: [runRow('cmd-1'), runRow('cmd-1', 'completed')]
    })
    expect(diffScopedStartEffects(emptyFamilies(), after, startIdentity())).toEqual({
      kind: 'incoherent',
      reason: 'duplicate_entity_id'
    })
  })

  it('emits the ensemble round row only when the identity carries a roundId', () => {
    const round = { roundId: 'round-1', threadId: 'thread-1' } as never
    const before = emptyFamilies()
    const after = startedAfter('cmd-1', { rounds: [round] })
    // Solo identity: round rows are ignored even when they change.
    const solo = startEffects(before, after, startIdentity())
    expect(solo).toHaveLength(2)
    expect(solo.some((effect) => effect.family === 'round')).toBe(false)
    expect(provesQueuedStartEffects(solo, startIdentity())).toBe(true)
    // Ensemble identity: the round upsert joins run + thread.
    const ensembleIdentity = { ...startIdentity(), roundId: 'round-1' }
    const ensemble = startEffects(before, after, ensembleIdentity)
    expect(ensemble).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'upsert', family: 'run', entityId: 'cmd-1' }),
        expect.objectContaining({ kind: 'upsert', family: 'thread', entityId: 'thread-1' }),
        expect.objectContaining({ kind: 'upsert', family: 'round', entityId: 'round-1' })
      ])
    )
    expect(ensemble).toHaveLength(3)
    expect(provesQueuedStartEffects(ensemble, ensembleIdentity)).toBe(true)
  })

  it('requires the round upsert for ensemble identities and ignores it for solo ones', () => {
    const runUpsert: HostDomainEffectDto = {
      kind: 'upsert',
      family: 'run',
      entityId: 'cmd-1',
      payload: {}
    }
    const threadUpsert: HostDomainEffectDto = {
      kind: 'upsert',
      family: 'thread',
      entityId: 'thread-1',
      payload: {}
    }
    const roundUpsert: HostDomainEffectDto = {
      kind: 'upsert',
      family: 'round',
      entityId: 'round-1',
      payload: {}
    }
    const pair = [runUpsert, threadUpsert]
    // Solo: the pair proves; a stray round upsert neither proves nor breaks.
    expect(provesQueuedStartEffects(pair, startIdentity())).toBe(true)
    expect(provesQueuedStartEffects([...pair, roundUpsert], startIdentity())).toBe(true)
    // Ensemble: the pair alone is incomplete; the triple proves; a wrong round fails.
    const ensembleIdentity = { ...startIdentity(), roundId: 'round-1' }
    expect(provesQueuedStartEffects(pair, ensembleIdentity)).toBe(false)
    expect(provesQueuedStartEffects([...pair, roundUpsert], ensembleIdentity)).toBe(true)
    expect(
      provesQueuedStartEffects(
        [...pair, { ...roundUpsert, entityId: 'round-2' }],
        ensembleIdentity
      )
    ).toBe(false)
  })

  it('fails closed when AFTER contains duplicate ensemble round rows', () => {
    const round = { roundId: 'round-1', threadId: 'thread-1' } as never
    const roundDuplicate = { roundId: 'round-1', threadId: 'thread-1' } as never
    const after = startedAfter('cmd-1', { rounds: [round, roundDuplicate] })
    expect(
      diffScopedStartEffects(emptyFamilies(), after, { ...startIdentity(), roundId: 'round-1' })
    ).toEqual({ kind: 'incoherent', reason: 'duplicate_entity_id' })
    // The same duplicate rows are invisible to solo identities.
    expect(diffScopedStartEffects(emptyFamilies(), after, startIdentity()).kind).toBe('effects')
  })
})

describe('createHostQueuedStartPublication', () => {
  function setup(options?: {
    receipt?: HostCommandReceiptLookupResult
    after?: HostMutationObservationFamilies
    publish?: HostDomainDeltaPublishResult
    holdQueue?: boolean
    rejectQueue?: boolean
  }) {
    const completes: string[] = []
    const indeterminates: string[] = []
    const phaseUpdates: HostQueuedStartPhase[] = []
    const published: HostDomainEffectDto[][] = []
    let releaseQueue!: () => void
    const queueGate = options?.holdQueue
      ? new Promise<void>((resolve) => {
          releaseQueue = resolve
        })
      : Promise.resolve()
    let receiptState: HostCommandReceiptLookupResult =
      options?.receipt ?? ({ kind: 'found', receipt: pendingReceipt('cmd-1', 'fp-1') } as const)
    let afterState = options?.after ?? startedAfter()
    const ports = {
      getReceipt: vi.fn((): HostCommandReceiptLookupResult => receiptState),
      completeReceipt: vi.fn((input: { commandId: string }) => {
        completes.push(input.commandId)
        const completed = {
          ...pendingReceipt(input.commandId, 'fp-1'),
          ...(receiptState.kind === 'found' ? receiptState.receipt : {}),
          status: 'succeeded'
        } as HostCommandReceiptRecord
        receiptState = { kind: 'found', receipt: completed }
        return completed
      }),
      markIndeterminate: vi.fn((input: { commandId: string; errorCode: string }) => {
        indeterminates.push(input.errorCode)
        const receipt = {
          ...pendingReceipt(input.commandId, 'fp-1'),
          ...(receiptState.kind === 'found' ? receiptState.receipt : {}),
          status: 'indeterminate'
        } as HostCommandReceiptRecord
        receiptState = { kind: 'found', receipt }
        return { kind: 'marked' as const, receipt }
      }),
      updateReceiptPhase: vi.fn(
        (
          commandId: string,
          phase: HostQueuedStartPhase,
          executionClaimCursor?: HostCommandReceiptRecord['executionClaimCursor']
        ): HostCommandReceiptPhaseUpdateResult => {
          if (receiptState.kind !== 'found' || receiptState.receipt.commandId !== commandId) {
            return { kind: 'not_found' }
          }
          const current = receiptState.receipt
          if (current.status !== 'pending') {
            return { kind: 'status_refused', status: current.status }
          }
          if (
            current.phase === phase &&
            (executionClaimCursor === undefined || current.executionClaimCursor !== undefined)
          ) {
            return { kind: 'unchanged', receipt: current }
          }
          if (
            current.phase !== undefined &&
            HOST_QUEUED_START_PHASES.indexOf(phase) <
              HOST_QUEUED_START_PHASES.indexOf(current.phase)
          ) {
            return {
              kind: 'regression_refused',
              currentPhase: current.phase,
              requestedPhase: phase
            }
          }
          const receipt = {
            ...current,
            phase,
            ...(executionClaimCursor ? { executionClaimCursor } : {})
          }
          receiptState = { kind: 'found', receipt }
          phaseUpdates.push(phase)
          return { kind: 'updated', receipt }
        }
      ),
      readScopedFamilies: vi.fn(async () => afterState),
      publishEffects: vi.fn(
        (effects: readonly HostDomainEffectDto[]): HostDomainDeltaPublishResult => {
          published.push([...effects])
          return (
            options?.publish ?? {
              kind: 'published',
              position: { generation: 1, cursor: 2 },
              count: effects.length,
              results: []
            }
          )
        }
      ),
      getPosition: vi.fn(() => ({ generation: 1, cursor: 1 })),
      runProjectionOperation: async <T>(operation: () => Promise<T>): Promise<T> => {
        await queueGate
        if (options?.rejectQueue) throw new Error('queue shutdown')
        return operation()
      },
      now: () => '2026-01-01T00:00:01.000Z'
    }
    // Spy on the method so the ports retain the runner's generic return type.
    vi.spyOn(ports, 'runProjectionOperation')
    const publication = createHostQueuedStartPublication(ports)
    const scope = {
      threadIds: new Set(['thread-1']),
      workspaceIds: new Set<string>(),
      providerIds: new Set<string>(),
      questionIds: new Set<string>(),
      approvalIds: new Set<string>(),
      channelIds: new Set<string>(),
      includeAllWorkspaces: false,
      useFullSnapshot: false
    }
    publication.register({
      commandId: 'cmd-1',
      actor,
      fingerprint: 'fp-1',
      command: command('cmd-1'),
      beforeScoped: emptyFamilies(),
      scope
    })
    return {
      ports,
      publication,
      completes,
      indeterminates,
      phaseUpdates,
      published,
      releaseQueue,
      scope,
      setAfter: (next: HostMutationObservationFamilies) => {
        afterState = next
      }
    }
  }

  it('keeps onStarted witness-only and advances started only after dispatch settlement', async () => {
    const { publication, completes, phaseUpdates, published, ports } = setup()
    expect(publication.markQueued('cmd-1')).toEqual({ kind: 'queued' })
    const executionClaimCursor = { coverageEpoch: 'a'.repeat(64), sequence: 4 }
    expect(
      publication.onStarting(
        startedView('cmd-1', 'fp-1', {
          phase: 'starting',
          executionClaimCursor,
          startedEvidence: false
        })
      )
    ).toEqual({ kind: 'starting' })
    expect(ports.updateReceiptPhase).toHaveBeenCalledWith('cmd-1', 'starting', executionClaimCursor)
    publication.onStarted(startedView('cmd-1', 'fp-1'))
    await publication.drain()
    expect(phaseUpdates).toEqual(['queued', 'starting'])
    expect(completes).toEqual([])
    expect(published).toEqual([])
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(publication.pendingCount()).toBe(1)

    publication.completeStart('cmd-1')
    await publication.drain()
    expect(phaseUpdates).toEqual(['queued', 'starting', 'started'])
    expect(completes).toEqual(['cmd-1'])
  })

  it('makes duplicate queued/starting phase evidence idempotent without extra writes', () => {
    const { publication, phaseUpdates, ports } = setup()
    expect(publication.markQueued('cmd-1')).toEqual({ kind: 'queued' })
    expect(publication.markQueued('cmd-1')).toEqual({ kind: 'queued' })
    const starting = startedView('cmd-1', 'fp-1', {
      phase: 'starting',
      startedEvidence: false
    })
    expect(publication.onStarting(starting)).toEqual({ kind: 'starting' })
    expect(publication.onStarting(starting)).toEqual({ kind: 'starting' })
    expect(phaseUpdates).toEqual(['queued', 'starting'])
    expect(ports.updateReceiptPhase).toHaveBeenCalledTimes(4)
  })

  it('fails closed when starting evidence does not match the original registration', () => {
    const { publication, indeterminates, phaseUpdates } = setup()
    expect(publication.markQueued('cmd-1')).toEqual({ kind: 'queued' })
    expect(
      publication.onStarting(
        startedView('cmd-1', 'wrong-fingerprint', {
          phase: 'starting',
          startedEvidence: false
        })
      )
    ).toMatchObject({ kind: 'indeterminate' })
    expect(phaseUpdates).toEqual(['queued'])
    expect(indeterminates).toContain('deferred_execution_may_have_begun')
    expect(publication.pendingCount()).toBe(0)
  })

  it('completes the ORIGINAL receipt after persist-settled completeStart without attributing a concurrent mission or other run', async () => {
    const after = startedAfter('cmd-1', {
      runs: [runRow('cmd-1'), runRow('other-run')],
      missions: [{ missionId: 'mission-1', threadId: 'thread-1' } as never]
    })
    const { publication, completes, published, ports } = setup({ after })
    publication.completeStart('cmd-1')
    await publication.drain()
    expect(completes).toEqual(['cmd-1'])
    expect(published[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'run', entityId: 'cmd-1' }),
        expect.objectContaining({ family: 'thread', entityId: 'thread-1' })
      ])
    )
    expect(published[0]).toHaveLength(2)
    expect(published[0]!.some((effect) => effect.entityId === 'other-run')).toBe(false)
    expect(published[0]!.some((effect) => effect.family === 'mission')).toBe(false)
    expect(ports.completeReceipt.mock.calls[0][0]).toMatchObject({
      commandId: 'cmd-1',
      status: 'succeeded'
    })
    expect(publication.pendingCount()).toBe(0)
  })

  it('does not append start effects until the projection queue releases a held legacy observer', async () => {
    const { publication, published, completes, ports, releaseQueue } = setup({ holdQueue: true })
    publication.completeStart('cmd-1')
    await Promise.resolve()
    expect(ports.runProjectionOperation).toHaveBeenCalled()
    expect(published).toEqual([])
    expect(completes).toEqual([])
    expect(ports.readScopedFamilies).not.toHaveBeenCalled()
    releaseQueue()
    await publication.drain()
    expect(published).toHaveLength(1)
    expect(completes).toEqual(['cmd-1'])
  })

  it('marks start publication incoherent when the thread upsert is missing', async () => {
    const { publication, completes, indeterminates, published } = setup({
      after: { ...emptyFamilies(), runs: [runRow('cmd-1')] }
    })
    publication.completeStart('cmd-1')
    await publication.drain()
    expect(completes).toEqual([])
    expect(published).toEqual([])
    expect(indeterminates).toContain('observation_diff_incoherent')
    expect(publication.pendingCount()).toBe(0)
  })

  it('does not publish a stale running upsert captured before a held queue releases', async () => {
    const { publication, published, setAfter, releaseQueue } = setup({
      holdQueue: true,
      after: {
        ...emptyFamilies(),
        runs: [runRow('cmd-1', 'running')],
        threads: [startedThread()]
      }
    })
    publication.completeStart('cmd-1')
    await Promise.resolve()
    setAfter({
      ...emptyFamilies(),
      runs: [runRow('cmd-1', 'completed')],
      threads: [startedThread()]
    })
    releaseQueue()
    await publication.drain()
    expect(published).toHaveLength(1)
    expect(published[0]!.find((effect) => effect.family === 'run')).toMatchObject({
      family: 'run',
      entityId: 'cmd-1',
      payload: expect.objectContaining({ providerOutcome: 'completed' })
    })
    expect(
      published[0]!.some((effect) => {
        const payload = effect.payload as { providerOutcome?: string } | undefined
        return payload?.providerOutcome === 'running'
      })
    ).toBe(false)
  })

  it('terminalizes the original receipt on dispatch failure and drops registration', async () => {
    const { publication, completes, ports } = setup()
    const failed: HostCommandExecutionResult = {
      status: 'failed',
      errorCode: 'host_saturated'
    }
    publication.fail('cmd-1', failed)
    expect(publication.pendingCount()).toBe(0)
    expect(ports.completeReceipt.mock.calls[0][0]).toMatchObject({
      commandId: 'cmd-1',
      status: 'failed',
      errorCode: 'host_saturated'
    })
    expect(completes).toEqual(['cmd-1'])
    publication.completeStart('cmd-1')
    await publication.drain()
    expect(ports.completeReceipt).toHaveBeenCalledTimes(1)
  })

  it('abort terminalizes as indeterminate and clears pending', async () => {
    const { publication, indeterminates, ports } = setup()
    expect(publication.pendingCount()).toBe(1)
    publication.abort('cmd-1')
    expect(publication.pendingCount()).toBe(0)
    expect(indeterminates).toContain('deferred_execution_may_have_begun')
    publication.completeStart('cmd-1')
    await publication.drain()
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('never mints a second receipt for an unregistered command', async () => {
    const { publication, ports } = setup()
    publication.completeStart('ghost')
    publication.fail('ghost', { status: 'failed', errorCode: 'run_not_started' })
    await publication.drain()
    expect(ports.completeReceipt).not.toHaveBeenCalled()
  })

  it('drains work scheduled while an in-flight drain is waiting', async () => {
    const { publication, completes, releaseQueue } = setup({ holdQueue: true })
    publication.completeStart('cmd-1')
    const draining = publication.drain()
    releaseQueue()
    await draining
    expect(completes).toEqual(['cmd-1'])
  })

  it('promotes the original receipt indeterminate when the projection queue rejects', async () => {
    const { publication, completes, published, indeterminates } = setup({ rejectQueue: true })
    publication.completeStart('cmd-1')
    await expect(publication.drain()).resolves.toBeUndefined()
    expect(completes).toEqual([])
    expect(published).toEqual([])
    expect(indeterminates).toContain('deferred_effects_unavailable')
    expect(publication.pendingCount()).toBe(0)
    expect(publication.inFlightCount()).toBe(0)
  })

  it('does not succeed when AFTER has duplicate command-run rows', async () => {
    const { publication, completes, published, indeterminates } = setup({
      after: startedAfter('cmd-1', {
        runs: [runRow('cmd-1'), runRow('cmd-1', 'completed')]
      })
    })
    publication.completeStart('cmd-1')
    await publication.drain()
    expect(completes).toEqual([])
    expect(published).toEqual([])
    expect(indeterminates).toContain('observation_diff_incoherent')
    expect(publication.pendingCount()).toBe(0)
  })
})

describe('residuals', () => {
  it('uses the reviewed receipt-phase foundation without advancing from onStarted', () => {
    const store = readFileSync(join(__dirname, 'HostCommandReceiptStore.ts'), 'utf8')
    const projection = readFileSync(join(__dirname, 'HostCommandReceiptProjection.ts'), 'utf8')
    const publication = readFileSync(join(__dirname, 'HostQueuedStartPublication.ts'), 'utf8')
    expect(store).toContain('updatePhase(')
    expect(projection).toContain('candidate.phase = record.phase')
    const onStarted = publication.slice(
      publication.indexOf('onStarted(view)'),
      publication.indexOf('completeStart(commandId)')
    )
    expect(onStarted).not.toContain("advancePhase(input, 'started')")
    expect(publication).toContain("const phase = advancePhase(input, 'started')")
  })

  it('does not emit family channel; publisher still omits it (out-of-grant residual)', () => {
    const publication = readFileSync(join(__dirname, 'HostQueuedStartPublication.ts'), 'utf8')
    const publisher = readFileSync(join(__dirname, 'HostDomainDeltaPublisher.ts'), 'utf8')
    const specs = publication.slice(
      publication.indexOf('const START_EFFECT_FAMILY_SPECS'),
      publication.indexOf('function upsert')
    )
    expect(specs).not.toMatch(/family: 'channel'/)
    expect(publication).toContain('DOMAIN_EFFECT_FAMILIES rejects')
    const families = publisher.slice(
      publisher.indexOf('const DOMAIN_EFFECT_FAMILIES'),
      publisher.indexOf(')', publisher.indexOf('const DOMAIN_EFFECT_FAMILIES')) + 1
    )
    expect(families).toContain("'health'")
    expect(families).not.toContain("'channel'")
  })

  it('names HostMainComposition as an intentional standalone-only residual', () => {
    const src = readFileSync(join(__dirname, 'HostQueuedStartPublication.ts'), 'utf8')
    expect(src).toContain('HostMainComposition')
    expect(src).toContain('Standalone HostNodeProductionServer')
  })
})

describe('createHostQueuedStartStartedSlot', () => {
  it('delivers starting, started, and settled handlers independently', () => {
    const slot = createHostQueuedStartStartedSlot()
    const starting = vi.fn()
    const started = vi.fn()
    const settled = vi.fn()
    const startingView = startedView('cmd-1', 'fp-1', {
      phase: 'starting',
      startedEvidence: false
    })
    slot.dispatchStarting(startingView)
    slot.dispatch(startedView('cmd-1', 'fp-1'))
    slot.dispatchSettled('cmd-1', { status: 'succeeded' })
    expect(starting).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    slot.bindStarting(starting)
    slot.bind(started)
    slot.bindSettled(settled)
    slot.dispatchStarting(startingView)
    slot.dispatch(startedView('cmd-1', 'fp-1'))
    slot.dispatchSettled('cmd-1', { status: 'failed', errorCode: 'host_saturated' })
    expect(starting).toHaveBeenCalledWith(startingView)
    expect(started).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith('cmd-1', {
      status: 'failed',
      errorCode: 'host_saturated'
    })
  })
})
