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
import type { HostBridgeQueuedStartView } from './HostBridgeQueuedStartAdapter'
import type { HostCommand } from '../../shared/hostProtocol'
import type { HostAuthorityCallContext } from '../../host-runtime/HostAuthority'

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ACTION_ID = `host:command:${COMMAND_ID}`
const THREAD_ID = 'thread-a'
const RUN_ID = 'run-a'

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
    commandFingerprint: 'fingerprint-a'
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

  it('does not replace a producer-proven start with a contradictory late Bridge failure', async () => {
    const { execute, adapterPort, authorityPort } = build({
      adapter: {
        get: vi.fn(() => ({
          ...VIEW,
          phase: 'prepared',
          prepared: {
            start: { kind: 'solo', runId: RUN_ID },
            effectRefs: [
              { family: 'thread', entityId: THREAD_ID },
              { family: 'run', entityId: RUN_ID }
            ]
          }
        }))
      },
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({ executed: false, message: 'late failure' }))
      }
    })
    expect(await execute(command(), context())).toEqual({
      status: 'succeeded',
      resultSummary: 'run_queued_unproven'
    })
    expect(adapterPort.settled).not.toHaveBeenCalled()
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledExactlyOnceWith(COMMAND_ID)
  })

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

  it('steers an ensemble send through the legacy lane without registration', async () => {
    const { execute, bridgePort, adapterPort } = build({
      resolvers: {
        resolveComposerSend: vi.fn(async () => ({
          ok: true,
          value: { mode: 'ensemble', workspaceId: 'workspace-1', roundId: 'round-1' }
        }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('succeeded')
    expect(bridgePort.executeEnsembleSteer).toHaveBeenCalledTimes(1)
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
    expect(adapterPort.register).not.toHaveBeenCalled()
    expect(adapterPort.queued).not.toHaveBeenCalled()
    expect(adapterPort.prepared).not.toHaveBeenCalled()
  })

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

  it.each(['thread', 'run', 'action', 'reservation'] as const)(
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
              start: { kind: 'solo', runId: mismatch === 'run' ? 'other-run' : RUN_ID },
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
