import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostDomainDeltaPublishResult, HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type {
  HostCommandReceiptActor,
  HostCommandReceiptLookupResult,
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
  it('publishes the closed start-effect families (run + thread) and classifies every observation key', () => {
    expect(QUEUED_START_EFFECT_FAMILIES).toEqual(['run', 'thread'])
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
        'rounds',
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
    expect(provesQueuedStartEffects(effects, startIdentity())).toBe(true)
    expect(provesQueuedStartEffects(effects, startIdentity('other'))).toBe(false)
    expect(provesQueuedStartEffects(effects, startIdentity('cmd-1', 'other-thread'))).toBe(false)
  })

  it('does not attribute concurrent same-thread families, other runs, or unpublishable channel diffs', () => {
    const before = emptyFamilies()
    const after = startedAfter('cmd-1', {
      runs: [runRow('cmd-1'), runRow('other-run')],
      missions: [{ missionId: 'mission-1', threadId: 'thread-1' } as never],
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
    const published: HostDomainEffectDto[][] = []
    let releaseQueue!: () => void
    const queueGate = options?.holdQueue
      ? new Promise<void>((resolve) => {
          releaseQueue = resolve
        })
      : Promise.resolve()
    const receipt =
      options?.receipt ?? ({ kind: 'found', receipt: pendingReceipt('cmd-1', 'fp-1') } as const)
    let afterState = options?.after ?? startedAfter()
    const ports = {
      getReceipt: vi.fn((): HostCommandReceiptLookupResult => receipt),
      completeReceipt: vi.fn((input: { commandId: string }) => {
        completes.push(input.commandId)
        return {
          ...pendingReceipt(input.commandId, 'fp-1'),
          status: 'succeeded'
        } as HostCommandReceiptRecord
      }),
      markIndeterminate: vi.fn((input: { commandId: string; errorCode: string }) => {
        indeterminates.push(input.errorCode)
        return { kind: 'marked' as const, receipt: pendingReceipt(input.commandId, 'fp-1') }
      }),
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
      published,
      releaseQueue,
      scope,
      setAfter: (next: HostMutationObservationFamilies) => {
        afterState = next
      }
    }
  }

  it('does not succeed a receipt from onStarted (beginRun is before user-prompt persist)', async () => {
    const { publication, completes, published, ports } = setup()
    publication.onStarted(startedView('cmd-1', 'fp-1'))
    await publication.drain()
    expect(completes).toEqual([])
    expect(published).toEqual([])
    expect(ports.publishEffects).not.toHaveBeenCalled()
    expect(publication.pendingCount()).toBe(1)
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
  it('does not claim phase is on the wire (store/projector residual)', () => {
    const store = readFileSync(join(__dirname, 'HostCommandReceiptStore.ts'), 'utf8')
    const projection = readFileSync(join(__dirname, 'HostCommandReceiptProjection.ts'), 'utf8')
    expect(store).not.toMatch(/\bphase\b/)
    expect(projection).not.toMatch(/candidate\.phase|phase: record\.phase/)
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
    expect(src).toContain('standalone HostNodeProductionServer')
  })
})

describe('createHostQueuedStartStartedSlot', () => {
  it('delivers started and settled handlers independently', () => {
    const slot = createHostQueuedStartStartedSlot()
    const started = vi.fn()
    const settled = vi.fn()
    slot.dispatch(startedView('cmd-1', 'fp-1'))
    slot.dispatchSettled('cmd-1', { status: 'succeeded' })
    expect(started).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    slot.bind(started)
    slot.bindSettled(settled)
    slot.dispatch(startedView('cmd-1', 'fp-1'))
    slot.dispatchSettled('cmd-1', { status: 'failed', errorCode: 'host_saturated' })
    expect(started).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith('cmd-1', {
      status: 'failed',
      errorCode: 'host_saturated'
    })
  })
})
