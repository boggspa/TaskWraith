/**
 * ACK regressions: register before dispatch, queue reservation, no persistence
 * proof from appRunId, fast-flush ordering, conservative uncertain outcomes,
 * single settlements, and shutdown with delayed Bridge work.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import { createHostBridgeQueuedComposerSend } from './HostBridgeQueuedComposerSend'
import type {
  HostBridgeQueuedComposerSendAdapterPort,
  HostBridgeQueuedComposerSendAuthorityPort
} from './HostBridgeQueuedComposerSend'
import type { HostBridgeActionPort, HostBridgeContextResolvers } from './HostBridgeCommandExecutor'
import {
  createHostBridgeQueuedStartAdapter,
  type HostBridgeQueuedStartView
} from './HostBridgeQueuedStartAdapter'
import type { HostCommand } from '../../shared/hostProtocol'
import type { HostAuthorityCallContext } from '../../host-runtime/HostAuthority'
import { fingerprintHostCommand } from '../../host-runtime/HostCommandFingerprint'
import { createHostProjectionSerialQueue } from '../../host-runtime/HostProjectionSerialQueue'
import type { HostCommandReceiptRecord } from '../../host-runtime/HostCommandReceiptStore'
import {
  createHostMutationObservationScope,
  type HostMutationObservationFamilies
} from '../../host-runtime/HostMutationObservationScope'
import {
  createHostQueuedStartPublication,
  type HostQueuedStartPublicationPorts
} from '../../host-runtime/HostQueuedStartPublication'
import { createHostBridgeQueuedStartPublicationBridge } from './HostBridgeQueuedStartPublicationBridge'

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ACTION_ID = `host:command:${COMMAND_ID}`
const THREAD_ID = 'thread-a'
const RUN_ID = 'run-a'
const ROUND_ID = 'round-a'

type EnsembleBridgeResult = Awaited<ReturnType<HostBridgeActionPort['executeEnsembleSteer']>>

function ensembleReply(result: unknown): EnsembleBridgeResult {
  return {
    executed: true,
    message: 'Ensemble action "ensembleSteer" applied',
    data: { actionKind: 'ensembleSteer', result }
  }
}

function ensembleResolvers(roundId?: string): Partial<ResolversStub> {
  return {
    resolveComposerSend: vi.fn<HostBridgeContextResolvers['resolveComposerSend']>(async () => ({
      ok: true,
      value: {
        mode: 'ensemble',
        workspaceId: 'workspace-1',
        ...(roundId ? { roundId } : {})
      }
    }))
  }
}

function command(overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: 2,
    commandId: COMMAND_ID,
    idempotencyKey: 'desktop:client-a:22222222-2222-4222-8222-222222222222',
    actor: { actorId: 'actor-a', clientId: 'client-a', clientClass: 'desktop' },
    name: 'composer.send',
    target: { threadId: THREAD_ID },
    arguments: { text: 'hello from Host' },
    issuedAt: '2026-08-09T00:00:00.000Z',
    ...overrides
  }
}

function context(): HostAuthorityCallContext {
  return {
    actor: { actorId: 'actor-a', clientId: 'client-a', clientClass: 'desktop' },
    client: { clientId: 'client-a', clientClass: 'desktop', clientVersion: 'test' }
  }
}

// Stub port types (audit F9). Each mock is typed by INDEXED ACCESS off the real
// port, so a signature can never drift from the thing it stands in for and no
// `any` / `as never` / `as unknown as` is needed anywhere in this file.
// vitest 4's `Mock<T>` is INVARIANT in T: a `ReturnType<typeof vi.fn>`
// annotation widens to `Mock<Procedure>` and then refuses to satisfy the port,
// which is what produced the eleven TS2322s this slice closes.
type BridgeStub = HostBridgeActionPort & {
  executeComposerPrompt: Mock<HostBridgeActionPort['executeComposerPrompt']>
  executeEnsembleSteer: Mock<HostBridgeActionPort['executeEnsembleSteer']>
}
type ResolversStub = HostBridgeContextResolvers & {
  resolveComposerSend: Mock<HostBridgeContextResolvers['resolveComposerSend']>
}
type AdapterStub = HostBridgeQueuedComposerSendAdapterPort & {
  register: Mock<HostBridgeQueuedComposerSendAdapterPort['register']>
  queued: Mock<HostBridgeQueuedComposerSendAdapterPort['queued']>
  prepared: Mock<HostBridgeQueuedComposerSendAdapterPort['prepared']>
  settled: Mock<HostBridgeQueuedComposerSendAdapterPort['settled']>
  get: Mock<HostBridgeQueuedComposerSendAdapterPort['get']>
  beginShutdown: Mock<HostBridgeQueuedComposerSendAdapterPort['beginShutdown']>
  drain: Mock<HostBridgeQueuedComposerSendAdapterPort['drain']>
}
type AuthorityStub = HostBridgeQueuedComposerSendAuthorityPort & {
  abortQueuedStart: Mock<HostBridgeQueuedComposerSendAuthorityPort['abortQueuedStart']>
}

function bridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  return {
    executeComposerPrompt: vi.fn<HostBridgeActionPort['executeComposerPrompt']>(async () => ({
      executed: true,
      message: 'sent'
    })),
    executeEnsembleSteer: vi.fn<HostBridgeActionPort['executeEnsembleSteer']>(async () => ({
      executed: true,
      message: 'steered'
    })),
    executeCancelRun: vi.fn<HostBridgeActionPort['executeCancelRun']>(),
    executeEnsembleCancelRound: vi.fn<HostBridgeActionPort['executeEnsembleCancelRound']>(),
    executeApprovalReply: vi.fn<HostBridgeActionPort['executeApprovalReply']>(),
    executeQuestionReply: vi.fn<HostBridgeActionPort['executeQuestionReply']>(),
    executeQuestionReject: vi.fn<HostBridgeActionPort['executeQuestionReject']>(),
    executeEnsembleRosterUpdate: vi.fn<HostBridgeActionPort['executeEnsembleRosterUpdate']>(),
    executeSetWatchedThread: vi.fn<HostBridgeActionPort['executeSetWatchedThread']>(),
    ...overrides
  }
}

function resolvers(overrides: Partial<ResolversStub> = {}): ResolversStub {
  return {
    resolveComposerSend: vi.fn<HostBridgeContextResolvers['resolveComposerSend']>(async () => ({
      ok: true,
      value: { mode: 'solo', workspaceId: 'workspace-1', provider: 'codex' }
    })),
    resolveThreadOffers: vi.fn<HostBridgeContextResolvers['resolveThreadOffers']>(),
    resolveRunCancel: vi.fn<HostBridgeContextResolvers['resolveRunCancel']>(),
    resolveApprovalDecide: vi.fn<HostBridgeContextResolvers['resolveApprovalDecide']>(),
    resolveQuestionAnswer: vi.fn<HostBridgeContextResolvers['resolveQuestionAnswer']>(),
    resolveEnsembleSeatToggle: vi.fn<HostBridgeContextResolvers['resolveEnsembleSeatToggle']>(),
    resolveThreadSelect: vi.fn<HostBridgeContextResolvers['resolveThreadSelect']>(),
    ...overrides
  }
}

/**
 * A REAL view, not a cast. The executor verifies correlation with `get`; typing the
 * fixture properly is what lets every adapter mock satisfy its port signature
 * without an escape hatch — and it reds honestly if the view shape changes.
 */
