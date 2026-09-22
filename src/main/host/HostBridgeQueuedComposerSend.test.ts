/**
 * HostBridgeQueuedComposerSend tests (Independent Threads M2, producer step 3b).
 *
 * Pins the ACK executor's contract: register-before-ACK, single dispatch,
 * busy-queue→queued, dispatched→prepared, failure→settled-once,
 * steer→legacy without registration, never-throw, drain awaits tails,
 * shutdown fence, and the ruling's R5 case-2 classification (Bridge success
 * with neither run identity nor queue reservation → abortQueuedStart once,
 * never handleQueuedStartDispatchSettled).
 *
 * RED-PROOF: each named pin must go red when its behaviour is deleted
 * separately. The R5 pin in particular is the ruling's red-first test.
 */

import { describe, expect, it, vi } from 'vitest'

import { createHostBridgeQueuedComposerSend } from './HostBridgeQueuedComposerSend'
import type {
  HostBridgeQueuedComposerSendAdapterPort,
  HostBridgeQueuedComposerSendAuthorityPort
} from './HostBridgeQueuedComposerSend'
import type { HostBridgeActionPort } from './HostBridgeCommandExecutor'
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

function bridge(overrides: Partial<HostBridgeActionPort> = {}): HostBridgeActionPort {
  return {
    executeComposerPrompt: vi.fn(async () => ({ executed: true, message: 'sent' })),
    executeEnsembleSteer: vi.fn(async () => ({ executed: true, message: 'steered' })),
    executeCancelRun: vi.fn(),
    executeEnsembleCancelRound: vi.fn(),
    executeApprovalReply: vi.fn(),
    executeQuestionReply: vi.fn(),
    executeQuestionReject: vi.fn(),
    executeEnsembleRosterUpdate: vi.fn(),
    executeSetWatchedThread: vi.fn(),
    ...overrides
  } as unknown as HostBridgeActionPort
}

function resolvers(overrides: Record<string, unknown> = {}): {
  resolveComposerSend: ReturnType<typeof vi.fn>
} {
  return {
    resolveComposerSend: vi.fn(async () => ({
      ok: true,
      value: { mode: 'solo', workspaceId: 'workspace-1', provider: 'codex' }
    })),
    ...overrides
  }
}

function adapter(overrides: Partial<HostBridgeQueuedComposerSendAdapterPort> = {}): {
  register: ReturnType<typeof vi.fn>
  queued: ReturnType<typeof vi.fn>
  prepared: ReturnType<typeof vi.fn>
  settled: ReturnType<typeof vi.fn>
  beginShutdown: ReturnType<typeof vi.fn>
  drain: ReturnType<typeof vi.fn>
} {
  return {
    register: vi.fn(() => ({ kind: 'registered', view: {} })),
    queued: vi.fn(async () => ({ kind: 'applied', view: {} })),
    prepared: vi.fn(async () => ({ kind: 'applied', view: {} })),
    settled: vi.fn(async () => ({ kind: 'applied', view: {} })),
    beginShutdown: vi.fn(),
    drain: vi.fn(async () => undefined),
    ...overrides
  }
}

function authority(overrides: Partial<HostBridgeQueuedComposerSendAuthorityPort> = {}): {
  handleQueuedStartStarting: ReturnType<typeof vi.fn>
  handleQueuedStartDispatchSettled: ReturnType<typeof vi.fn>
  abortQueuedStart: ReturnType<typeof vi.fn>
} {
  return {
    handleQueuedStartStarting: vi.fn(),
    handleQueuedStartDispatchSettled: vi.fn(),
    abortQueuedStart: vi.fn(),
    ...overrides
  }
}

function build(overrides: {
  bridge?: Partial<HostBridgeActionPort>
  resolvers?: Record<string, unknown>
  adapter?: Partial<HostBridgeQueuedComposerSendAdapterPort>
  authority?: Partial<HostBridgeQueuedComposerSendAuthorityPort>
} = {}): {
  execute: ReturnType<typeof createHostBridgeQueuedComposerSend>
  bridgePort: HostBridgeActionPort
  adapterPort: ReturnType<typeof adapter>
  authorityPort: ReturnType<typeof authority>
} {
  const bridgePort = bridge(overrides.bridge)
  const adapterPort = adapter(overrides.adapter)
  const authorityPort = authority(overrides.authority)
  const execute = createHostBridgeQueuedComposerSend({
    bridge: bridgePort,
    resolvers: resolvers(overrides.resolvers) as never,
    adapter: adapterPort as never,
    authority: authorityPort as never
  })
  return { execute, bridgePort, adapterPort, authorityPort }
}

describe('HostBridgeQueuedComposerSend', () => {
  it('registers the Host↔Bridge correlation BEFORE any Bridge call', async () => {
    const order: string[] = []
    const { execute, bridgePort, adapterPort } = build({
      adapter: {
        register: vi.fn(() => {
          order.push('register')
          return { kind: 'registered', view: {} }
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

  it('maps a dispatched Bridge result to a prepared adapter event with the literal persist assertion', async () => {
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
    expect(adapterPort.prepared).toHaveBeenCalledWith({
      kind: 'prepared',
      hostCommandActionId: ACTION_ID,
      threadId: THREAD_ID,
      durablePromptAndStartPersisted: true,
      start: { kind: 'solo', runId: RUN_ID },
      effectRefs: [
        { family: 'run', entityId: RUN_ID },
        { family: 'thread', entityId: THREAD_ID }
      ]
    })
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

  it('R5: Bridge success with neither run identity nor queue reservation aborts once and never settles', async () => {
    const { execute, adapterPort, authorityPort } = build({
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({ executed: true, message: 'sent' }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('run_identity_unavailable')
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledTimes(1)
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledWith(COMMAND_ID)
    expect(authorityPort.handleQueuedStartDispatchSettled).not.toHaveBeenCalled()
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
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('bridge_adapter_threw')
    expect(authorityPort.abortQueuedStart).toHaveBeenCalledTimes(1)
    expect(authorityPort.handleQueuedStartDispatchSettled).not.toHaveBeenCalled()
    expect(adapterPort.settled).not.toHaveBeenCalled()
  })

  it('R5: without an abort port the unprovable case is refused as queued_start_unprovable', async () => {
    const { execute, adapterPort, authorityPort } = build({
      authority: { abortQueuedStart: undefined },
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({ executed: true, message: 'sent' }))
      }
    })
    const result = await execute(command(), context())
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('queued_start_unprovable')
    expect(authorityPort.handleQueuedStartDispatchSettled).not.toHaveBeenCalled()
    expect(adapterPort.settled).not.toHaveBeenCalled()
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

  it('never throws when the adapter event call throws', async () => {
    const { execute } = build({
      adapter: {
        prepared: vi.fn(async () => {
          throw new Error('adapter exploded')
        })
      },
      bridge: {
        executeComposerPrompt: vi.fn(async () => ({
          executed: true,
          message: 'sent',
          data: { appRunId: RUN_ID }
        }))
      }
    })
    await expect(execute(command(), context())).resolves.toEqual({
      status: 'succeeded',
      resultSummary: 'run_queued'
    })
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
    const handle = execute as unknown as { beginShutdown(): void }
    handle.beginShutdown()
    const result = await execute(command(), context())
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('shutting_down')
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
  })

  it('drain awaits the adapter drain', async () => {
    const { execute, adapterPort } = build()
    const handle = execute as unknown as { drain(): Promise<void> }
    await handle.drain()
    expect(adapterPort.drain).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-composer.send command without touching Bridge', async () => {
    const { execute, bridgePort } = build()
    const result = await execute(
      command({ name: 'run.cancel' as never }),
      context()
    )
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('not_governed_mutation')
    expect(bridgePort.executeComposerPrompt).not.toHaveBeenCalled()
  })
})