const VIEW: HostBridgeQueuedStartView = {
  hostCommandActionId: ACTION_ID,
  threadId: THREAD_ID,
  authority: {
    actorId: 'actor-a',
    clientId: 'client-a',
    clientClass: 'desktop',
    commandFingerprint: fingerprintHostCommand(command()).fingerprint
  },
  phase: 'registered'
}

function adapter(overrides: Partial<AdapterStub> = {}): AdapterStub {
  return {
    register: vi.fn<HostBridgeQueuedComposerSendAdapterPort['register']>(() => ({
      kind: 'registered',
      view: VIEW
    })),
    queued: vi.fn<HostBridgeQueuedComposerSendAdapterPort['queued']>(async () => ({
      kind: 'applied',
      view: VIEW
    })),
    prepared: vi.fn<HostBridgeQueuedComposerSendAdapterPort['prepared']>(async () => ({
      kind: 'applied',
      view: VIEW
    })),
    settled: vi.fn<HostBridgeQueuedComposerSendAdapterPort['settled']>(async () => ({
      kind: 'applied',
      view: VIEW
    })),
    get: vi.fn<HostBridgeQueuedComposerSendAdapterPort['get']>(() => VIEW),
    beginShutdown: vi.fn<HostBridgeQueuedComposerSendAdapterPort['beginShutdown']>(),
    drain: vi.fn<HostBridgeQueuedComposerSendAdapterPort['drain']>(async () => undefined),
    ...overrides
  }
}

function authority(overrides: Partial<AuthorityStub> = {}): AuthorityStub {
  return {
    abortQueuedStart: vi.fn<HostBridgeQueuedComposerSendAuthorityPort['abortQueuedStart']>(),
    ...overrides
  }
}

function build(
  overrides: {
    bridge?: Partial<BridgeStub>
    resolvers?: Partial<ResolversStub>
    adapter?: Partial<AdapterStub>
    authority?: Partial<AuthorityStub>
  } = {}
): {
  execute: ReturnType<typeof createHostBridgeQueuedComposerSend>
  bridgePort: BridgeStub
  adapterPort: AdapterStub
  authorityPort: AuthorityStub
} {
  const bridgePort = bridge(overrides.bridge)
  const adapterPort = adapter(overrides.adapter)
  const authorityPort = authority(overrides.authority)
  const execute = createHostBridgeQueuedComposerSend({
    bridge: bridgePort,
    resolvers: resolvers(overrides.resolvers),
    adapter: adapterPort,
    authority: authorityPort
  })
  return { execute, bridgePort, adapterPort, authorityPort }
}

function deferredStartPublication(mode: 'solo' | 'ensemble') {
  const cmd = command()
  const fingerprint = fingerprintHostCommand(cmd).fingerprint
  let receipt: HostCommandReceiptRecord = {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: cmd.idempotencyKey,
    commandName: cmd.name,
    commandFingerprint: fingerprint,
    actor: context().actor,
    target: { kind: 'thread', id: THREAD_ID },
    authority: { decision: 'allowed' },
    status: 'pending',
    createdAt: cmd.issuedAt,
    updatedAt: cmd.issuedAt,
    generation: 1,
    cursor: 1
  }
  const before: HostMutationObservationFamilies = {
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' },
    threads: [
      {
        id: THREAD_ID,
        workspaceId: 'workspace-1',
        title: mode === 'solo' ? 'Solo' : 'Ensemble',
        chatKind: mode === 'solo' ? 'single' : 'ensemble',
        archived: false,
        pinned: false,
        updatedAt: 0,
        messageCount: 0
      }
    ],
    workspaces: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    artifacts: [],
    warnings: [],
    usage: { availability: 'unavailable' }
  }
  const after: HostMutationObservationFamilies = {
    ...before,
    threads: [
      {
        ...before.threads[0],
        updatedAt: 1,
        messageCount: 1,
        ...(mode === 'ensemble' ? { activeRoundId: ROUND_ID } : {})
      }
    ],
    runs:
      mode === 'solo'
        ? [{ runId: RUN_ID, threadId: THREAD_ID, providerId: 'codex', providerOutcome: 'running' }]
        : [],
    rounds:
      mode === 'ensemble'
        ? [
            {
              roundId: ROUND_ID,
              threadId: THREAD_ID,
              status: 'running',
              participantIds: [],
              providerRunIds: []
            }
          ]
        : []
  }
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const queue = createHostProjectionSerialQueue()
  const blockingPublication = queue(async () => {
    await barrier
  })
  const completeReceipt = vi.fn<HostQueuedStartPublicationPorts['completeReceipt']>((input) => {
    if (receipt.status !== 'pending') return null
    receipt = { ...receipt, ...input }
    return receipt
  })
  const markIndeterminate = vi.fn<HostQueuedStartPublicationPorts['markIndeterminate']>((input) => {
    receipt = { ...receipt, status: 'indeterminate', errorCode: input.errorCode }
    return { kind: 'marked', receipt }
  })
  const publishEffects = vi.fn<HostQueuedStartPublicationPorts['publishEffects']>((effects) => ({
    kind: 'published',
    position: { generation: 1, cursor: 2 },
    count: effects.length,
    results: []
  }))
  const publication = createHostQueuedStartPublication({
    getReceipt: () => ({ kind: 'found', receipt }),
    completeReceipt,
    markIndeterminate,
    updateReceiptPhase: (_commandId, phase) => {
      if (receipt.status !== 'pending') return { kind: 'status_refused', status: receipt.status }
      receipt = { ...receipt, phase }
      return { kind: 'updated', receipt }
    },
    readScopedFamilies: () => after,
    publishEffects,
    getPosition: () => ({ generation: 1, cursor: 1 }),
    runProjectionOperation: queue
  })
  publication.register({
    commandId: COMMAND_ID,
    actor: context().actor,
    fingerprint,
    command: cmd,
    beforeScoped: before,
    scope: createHostMutationObservationScope(cmd, before)
  })
  const abortQueuedStart = vi.fn((commandId: string) => publication.abort(commandId))
  const glue = createHostBridgeQueuedStartPublicationBridge({
    authority: {
      handleQueuedStartStarting: (view) => {
        publication.onStarting(view)
      },
      handleQueuedStartDispatchSettled: (commandId, _result, entities) => {
        publication.completeStart(commandId, entities)
      },
      abortQueuedStart
    }
  })
  const adapterPort = createHostBridgeQueuedStartAdapter({
    runProjectionOperation: createHostProjectionSerialQueue(),
    onPrepared: (view) => {
      glue.onPrepared(view)
    },
    onSettled: (view) => {
      glue.onSettled(view)
    }
  })
  return {
    adapterPort,
    authorityPort: { abortQueuedStart },
    publication,
    receipt: () => receipt,
    completeReceipt,
    markIndeterminate,
    publishEffects,
    release,
    blockingPublication
  }
}

describe('HostBridgeQueuedComposerSend', () => {
  it('registers the Host↔Bridge correlation BEFORE any Bridge call', async () => {
    const order: string[] = []
    const { execute, bridgePort, adapterPort } = build({
      adapter: {
        register: vi.fn<HostBridgeQueuedComposerSendAdapterPort['register']>(() => {
          order.push('register')
          return { kind: 'registered', view: VIEW }
        })
      },
      bridge: {
        executeComposerPrompt: vi.fn(async () => {
          order.push('bridge')
          return { executed: true, message: 'sent', data: { appRunId: RUN_ID } }
        })
      }
    })
    await execute(command(), context())
    expect(order).toEqual(['register', 'bridge'])
    expect(adapterPort.register).toHaveBeenCalledWith({
      hostCommandActionId: ACTION_ID,
      threadId: THREAD_ID,
      authority: {
        actorId: 'actor-a',
        clientId: 'client-a',
        clientClass: 'desktop',
        commandFingerprint: expect.any(String)
      }
    })
    expect(bridgePort.executeComposerPrompt).toHaveBeenCalledTimes(1)
  })

  it('dispatches the Bridge call exactly once per execute', async () => {
    const { execute, bridgePort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: true,
          message: 'sent',
          data: { appRunId: RUN_ID }
        }))
      }
    })
    await execute(command(), context())
    expect(bridgePort.executeComposerPrompt).toHaveBeenCalledTimes(1)
  })

  it('maps a busy-queue Bridge result to a queued adapter event with the queueId as reservedRunId', async () => {
    const { execute, adapterPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: true,
          message: 'Queued behind the active run.',
          data: { queuedBehindActiveRun: true, queueId: 'remote-queue-abc' }
        }))
      }
    })
    const result = await execute(command(), context())
    expect(result).toEqual({ status: 'succeeded', resultSummary: 'run_queued' })
    expect(adapterPort.queued).toHaveBeenCalledWith({
      kind: 'queued',
      hostCommandActionId: ACTION_ID,
      threadId: THREAD_ID,
      queueId: 'remote-queue-abc',
      reservedRunId: 'remote-queue-abc'
    })
    expect(adapterPort.prepared).not.toHaveBeenCalled()
  })

  it('ACKs a dispatched run identity without synthesizing persistence or calling prepared', async () => {
    const { execute, adapterPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: true,
          message: 'Dispatching on your Mac.',
          data: { appRunId: RUN_ID }
        }))
      }
    })
    const result = await execute(command(), context())
    expect(result).toEqual({ status: 'succeeded', resultSummary: 'run_queued' })
    expect(adapterPort.prepared).not.toHaveBeenCalled()
    expect(adapterPort.get).toHaveBeenCalledWith(ACTION_ID)
    expect(adapterPort.queued).not.toHaveBeenCalled()
  })

  it('settles a Bridge-reported failure exactly once', async () => {
    const { execute, adapterPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: false,
          message: 'Composer prompt could not be dispatched: provider down'
        }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('failed')
    expect(adapterPort.settled).toHaveBeenCalledTimes(1)
    expect(adapterPort.settled).toHaveBeenCalledWith({
      kind: 'settled',
      hostCommandActionId: ACTION_ID,
      threadId: THREAD_ID,
      status: 'failed',
      errorCode: 'bridge_not_executed'
    })
  })

  it('settles a user-declined Bridge result as cancelled exactly once', async () => {
    const { execute, adapterPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: false,
          message: 'declined',
          reasonCode: 'userDeclined'
        }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('cancelled')
    expect(adapterPort.settled).toHaveBeenCalledTimes(1)
    expect(adapterPort.settled).toHaveBeenCalledWith({
      kind: 'settled',
      hostCommandActionId: ACTION_ID,
      threadId: THREAD_ID,
      status: 'cancelled',
      errorCode: 'user_declined'
    })
  })

  it.each(
    (['prepared', 'settled'] as const).flatMap((phase) =>
      (
        [
          'success',
          'failed',
          'cancelled',
          'throws',
          'missing identity',
          'wrong run',
          'queued',
          'wrong queue',
          'queue throws',
          'queue fails'
        ] as const
      ).map((outcome) => ({ phase, outcome }))
    )
  )(
    'keeps Authority publication pending after $phase evidence and a late $outcome solo ACK',
    async ({ phase, outcome }) => {
      const start = { kind: 'solo' as const, runId: RUN_ID }
      const h = deferredStartPublication('solo')
      const { adapterPort, authorityPort } = h
      const prepared = vi.spyOn(adapterPort, 'prepared')
      const settled = vi.spyOn(adapterPort, 'settled')
      const queued = vi.spyOn(adapterPort, 'queued')
      if (outcome === 'queue throws')
        queued.mockRejectedValueOnce(new Error('late queue publication failed'))
      if (outcome === 'queue fails')
        queued.mockResolvedValueOnce({ kind: 'failed', reason: 'publication_failed' })
      const bridgePort = bridge({
        executeComposerPrompt: vi.fn<HostBridgeActionPort['executeComposerPrompt']>(async () => {
          expect(adapterPort.get(ACTION_ID)?.phase).toBe('registered')
          await adapterPort.prepared({
            kind: 'prepared',
            hostCommandActionId: ACTION_ID,
            threadId: THREAD_ID,
            durablePromptAndStartPersisted: true,
            start,
            effectRefs: [
              { family: 'thread', entityId: THREAD_ID },
              { family: 'run', entityId: RUN_ID }
            ]
          })
          if (phase === 'settled')
            await adapterPort.settled({
              kind: 'settled',
              hostCommandActionId: ACTION_ID,
              threadId: THREAD_ID,
              status: 'started',
              start
            })
          if (outcome === 'throws') throw new Error('Bridge failed after durable solo start')
          if (outcome === 'failed') return { executed: false, message: 'late failure' }
          if (outcome === 'cancelled')
            return { executed: false, message: 'late cancellation', reasonCode: 'userDeclined' }
          if (outcome === 'missing identity') return { executed: true, message: 'sent' }
          if (
            outcome === 'queued' ||
            outcome === 'wrong queue' ||
            outcome === 'queue throws' ||
            outcome === 'queue fails'
          )
            return {
              executed: true,
              message: 'queued',
              data: {
                queuedBehindActiveRun: true,
                queueId: outcome === 'wrong queue' ? 'other-run' : RUN_ID
              }
            }
          return {
            executed: true,
            message: 'sent',
            data: { appRunId: outcome === 'wrong run' ? 'other-run' : RUN_ID }
          }
        })
      })
      const execute = createHostBridgeQueuedComposerSend({
        bridge: bridgePort,
        adapter: adapterPort,
        authority: authorityPort,
        resolvers: resolvers()
      })
      try {
        expect(await execute(command(), context())).toEqual({
          status: 'succeeded',
          resultSummary:
            outcome === 'success' || outcome === 'queued' ? 'run_queued' : 'run_queued_unproven'
        })
        expect(bridgePort.executeComposerPrompt).toHaveBeenCalledOnce()
        expect(authorityPort.abortQueuedStart).not.toHaveBeenCalled()
        expect(h.markIndeterminate).not.toHaveBeenCalled()
        expect(h.completeReceipt).not.toHaveBeenCalled()
        expect(h.publishEffects).not.toHaveBeenCalled()
        expect(h.receipt()).toMatchObject({ status: 'pending', phase: 'started' })
        expect(h.publication.pendingCount()).toBe(1)
        expect(h.publication.inFlightCount()).toBe(1)
        expect(prepared).toHaveBeenCalledOnce()
        expect(settled).toHaveBeenCalledTimes(phase === 'settled' ? 1 : 0)
        expect(adapterPort.get(ACTION_ID)).toMatchObject({
          phase,
          prepared: { start },
          ...(phase === 'settled' ? { settled: { status: 'started', start } } : {})
        })
        h.release()
        await h.blockingPublication
        await h.publication.drain()
        expect(h.receipt()).toMatchObject({
          commandId: COMMAND_ID,
          status: 'succeeded',
          resultSummary: 'run_started'
        })
        expect(h.completeReceipt).toHaveBeenCalledOnce()
        expect(h.markIndeterminate).not.toHaveBeenCalled()
        expect(h.publishEffects).toHaveBeenCalledExactlyOnceWith([
          expect.objectContaining({ family: 'run', entityId: RUN_ID }),
          expect.objectContaining({ family: 'thread', entityId: THREAD_ID })
        ])
      } finally {
        h.release()
        await h.blockingPublication
        await h.publication.drain()
      }
    }
  )

  it.each(['applied', 'throws'] as const)(
    'keeps exact solo proof prepared while the late failure settlement %s',
    async (outcome) => {
      const h = deferredStartPublication('solo')
      const { adapterPort, authorityPort } = h
      const originalSettled = adapterPort.settled.bind(adapterPort)
      const settled = vi.spyOn(adapterPort, 'settled').mockImplementationOnce(async (event) => {
        await adapterPort.prepared({
          kind: 'prepared',
          hostCommandActionId: ACTION_ID,
          threadId: THREAD_ID,
          durablePromptAndStartPersisted: true,
          start: { kind: 'solo', runId: RUN_ID },
          effectRefs: [
            { family: 'thread', entityId: THREAD_ID },
            { family: 'run', entityId: RUN_ID }
          ]
        })
        if (outcome === 'throws') throw new Error('late settlement failed')
        return originalSettled(event)
      })
      const execute = createHostBridgeQueuedComposerSend({
        bridge: bridge({
          executeComposerPrompt: vi.fn(async () => ({ executed: false, message: 'late failure' }))
        }),
        adapter: adapterPort,
        authority: authorityPort,
        resolvers: resolvers()
      })
      try {
        expect(await execute(command(), context())).toEqual({
          status: 'succeeded',
          resultSummary: 'run_queued_unproven'
        })
        expect(settled).toHaveBeenCalledOnce()
        expect(authorityPort.abortQueuedStart).not.toHaveBeenCalled()
        expect(h.markIndeterminate).not.toHaveBeenCalled()
        expect(h.completeReceipt).not.toHaveBeenCalled()
        expect(h.publishEffects).not.toHaveBeenCalled()
        expect(h.receipt()).toMatchObject({ status: 'pending', phase: 'started' })
        expect(h.publication.pendingCount()).toBe(1)
        expect(h.publication.inFlightCount()).toBe(1)
        h.release()
        await h.blockingPublication
        await h.publication.drain()
        expect(h.receipt()).toMatchObject({
          commandId: COMMAND_ID,
          status: 'succeeded',
          resultSummary: 'run_started'
        })
        expect(h.completeReceipt).toHaveBeenCalledOnce()
        expect(h.markIndeterminate).not.toHaveBeenCalled()
        expect(h.publishEffects).toHaveBeenCalledExactlyOnceWith([
          expect.objectContaining({ family: 'run', entityId: RUN_ID }),
          expect.objectContaining({ family: 'thread', entityId: THREAD_ID })
        ])
      } finally {
        h.release()
        await h.blockingPublication
        await h.publication.drain()
      }
    }
  )

  it.each(
    (
      [
        'missing',
        'action',
        'thread',
        'kind',
        'phase',
        'actor',
        'client',
        'client class',
        'fingerprint',
        'unsafe run',
        'reservation',
        'throws'
      ] as const
    ).flatMap((mismatch) =>
      (['failed', 'throws', 'missing identity', 'wrong run', 'queued'] as const).map((outcome) => ({
        mismatch,
        outcome
      }))
    )
  )(
    'abandons a $outcome solo ACK with mismatched $mismatch evidence',
    async ({ mismatch, outcome }) => {
      let view: HostBridgeQueuedStartView | undefined = {
        ...VIEW,
        phase: 'prepared',
        prepared: {
          start: { kind: 'solo', runId: RUN_ID },
          effectRefs: [
            { family: 'thread', entityId: THREAD_ID },
            { family: 'run', entityId: RUN_ID }
          ]
        }
      }
      if (mismatch === 'missing') view = undefined
      if (mismatch === 'action' && view)
        view = {
          ...view,
          hostCommandActionId: 'host:command:33333333-3333-4333-8333-333333333333'
        }
      if (mismatch === 'thread' && view) view = { ...view, threadId: 'other-thread' }
      if (mismatch === 'phase' && view) view = { ...view, phase: 'registered' }
      if (mismatch === 'actor' && view)
        view = { ...view, authority: { ...view.authority, actorId: 'other-actor' } }
      if (mismatch === 'client' && view)
        view = { ...view, authority: { ...view.authority, clientId: 'other-client' } }
      if (mismatch === 'client class' && view)
        view = { ...view, authority: { ...view.authority, clientClass: 'other-class' } }
      if (mismatch === 'fingerprint' && view)
        view = { ...view, authority: { ...view.authority, commandFingerprint: 'other-command' } }
      if (mismatch === 'reservation' && view)
        view = { ...view, queued: { queueId: 'other-run', reservedRunId: 'other-run' } }
      if ((mismatch === 'kind' || mismatch === 'unsafe run') && view)
        view = {
          ...view,
          prepared: {
            start:
              mismatch === 'kind'
                ? { kind: 'ensemble', roundId: ROUND_ID, participantRunIds: [] }
                : { kind: 'solo', runId: ' padded-run' },
            effectRefs: []
          }
        }
      const { execute, adapterPort, authorityPort } = build({
        adapter: {
          queued: vi.fn(async () => ({ kind: 'refused', reason: 'regression' })),
          get: vi.fn<HostBridgeQueuedComposerSendAdapterPort['get']>(() => {
            if (mismatch === 'throws') throw new Error('lookup failed')
            return view
          })
        },
        bridge: {
          executeComposerPrompt: vi.fn<HostBridgeActionPort['executeComposerPrompt']>(async () => {
            if (outcome === 'throws') throw new Error('Bridge failed')
            return {
              executed: outcome !== 'failed',
              message: 'late ACK',
              ...(outcome === 'wrong run' ? { data: { appRunId: 'other-run' } } : {}),
              ...(outcome === 'queued'
                ? { data: { queuedBehindActiveRun: true, queueId: RUN_ID } }
                : {})
            }
          })
        }
      })
      expect(await execute(command(), context())).toEqual({
        status: 'succeeded',
        resultSummary: 'run_queued_unproven'
      })
      expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
      expect(adapterPort.prepared).not.toHaveBeenCalled()
      expect(adapterPort.settled).not.toHaveBeenCalled()
    }
  )

  it('R5: Bridge success with neither run identity nor queue reservation aborts once and never settles', async () => {
    const { execute, adapterPort, authorityPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({ executed: true, message: 'sent' }))
      }
    })
    const result = await execute(command(), context())
    // F4: an aborting path ACKs succeeded/run_queued_unproven. `failed` here
    // would race publication.fail against abort() having emptied the pending
    // gate, and losing that race records a delivered prompt as a failure.
    expect(result.status).toBe('succeeded')
    expect(result.resultSummary).toBe('run_queued_unproven')
    expect(result.errorCode).toBeUndefined()
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledTimes(1)
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledWith(COMMAND_ID)
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it('R5: a throwing Bridge call aborts once and never settles', async () => {
    const { execute, adapterPort, authorityPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => {
          throw new Error('bridge exploded')
        })
      }
    })
    const result = await execute(command(), context())
    // A throwing Bridge call cannot certify "no execution" either.
    expect(result.status).toBe('succeeded')
    expect(result.resultSummary).toBe('run_queued_unproven')
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledTimes(1)
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it('R5: an abort port that mutates then throws cannot turn delivered work into failure', async () => {
    let promoted = false
    const { execute, adapterPort, authorityPort } = build({
      authority: {
        abortQueuedStart: vi.fn(() => {
          promoted = true
          throw new Error('authority exploded')
        })
      },
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({ executed: true, message: 'sent' }))
      }
    })
    const result = await execute(command(), context())
    expect(promoted).toBe(true)
    expect(result).toEqual({ status: 'succeeded', resultSummary: 'run_queued_unproven' })
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledTimes(1)
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it('N1: the constructor throws when the abort port is absent', () => {
    // The authority port is deliberately the ONLY incomplete argument.
    const incompleteAuthority = {} as Partial<HostBridgeQueuedComposerSendAuthorityPort>
    expect(() =>
      createHostBridgeQueuedComposerSend({
        bridge: bridge(),
        resolvers: resolvers(),
        adapter: adapter(),
        authority: incompleteAuthority as HostBridgeQueuedComposerSendAuthorityPort
      })
    ).toThrow('HostBridgeQueuedComposerSend requires authority.abortQueuedStart')
  })

  it('N3: a refused queued event aborts once and ACKs unproven, never run_queued', async () => {
    const { execute, adapterPort, authorityPort } = build({
      adapter: {
        queued: vi.fn(async () => ({ kind: 'refused', reason: 'shutting_down' }))
      },
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: true,
          message: 'sent',
          data: { queuedBehindActiveRun: true, queueId: RUN_ID }
        }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('succeeded')
    // The distinction that matters: unproven, NOT the run_queued a genuinely
    // applied queued event returns.
    expect(result.resultSummary).toBe('run_queued_unproven')
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledTimes(1)
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it('N3: a throwing queued event aborts once and ACKs unproven, never run_queued', async () => {
    const { execute, authorityPort } = build({
      adapter: {
        queued: vi.fn(async () => {
          throw new Error('adapter exploded')
        })
      },
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: true,
          message: 'sent',
          data: { queuedBehindActiveRun: true, queueId: RUN_ID }
        }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('succeeded')
    expect(result.resultSummary).toBe('run_queued_unproven')
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledTimes(1)
  })

  it('N4: a throwing adapter.register is contained as a failed result', async () => {
    const { execute, bridgePort } = build({
      adapter: {
        register: vi.fn(() => {
          throw new Error('register exploded')
        })
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('queued_start_registration_threw')
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
  })

  it('N6: the settled-once fence holds across two executes of the same commandId', async () => {
    const { execute, adapterPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: false,
          message: 'provider down'
        }))
      }
    })
    await execute(command(), context())
    await execute(command(), context())
    expect(adapterPort.settled).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, ROUND_ID])(
    'registers before one unchanged Ensemble steer payload with round target %s',
    async (roundId) => {
      const order: string[] = []
      const { execute, bridgePort, adapterPort, authorityPort } = build({
        resolvers: ensembleResolvers(roundId),
        adapter: {
          register: vi.fn<HostBridgeQueuedComposerSendAdapterPort['register']>(() => {
            order.push('register')
            return { kind: 'registered', view: VIEW }
          })
        },
        bridge: {
          executeEnsembleSteer: vi.fn<HostBridgeActionPort['executeEnsembleSteer']>(async () => {
            order.push('steer')
            return ensembleReply({ ok: true, status: 'started', roundId: ROUND_ID })
          })
        }
      })
      expect(await execute(command(), context())).toEqual({
        status: 'succeeded',
        resultSummary: 'run_queued'
      })
      expect(order).toEqual(['register', 'steer'])
      expect(adapterPort.register).toHaveBeenCalledExactlyOnceWith({
        hostCommandActionId: ACTION_ID,
        threadId: THREAD_ID,
        authority: {
          ...context().actor,
          commandFingerprint: fingerprintHostCommand(command()).fingerprint
        }
      })
      const action = bridgePort.executeEnsembleSteer.mock.calls[0][0]
      if (action.issuedAt === undefined) throw new Error('Host action requires issuedAt')
      expect(bridgePort.executeEnsembleSteer).toHaveBeenCalledExactlyOnceWith({
        kind: 'ensembleSteer',
        actionId: ACTION_ID,
        issuedAt: action.issuedAt,
        expiresAt: action.issuedAt + 120_000,
        workspaceId: 'workspace-1',
        threadId: THREAD_ID,
        text: 'hello from Host',
        message: 'Sent via Host protocol',
        ...(roundId ? { roundId } : {})
      })
      expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
      expect(adapterPort.queued).not.toHaveBeenCalled()
      expect(adapterPort.prepared).not.toHaveBeenCalled()
      expect(adapterPort.settled).not.toHaveBeenCalled()
      expect(authorityPort.abortQueuedStart).not.toHaveBeenCalled()
    }
  )

  it.each([
    { label: 'queued', raw: ensembleReply({ status: 'queued', roundId: ROUND_ID }) },
    { label: 'steered', raw: ensembleReply({ status: 'steered', roundId: ROUND_ID }) },
    { label: 'absorbed', raw: ensembleReply({ status: 'absorbed', roundId: ROUND_ID }) },
    { label: 'missing status', raw: ensembleReply({ roundId: ROUND_ID }) },
    { label: 'missing identity', raw: ensembleReply({ status: 'started' }) },
    { label: 'empty identity', raw: ensembleReply({ status: 'started', roundId: '' }) },
    { label: 'padded identity', raw: ensembleReply({ status: 'started', roundId: ' round-a' }) },
    { label: 'non-string identity', raw: ensembleReply({ status: 'started', roundId: 4 }) },
    { label: 'undefined result', raw: ensembleReply(undefined) },
    { label: 'null result', raw: ensembleReply(null) },
    { label: 'array result', raw: ensembleReply([{ status: 'started', roundId: ROUND_ID }]) },
    { label: 'no data', raw: { executed: true, message: 'sent' } },
    {
      label: 'wrong action kind',
      raw: {
        executed: true,
        message: 'sent',
        data: { actionKind: 'other', result: { status: 'started', roundId: ROUND_ID } }
      }
    },
    {
      label: 'failed after start-shaped data',
      raw: { ...ensembleReply({ status: 'started', roundId: ROUND_ID }), executed: false }
    },
    {
      label: 'declined',
      raw: { executed: false, message: 'declined', reasonCode: 'userDeclined' as const }
    }
  ])('abandons an uncertain Ensemble $label ACK without claiming no-start', async ({ raw }) => {
    const { execute, bridgePort, adapterPort, authorityPort } = build({
      resolvers: ensembleResolvers(),
      bridge: {
        executeEnsembleSteer: vi.fn<HostBridgeActionPort['executeEnsembleSteer']>(async () => raw)
      }
    })
    expect(await execute(command(), context())).toEqual({
      status: 'succeeded',
      resultSummary: 'run_queued_unproven'
    })
    expect(bridgePort.executeEnsembleSteer).toHaveBeenCalledOnce()
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(adapterPort.queued).not.toHaveBeenCalled()
    expect(adapterPort.prepared).not.toHaveBeenCalled()
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it('contains a throwing Ensemble Bridge and abandons proof once across repeated ACK attempts', async () => {
    const { execute, bridgePort, adapterPort, authorityPort } = build({
      resolvers: ensembleResolvers(),
      bridge: {
        executeEnsembleSteer: vi.fn<HostBridgeActionPort['executeEnsembleSteer']>(async () => {
          throw new Error('round effect may already exist')
        })
      }
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await execute(command(), context())).toEqual({
        status: 'succeeded',
        resultSummary: 'run_queued_unproven'
      })
      expect(bridgePort.executeEnsembleSteer).toHaveBeenCalledTimes(attempt + 1)
    }
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(adapterPort.prepared).not.toHaveBeenCalled()
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it.each(['refused', 'throws'] as const)(
    'does not dispatch Ensemble when registration %s',
    async (failure) => {
      const { execute, bridgePort, authorityPort } = build({
        resolvers: ensembleResolvers(),
        adapter: {
          register: vi.fn<HostBridgeQueuedComposerSendAdapterPort['register']>(() => {
            if (failure === 'throws') throw new Error('registration failed')
            return { kind: 'refused', reason: 'shutting_down' }
          })
        }
      })
      expect(await execute(command(), context())).toMatchObject({
        status: 'failed',
        errorCode:
          failure === 'throws'
            ? 'queued_start_registration_threw'
            : 'queued_start_registration_refused'
      })
      expect(bridgePort.executeEnsembleSteer).not.toHaveBeenCalled()
      expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
      expect(authorityPort.abortQueuedStart).not.toHaveBeenCalled()
    }
  )

  it.each([
    'missing',
    'action',
    'thread',
    'kind',
    'phase',
    'actor',
    'client',
    'client class',
    'fingerprint',
    'unsafe round',
    'throws'
  ] as const)('abandons an Ensemble start ACK with mismatched %s evidence', async (mismatch) => {
    let view: HostBridgeQueuedStartView | undefined = {
      ...VIEW,
      authority: {
        ...context().actor,
        commandFingerprint: fingerprintHostCommand(command()).fingerprint
      },
      phase: 'prepared',
      prepared: {
        start: { kind: 'ensemble', roundId: ROUND_ID, participantRunIds: [] },
        effectRefs: [
          { family: 'thread', entityId: THREAD_ID },
          { family: 'round', entityId: ROUND_ID }
        ]
      }
    }
    if (mismatch === 'missing') view = undefined
    if (mismatch === 'action' && view)
      view = {
        ...view,
        hostCommandActionId: 'host:command:33333333-3333-4333-8333-333333333333'
      }
    if (mismatch === 'thread' && view) view = { ...view, threadId: 'other-thread' }
    if (mismatch === 'phase' && view) view = { ...view, phase: 'registered' }
    if (mismatch === 'actor' && view)
      view = { ...view, authority: { ...view.authority, actorId: 'other-actor' } }
    if (mismatch === 'client' && view)
      view = { ...view, authority: { ...view.authority, clientId: 'other-client' } }
    if (mismatch === 'client class' && view)
      view = { ...view, authority: { ...view.authority, clientClass: 'other-class' } }
    if (mismatch === 'fingerprint' && view)
      view = { ...view, authority: { ...view.authority, commandFingerprint: 'other-command' } }
    if ((mismatch === 'kind' || mismatch === 'unsafe round') && view)
      view = {
        ...view,
        prepared: {
          start:
            mismatch === 'kind'
              ? { kind: 'solo', runId: RUN_ID }
              : { kind: 'ensemble', roundId: ' padded-round', participantRunIds: [] },
          effectRefs: []
        }
      }
    const { execute, adapterPort, authorityPort } = build({
      resolvers: ensembleResolvers(),
      adapter: {
        get: vi.fn<HostBridgeQueuedComposerSendAdapterPort['get']>(() => {
          if (mismatch === 'throws') throw new Error('lookup failed')
          return view
        })
      },
      bridge: {
        executeEnsembleSteer: vi.fn<HostBridgeActionPort['executeEnsembleSteer']>(async () => ({
          ...ensembleReply({ status: 'started', roundId: ROUND_ID }),
          executed: false
        }))
      }
    })
    expect(await execute(command(), context())).toEqual({
      status: 'succeeded',
      resultSummary: 'run_queued_unproven'
    })
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(adapterPort.prepared).not.toHaveBeenCalled()
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it.each(
    (['prepared', 'settled'] as const).flatMap((phase) =>
      (['success', 'failed', 'throws', 'wrong round', 'steered', 'undefined'] as const).map(
        (outcome) => ({ phase, outcome })
      )
    )
  )(
    'keeps Authority publication pending after $phase evidence and a late $outcome Ensemble ACK',
    async ({ phase, outcome }) => {
      const start = { kind: 'ensemble' as const, roundId: ROUND_ID, participantRunIds: [] }
      const h = deferredStartPublication('ensemble')
      const { adapterPort, authorityPort } = h
      const prepared = vi.spyOn(adapterPort, 'prepared')
      const settled = vi.spyOn(adapterPort, 'settled')
      const bridgePort = bridge({
        executeEnsembleSteer: vi.fn<HostBridgeActionPort['executeEnsembleSteer']>(async () => {
          expect(adapterPort.get(ACTION_ID)?.phase).toBe('registered')
          await adapterPort.prepared({
            kind: 'prepared',
            hostCommandActionId: ACTION_ID,
            threadId: THREAD_ID,
            durablePromptAndStartPersisted: true,
            start,
            effectRefs: [
              { family: 'thread', entityId: THREAD_ID },
              { family: 'round', entityId: ROUND_ID }
            ]
          })
          if (phase === 'settled')
            await adapterPort.settled({
              kind: 'settled',
              hostCommandActionId: ACTION_ID,
              threadId: THREAD_ID,
              status: 'started',
              start
            })
          if (outcome === 'throws') throw new Error('Bridge failed after durable round start')
          if (outcome === 'undefined') return ensembleReply(undefined)
          return {
            ...ensembleReply({
              status: outcome === 'steered' ? 'steered' : 'started',
              roundId: outcome === 'wrong round' ? 'other-round' : ROUND_ID
            }),
            executed: outcome !== 'failed'
          }
        })
      })
      const execute = createHostBridgeQueuedComposerSend({
        bridge: bridgePort,
        adapter: adapterPort,
        authority: authorityPort,
        resolvers: resolvers(ensembleResolvers())
      })
      try {
        expect(await execute(command(), context())).toEqual({
          status: 'succeeded',
          resultSummary: outcome === 'success' ? 'run_queued' : 'run_queued_unproven'
        })
        expect(bridgePort.executeEnsembleSteer).toHaveBeenCalledOnce()
        expect(authorityPort.abortQueuedStart).not.toHaveBeenCalled()
        expect(h.markIndeterminate).not.toHaveBeenCalled()
        expect(h.completeReceipt).not.toHaveBeenCalled()
        expect(h.publishEffects).not.toHaveBeenCalled()
        expect(h.receipt()).toMatchObject({ status: 'pending', phase: 'started' })
        expect(h.publication.pendingCount()).toBe(1)
        expect(h.publication.inFlightCount()).toBe(1)
        expect(prepared).toHaveBeenCalledOnce()
        expect(settled).toHaveBeenCalledTimes(phase === 'settled' ? 1 : 0)
        expect(adapterPort.get(ACTION_ID)).toMatchObject({
          phase,
          prepared: { start },
          ...(phase === 'settled' ? { settled: { status: 'started', start } } : {})
        })
        h.release()
        await h.blockingPublication
        await h.publication.drain()
        expect(h.receipt()).toMatchObject({
          commandId: COMMAND_ID,
          status: 'succeeded',
          resultSummary: 'run_started'
        })
        expect(h.completeReceipt).toHaveBeenCalledOnce()
        expect(h.markIndeterminate).not.toHaveBeenCalled()
        expect(h.publishEffects).toHaveBeenCalledExactlyOnceWith([
          expect.objectContaining({ family: 'thread', entityId: THREAD_ID }),
          expect.objectContaining({ family: 'round', entityId: ROUND_ID })
        ])
      } finally {
        h.release()
        await h.blockingPublication
        await h.publication.drain()
      }
    }
  )

  it('never throws when the resolver throws', async () => {
    const { execute } = build({
      resolvers: {
        resolveComposerSend: vi.fn(async () => {
          throw new Error('resolver exploded')
        })
      }
    })
    await expect(execute(command(), context())).resolves.toEqual({
      status: 'failed',
      errorCode: 'context_resolve_failed',
      errorMessage: 'composer send context resolution threw'
    })
  })

  it('refuses a registration refusal without a Bridge call', async () => {
    const { execute, bridgePort } = build({
      adapter: {
        register: vi.fn(() => ({ kind: 'refused', reason: 'shutting_down' }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('queued_start_registration_refused')
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
  })

  it('fences new executes after beginShutdown', async () => {
    const { execute, bridgePort } = build()
    execute.beginShutdown()
    const result = await execute(command(), context())
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('shutting_down')
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
  })

  it('drain awaits the adapter drain', async () => {
    const { execute, adapterPort } = build()
    await execute.drain()
    expect(adapterPort.drain).toHaveBeenCalledTimes(1)
  })

  it('drain waits for a delayed Bridge ACK before draining its resulting adapter events', async () => {
    let releaseBridge!: () => void
    const bridgeWait = new Promise<void>((resolve) => {
      releaseBridge = resolve
    })
    const order: string[] = []
    const { execute, bridgePort, adapterPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => {
          await bridgeWait
          order.push('bridge')
          return {
            executed: true,
            message: 'queued',
            data: { queuedBehindActiveRun: true, queueId: RUN_ID }
          }
        })
      },
      adapter: {
        queued: vi.fn(async () => {
          order.push('queued')
          return { kind: 'applied', view: VIEW }
        }),
        drain: vi.fn(async () => {
          order.push('drain')
        })
      }
    })
    const execution = execute(command(), context())
    await vi.waitFor(() => expect(bridgePort.executeComposerPrompt).toHaveBeenCalledOnce())
    execute.beginShutdown()
    let drained = false
    const draining = execute.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(adapterPort.drain).not.toHaveBeenCalled()
    releaseBridge()
    await Promise.all([execution, draining])
    expect(order).toEqual(['bridge', 'queued', 'drain'])
  })

  it.each(['prepared', 'settled'] as const)(
    'preserves a matching %s run when queue flush beats its ACK',
    async (phase) => {
      const { execute, authorityPort, adapterPort } = build({
        adapter: {
          queued: vi.fn(async () => ({
            kind: 'refused',
            reason: phase === 'prepared' ? 'regression' : 'terminal'
          })),
          get: vi.fn(() => ({
            ...VIEW,
            phase,
            prepared: {
              start: { kind: 'solo', runId: RUN_ID },
              effectRefs: [
                { family: 'run', entityId: RUN_ID },
                { family: 'thread', entityId: THREAD_ID }
              ]
            },
            ...(phase === 'settled'
              ? {
                  settled: {
                    status: 'started' as const,
                    start: { kind: 'solo' as const, runId: RUN_ID }
                  }
                }
              : {})
          }))
        },
        bridge: {
          executeComposerPrompt: vi.fn(async () => ({
            executed: true,
            message: 'queued',
            data: { queuedBehindActiveRun: true, queueId: RUN_ID }
          }))
        }
      })
      expect(await execute(command(), context())).toEqual({
        status: 'succeeded',
        resultSummary: 'run_queued'
      })
      expect(authorityPort.abortQueuedStart).not.toHaveBeenCalled()
      expect(adapterPort.prepared).not.toHaveBeenCalled()
    }
  )

  it.each(['thread', 'action', 'reservation'] as const)(
    'does not accept a prepared queue race with mismatched %s identity',
    async (mismatch) => {
      const { execute, authorityPort } = build({
        adapter: {
          queued: vi.fn(async () => ({ kind: 'refused', reason: 'regression' })),
          get: vi.fn(() => ({
            ...VIEW,
            hostCommandActionId:
              mismatch === 'action'
                ? 'host:command:22222222-2222-4222-8222-222222222222'
                : ACTION_ID,
            threadId: mismatch === 'thread' ? 'other-thread' : THREAD_ID,
            phase: 'prepared',
            ...(mismatch === 'reservation'
              ? { queued: { queueId: 'other-run', reservedRunId: 'other-run' } }
              : {}),
            prepared: {
              start: { kind: 'solo', runId: RUN_ID },
              effectRefs: [
                { family: 'run', entityId: RUN_ID },
                { family: 'thread', entityId: THREAD_ID }
              ]
            }
          }))
        },
        bridge: {
          executeComposerPrompt: vi.fn(async () => ({
            executed: true,
            message: 'queued',
            data: { queuedBehindActiveRun: true, queueId: RUN_ID }
          }))
        }
      })
      expect(await execute(command(), context())).toEqual({
        status: 'succeeded',
        resultSummary: 'run_queued_unproven'
      })
      expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    }
  )

  it.each(['refused', 'throws'] as const)(
    'abandons proof if failure settlement %s instead of leaving the receipt pending',
    async (failure) => {
      const { execute, authorityPort } = build({
        adapter: {
          settled: vi.fn(async () => {
            if (failure === 'throws') throw new Error('settlement unavailable')
            return { kind: 'refused', reason: 'shutting_down' }
          })
        },
        bridge: {
          executeComposerPrompt: vi.fn(async () => ({ executed: false, message: 'not sent' }))
        }
      })
      expect(await execute(command(), context())).toEqual({
        status: 'succeeded',
        resultSummary: 'run_queued_unproven'
      })
      expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    }
  )

  it('does not accept an early run ACK whose registered correlation disappeared', async () => {
    const { execute, authorityPort, adapterPort } = build({
      adapter: { get: vi.fn(() => undefined) },
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: true,
          message: 'sent',
          data: { appRunId: RUN_ID }
        }))
      }
    })
    expect(await execute(command(), context())).toEqual({
      status: 'succeeded',
      resultSummary: 'run_queued_unproven'
    })
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
    expect(adapterPort.prepared).not.toHaveBeenCalled()
  })

  it('rejects a non-composer.send command without touching Bridge', async () => {
    const { execute, bridgePort } = build()
    const result = await execute(command({ name: 'run.cancel' }), context())
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('not_governed_mutation')
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
  })
})
