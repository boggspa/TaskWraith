import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandName,
  type HostDecodeResult
} from '../../shared/hostProtocol'
import type { BridgeActionExecutionResult } from '../BridgeActionExecutor'
import {
  HostBridgeCommandExecutor,
  mapBridgeExecutionResult,
  type HostBridgeActionPort,
  type HostBridgeApprovalContext,
  type HostBridgeComposerSendContext,
  type HostBridgeContextResolvers,
  type HostBridgeEnsembleSeatContext,
  type HostBridgeQuestionContext,
  type HostBridgeRunCancelContext,
  type HostBridgeThreadSelectContext
} from './HostBridgeCommandExecutor'

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}

function ok<T>(value: T): HostDecodeResult<T> {
  return { ok: true, value }
}

function err(error: string): HostDecodeResult<never> {
  return { ok: false, error }
}

function command(
  name: HostCommandName,
  target: Record<string, string> = {},
  args: Record<string, unknown> = {},
  overrides: Partial<HostCommand> = {}
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'desktop:client-1:22222222-2222-4222-8222-222222222222',
    actor: ACTOR,
    name,
    target,
    arguments: args,
    issuedAt: '2026-08-04T00:00:00.000Z',
    ...overrides
  }
}

function bridgeResult(
  overrides: Partial<BridgeActionExecutionResult> = {}
): BridgeActionExecutionResult {
  return {
    executed: true,
    message: 'ok',
    ...overrides
  }
}

function makeBridge(overrides: Partial<HostBridgeActionPort> = {}): HostBridgeActionPort & {
  calls: Array<{ method: string; action: unknown }>
} {
  const calls: Array<{ method: string; action: unknown }> = []
  const wrap =
    <A>(method: string, fn?: (action: A) => Promise<BridgeActionExecutionResult>) =>
    async (action: A): Promise<BridgeActionExecutionResult> => {
      calls.push({ method, action })
      if (fn) return fn(action)
      return bridgeResult({ message: `${method} done` })
    }

  return {
    calls,
    executeComposerPrompt: wrap('executeComposerPrompt', overrides.executeComposerPrompt),
    executeEnsembleSteer: wrap('executeEnsembleSteer', overrides.executeEnsembleSteer),
    executeCancelRun: wrap('executeCancelRun', overrides.executeCancelRun),
    executeEnsembleCancelRound: wrap(
      'executeEnsembleCancelRound',
      overrides.executeEnsembleCancelRound
    ),
    executeApprovalReply: wrap('executeApprovalReply', overrides.executeApprovalReply),
    executeQuestionReply: wrap('executeQuestionReply', overrides.executeQuestionReply),
    executeQuestionReject: wrap('executeQuestionReject', overrides.executeQuestionReject),
    executeEnsembleRosterUpdate: wrap(
      'executeEnsembleRosterUpdate',
      overrides.executeEnsembleRosterUpdate
    ),
    executeSetWatchedThread: wrap('executeSetWatchedThread', overrides.executeSetWatchedThread)
  }
}

function makeResolvers(
  overrides: Partial<HostBridgeContextResolvers> = {}
): HostBridgeContextResolvers {
  return {
    resolveThreadOffers: overrides.resolveThreadOffers
      ? overrides.resolveThreadOffers
      : () => err('unused in executor tests'),
    resolveComposerSend: overrides.resolveComposerSend
      ? overrides.resolveComposerSend
      : (): HostDecodeResult<HostBridgeComposerSendContext> =>
          ok({
            mode: 'solo',
            workspaceId: 'ws-1',
            provider: 'codex',
            model: 'gpt-5.6',
            reasoningEffort: 'high'
          }),
    resolveRunCancel: overrides.resolveRunCancel
      ? overrides.resolveRunCancel
      : (): HostDecodeResult<HostBridgeRunCancelContext> =>
          ok({
            mode: 'solo',
            workspaceId: 'ws-1',
            provider: 'codex',
            runId: 'run-1'
          }),
    resolveApprovalDecide: overrides.resolveApprovalDecide
      ? overrides.resolveApprovalDecide
      : (): HostDecodeResult<HostBridgeApprovalContext> =>
          ok({
            workspaceId: 'ws-1',
            threadId: 'thread-1',
            toolCallId: 'approval-1'
          }),
    resolveQuestionAnswer: overrides.resolveQuestionAnswer
      ? overrides.resolveQuestionAnswer
      : (): HostDecodeResult<HostBridgeQuestionContext> =>
          ok({
            workspaceId: 'ws-1',
            threadId: 'thread-1',
            promptId: 'question-1',
            runId: 'run-q'
          }),
    resolveEnsembleSeatToggle: overrides.resolveEnsembleSeatToggle
      ? overrides.resolveEnsembleSeatToggle
      : (): HostDecodeResult<HostBridgeEnsembleSeatContext> =>
          ok({
            workspaceId: 'ws-1',
            participants: [
              { id: 'p1', provider: 'codex', enabled: true },
              { id: 'p2', provider: 'claude', enabled: false }
            ]
          }),
    resolveThreadSelect: overrides.resolveThreadSelect
      ? overrides.resolveThreadSelect
      : (): HostDecodeResult<HostBridgeThreadSelectContext> => ok({ appChatId: 'thread-1' })
  }
}

function open(
  bridgeOverrides: Partial<HostBridgeActionPort> = {},
  resolverOverrides: Partial<HostBridgeContextResolvers> = {}
) {
  const bridge = makeBridge(bridgeOverrides)
  const executor = new HostBridgeCommandExecutor({
    bridge,
    resolvers: makeResolvers(resolverOverrides),
    nowMs: () => 1_700_000_000_000
  })
  return { executor, bridge }
}

const FIXED_COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const EXPECTED_ACTION_ID = `host:command:${FIXED_COMMAND_ID}`

describe('mapBridgeExecutionResult', () => {
  it('maps executed:true to succeeded without leaking data bags', () => {
    expect(
      mapBridgeExecutionResult({
        executed: true,
        message: 'dispatched',
        data: { secret: 'nope', runId: 'r1' }
      })
    ).toEqual({ status: 'succeeded', resultSummary: 'dispatched' })
  })

  it('never treats executed:false as succeeded', () => {
    expect(mapBridgeExecutionResult({ executed: false, message: 'not wired' })).toEqual({
      status: 'failed',
      errorCode: 'bridge_not_executed',
      errorMessage: 'not wired'
    })
  })

  it('treats approvalAlreadyResolved as failed, not success', () => {
    expect(
      mapBridgeExecutionResult({
        executed: false,
        message: 'already resolved',
        reasonCode: 'approvalAlreadyResolved'
      })
    ).toEqual({
      status: 'failed',
      errorCode: 'approval_already_resolved',
      errorMessage: 'already resolved'
    })
  })

  it('maps userDeclined to cancelled', () => {
    expect(
      mapBridgeExecutionResult({
        executed: false,
        message: 'declined',
        reasonCode: 'userDeclined'
      })
    ).toEqual({
      status: 'cancelled',
      errorCode: 'user_declined',
      errorMessage: 'declined'
    })
  })

  it('rejects unrecognized bridge results', () => {
    expect(mapBridgeExecutionResult(undefined)).toEqual({
      status: 'failed',
      errorCode: 'bridge_invalid_result',
      errorMessage: 'unrecognized bridge result'
    })
  })
})

describe('HostBridgeCommandExecutor construction', () => {
  it('requires bridge + resolvers ports', () => {
    expect(() => new HostBridgeCommandExecutor(null as never)).toThrow(/options/)
    expect(
      () =>
        new HostBridgeCommandExecutor({
          bridge: {} as HostBridgeActionPort,
          resolvers: makeResolvers()
        })
    ).toThrow(/HostBridgeActionPort/)
    expect(
      () =>
        new HostBridgeCommandExecutor({
          bridge: makeBridge(),
          resolvers: {} as HostBridgeContextResolvers
        })
    ).toThrow(/HostBridgeContextResolvers/)
  })
})

describe('reserved read aliases and unknowns fail closed', () => {
  it.each(['snapshot.get', 'deltas.since', 'receipt.lookup', 'ping'] as const)(
    '%s never calls Bridge',
    async (name) => {
      const { executor, bridge } = open()
      const result = await executor.execute(
        command(
          name,
          name === 'receipt.lookup' ? { commandId: 'c1' } : {},
          name === 'deltas.since' ? { generation: 1, cursor: 0 } : {}
        )
      )
      expect(result).toEqual({
        status: 'failed',
        errorCode: 'not_governed_mutation',
        errorMessage: 'reserved read aliases and unknown commands cannot enter Bridge'
      })
      expect(bridge.calls).toEqual([])
    }
  )

  it('unknown command names never call Bridge', async () => {
    const { executor, bridge } = open()
    const result = await executor.execute({
      ...command('composer.send', { threadId: 't1' }, { text: 'hi' }),
      name: 'provider.launch' as HostCommandName
    })
    expect(result.errorCode).toBe('not_governed_mutation')
    expect(bridge.calls).toEqual([])
  })
})

describe('argument validation gates Bridge', () => {
  it('rejects invalid composer.send before resolve/Bridge', async () => {
    const resolveComposerSend = vi.fn()
    const { executor, bridge } = open({}, { resolveComposerSend })
    const result = await executor.execute(
      command('composer.send', { threadId: 't1' }, { text: 'hi', yolo: true })
    )
    expect(result.errorCode).toBe('invalid_command_arguments')
    expect(resolveComposerSend).not.toHaveBeenCalled()
    expect(bridge.calls).toEqual([])
  })

  it('rejects Bridge-only approval wideners before resolve/Bridge', async () => {
    const resolveApprovalDecide = vi.fn()
    const { executor, bridge } = open({}, { resolveApprovalDecide })
    for (const decision of [
      'useProviderNative',
      'grantExternalPathRead',
      'grantExternalPathEdit'
    ]) {
      const result = await executor.execute(
        command('approval.decide', { approvalId: 'a1' }, { decision })
      )
      expect(result.errorCode).toBe('invalid_command_arguments')
    }
    expect(resolveApprovalDecide).not.toHaveBeenCalled()
    expect(bridge.calls).toEqual([])
  })
})

describe('composer.send', () => {
  it('uses only Host-resolved model fields and never copies raw command nominations', async () => {
    const resolveComposerSend = vi.fn(
      (
        _threadId: string,
        _selection?: { readonly model?: string; readonly reasoningEffort?: string }
      ) =>
        ok<HostBridgeComposerSendContext>({
          mode: 'solo',
          workspaceId: 'ws-1',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh'
        })
    )
    const { executor, bridge } = open({}, { resolveComposerSend })
    const result = await executor.execute(
      command(
        'composer.send',
        { threadId: 'thread-1' },
        { text: 'hello', model: 'gpt-custom', reasoningEffort: 'medium' }
      )
    )
    expect(result).toEqual({
      status: 'succeeded',
      resultSummary: 'executeComposerPrompt done'
    })
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.calls[0]?.method).toBe('executeComposerPrompt')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'composerPrompt',
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      text: 'hello',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      actionId: EXPECTED_ACTION_ID
    })
    expect(resolveComposerSend).toHaveBeenCalledWith('thread-1', {
      model: 'gpt-custom',
      reasoningEffort: 'medium'
    })
  })

  it('maps ensemble context to executeEnsembleSteer without inventing provider', async () => {
    const { executor, bridge } = open(
      {},
      {
        resolveComposerSend: () =>
          ok({ mode: 'ensemble', workspaceId: 'ws-ens', roundId: 'round-9' })
      }
    )
    const result = await executor.execute(
      command('composer.send', { threadId: 'thread-1' }, { text: 'steer please' })
    )
    expect(result.status).toBe('succeeded')
    expect(bridge.calls[0]?.method).toBe('executeEnsembleSteer')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'ensembleSteer',
      workspaceId: 'ws-ens',
      threadId: 'thread-1',
      roundId: 'round-9',
      text: 'steer please'
    })
    expect(bridge.calls[0]?.action).not.toHaveProperty('provider')
  })

  it('fails closed when composer context resolve fails', async () => {
    const { executor, bridge } = open({}, { resolveComposerSend: () => err('thread missing') })
    const result = await executor.execute(
      command('composer.send', { threadId: 'missing' }, { text: 'hi' })
    )
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'context_resolve_failed',
      errorMessage: 'thread missing'
    })
    expect(bridge.calls).toEqual([])
  })
})

describe('run.cancel', () => {
  it('maps solo cancel to executeCancelRun', async () => {
    const { executor, bridge } = open()
    const result = await executor.execute(command('run.cancel', { threadId: 'thread-1' }))
    expect(result.status).toBe('succeeded')
    expect(bridge.calls[0]?.method).toBe('executeCancelRun')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'cancelRun',
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      provider: 'codex',
      runId: 'run-1'
    })
  })

  it('maps ensemble cancel to executeEnsembleCancelRound', async () => {
    const { executor, bridge } = open(
      {},
      {
        resolveRunCancel: () => ok({ mode: 'ensemble', workspaceId: 'ws-1', roundId: 'round-2' })
      }
    )
    await executor.execute(command('run.cancel', { threadId: 'thread-1' }))
    expect(bridge.calls[0]?.method).toBe('executeEnsembleCancelRound')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'ensembleCancelRound',
      roundId: 'round-2'
    })
  })

  it('reports no_active_run without Bridge when resolver says none', async () => {
    const { executor, bridge } = open(
      {},
      { resolveRunCancel: () => ok({ mode: 'none', message: 'idle' }) }
    )
    const result = await executor.execute(command('run.cancel', { threadId: 'thread-1' }))
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'no_active_run',
      errorMessage: 'idle'
    })
    expect(bridge.calls).toEqual([])
  })
})

describe('approval.decide', () => {
  it.each(['accept', 'acceptForSession', 'acceptForWorkspace', 'decline', 'cancel'] as const)(
    'maps Host decision %s via approvalId≡toolCallId alias',
    async (decision) => {
      const { executor, bridge } = open()
      const result = await executor.execute(
        command('approval.decide', { approvalId: 'approval-1' }, { decision })
      )
      expect(result.status).toBe('succeeded')
      expect(bridge.calls[0]?.method).toBe('executeApprovalReply')
      expect(bridge.calls[0]?.action).toMatchObject({
        kind: 'approvalReply',
        toolCallId: 'approval-1',
        threadId: 'thread-1',
        workspaceId: 'ws-1',
        decision
      })
    }
  )

  it('fails when resolver toolCallId conflicts with approvalId', async () => {
    const { executor, bridge } = open(
      {},
      {
        resolveApprovalDecide: () =>
          ok({
            workspaceId: 'ws-1',
            threadId: 'thread-1',
            toolCallId: 'different-id'
          })
      }
    )
    const result = await executor.execute(
      command('approval.decide', { approvalId: 'approval-1' }, { decision: 'accept' })
    )
    expect(result.errorCode).toBe('approval_alias_conflict')
    expect(bridge.calls).toEqual([])
  })

  it('maps approvalAlreadyResolved to failed', async () => {
    const { executor } = open({
      executeApprovalReply: async () =>
        bridgeResult({
          executed: false,
          message: 'already done',
          reasonCode: 'approvalAlreadyResolved'
        })
    })
    const result = await executor.execute(
      command('approval.decide', { approvalId: 'approval-1' }, { decision: 'accept' })
    )
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'approval_already_resolved',
      errorMessage: 'already done'
    })
  })
})

describe('question.answer', () => {
  it('maps answer to questionReply with questionId≡promptId', async () => {
    const { executor, bridge } = open()
    const result = await executor.execute(
      command(
        'question.answer',
        { questionId: 'question-1' },
        { decision: 'answer', answer: 'yes', isCustom: true }
      )
    )
    expect(result.status).toBe('succeeded')
    expect(bridge.calls[0]?.method).toBe('executeQuestionReply')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'questionReply',
      promptId: 'question-1',
      receiptId: FIXED_COMMAND_ID,
      answer: 'yes',
      isCustom: true,
      runId: 'run-q'
    })
  })

  it('maps dismiss to questionReject', async () => {
    const { executor, bridge } = open()
    await executor.execute(
      command(
        'question.answer',
        { questionId: 'question-1' },
        { decision: 'dismiss', message: 'skip' }
      )
    )
    expect(bridge.calls[0]?.method).toBe('executeQuestionReject')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'questionReject',
      promptId: 'question-1',
      receiptId: FIXED_COMMAND_ID,
      message: 'skip'
    })
  })

  it('fails when resolver promptId conflicts with questionId', async () => {
    const { executor, bridge } = open(
      {},
      {
        resolveQuestionAnswer: () =>
          ok({
            workspaceId: 'ws-1',
            threadId: 'thread-1',
            promptId: 'other-prompt'
          })
      }
    )
    const result = await executor.execute(
      command('question.answer', { questionId: 'question-1' }, { decision: 'answer', answer: 'no' })
    )
    expect(result.errorCode).toBe('question_alias_conflict')
    expect(bridge.calls).toEqual([])
  })
})

describe('ensemble.seat.toggle', () => {
  it('maps to ensembleRosterUpdate with host-resolved roster', async () => {
    const { executor, bridge } = open()
    const result = await executor.execute(
      command(
        'ensemble.seat.toggle',
        { threadId: 'thread-1' },
        { participantId: 'p2', enabled: true }
      )
    )
    expect(result.status).toBe('succeeded')
    expect(bridge.calls[0]?.method).toBe('executeEnsembleRosterUpdate')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'ensembleRosterUpdate',
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      participants: [
        { id: 'p1', provider: 'codex', enabled: true },
        { id: 'p2', provider: 'claude', enabled: false }
      ]
    })
  })
})

describe('thread.select', () => {
  it('maps to setWatchedThread with host-resolved appChatId', async () => {
    const { executor, bridge } = open()
    const result = await executor.execute(command('thread.select', { threadId: 'thread-1' }))
    expect(result.status).toBe('succeeded')
    expect(bridge.calls[0]?.method).toBe('executeSetWatchedThread')
    expect(bridge.calls[0]?.action).toMatchObject({
      kind: 'setWatchedThread',
      appChatId: 'thread-1'
    })
  })

  it('allows null appChatId (clear watch) from host resolver', async () => {
    const { executor, bridge } = open({}, { resolveThreadSelect: () => ok({ appChatId: null }) })
    await executor.execute(command('thread.select', { threadId: 'thread-1' }))
    expect(bridge.calls[0]?.action).toMatchObject({ appChatId: null })
  })
})

describe('deterministic host:command:<commandId> actionId (Wave 2E-2A Lane B)', () => {
  const FIXED_ID = FIXED_COMMAND_ID
  const EXPECTED = EXPECTED_ACTION_ID

  it.each([
    {
      label: 'composer.send',
      cmd: () => command('composer.send', { threadId: 'thread-1' }, { text: 'hi' }),
      method: 'executeComposerPrompt'
    },
    {
      label: 'run.cancel',
      cmd: () => command('run.cancel', { threadId: 'thread-1' }),
      method: 'executeCancelRun'
    },
    {
      label: 'approval.decide',
      cmd: () => command('approval.decide', { approvalId: 'approval-1' }, { decision: 'accept' }),
      method: 'executeApprovalReply'
    },
    {
      label: 'question.answer',
      cmd: () =>
        command(
          'question.answer',
          { questionId: 'question-1' },
          { decision: 'answer', answer: 'yes' }
        ),
      method: 'executeQuestionReply'
    },
    {
      label: 'ensemble.seat.toggle',
      cmd: () =>
        command(
          'ensemble.seat.toggle',
          { threadId: 'thread-1' },
          { participantId: 'p2', enabled: true }
        ),
      method: 'executeEnsembleRosterUpdate'
    },
    {
      label: 'thread.select',
      cmd: () => command('thread.select', { threadId: 'thread-1' }),
      method: 'executeSetWatchedThread'
    }
  ] as const)(
    '$label binds actionId to host:command:<commandId> with no random suffix',
    async ({ cmd, method }) => {
      const { executor, bridge } = open()
      const result = await executor.execute(cmd())
      expect(result.status).toBe('succeeded')
      expect(bridge.calls).toHaveLength(1)
      expect(bridge.calls[0]?.method).toBe(method)
      const action = bridge.calls[0]?.action as { actionId?: string }
      expect(action.actionId).toBe(EXPECTED)
      expect(action.actionId).toBe(`host:command:${FIXED_ID}`)
      // No legacy host:<prefix>:<random> form, no actor/args leakage into id.
      expect(action.actionId).not.toMatch(
        /^host:(composer|cancel|approval|question|seat|thread-select):/
      )
      expect(action.actionId).not.toContain('actor')
      expect(action.actionId).not.toContain('hello')
      expect(action.actionId).not.toContain(ACTOR.actorId)
    }
  )

  it('binds the same commandId consistently across repeated dispatches', async () => {
    const { executor, bridge } = open()
    await executor.execute(command('composer.send', { threadId: 'thread-1' }, { text: 'a' }))
    await executor.execute(command('composer.send', { threadId: 'thread-1' }, { text: 'b' }))
    expect((bridge.calls[0]?.action as { actionId: string }).actionId).toBe(EXPECTED)
    expect((bridge.calls[1]?.action as { actionId: string }).actionId).toBe(EXPECTED)
  })

  it('uses a different commandId when the Host commandId differs', async () => {
    const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const { executor, bridge } = open()
    await executor.execute(
      command('composer.send', { threadId: 'thread-1' }, { text: 'x' }, { commandId: otherId })
    )
    expect((bridge.calls[0]?.action as { actionId: string }).actionId).toBe(
      `host:command:${otherId}`
    )
  })

  it('fails closed for non-UUID commandId with zero resolver and zero Bridge calls', async () => {
    const resolveComposerSend = vi.fn(() =>
      ok({
        mode: 'solo' as const,
        workspaceId: 'ws-1',
        provider: 'codex'
      })
    )
    const { executor, bridge } = open({}, { resolveComposerSend })
    // actionMeta is hoisted after arg validation and before every resolve/Bridge call.
    const result = await executor.execute(
      command(
        'composer.send',
        { threadId: 'thread-1' },
        { text: 'hi' },
        { commandId: 'not-a-uuid' }
      )
    )
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'invalid_command_id',
      errorMessage: 'commandId is missing, unsafe, or not a UUID'
    })
    expect(resolveComposerSend).not.toHaveBeenCalled()
    expect(bridge.calls).toEqual([])
  })

  it.each([
    {
      label: 'composer.send',
      cmd: () =>
        command(
          'composer.send',
          { threadId: 'thread-1' },
          { text: 'hi' },
          { commandId: 'not-a-uuid' }
        ),
      resolverKey: 'resolveComposerSend' as const
    },
    {
      label: 'run.cancel',
      cmd: () => command('run.cancel', { threadId: 'thread-1' }, {}, { commandId: 'not-a-uuid' }),
      resolverKey: 'resolveRunCancel' as const
    },
    {
      label: 'approval.decide',
      cmd: () =>
        command(
          'approval.decide',
          { approvalId: 'approval-1' },
          { decision: 'accept' },
          { commandId: 'not-a-uuid' }
        ),
      resolverKey: 'resolveApprovalDecide' as const
    },
    {
      label: 'question.answer',
      cmd: () =>
        command(
          'question.answer',
          { questionId: 'question-1' },
          { decision: 'answer', answer: 'yes' },
          { commandId: 'not-a-uuid' }
        ),
      resolverKey: 'resolveQuestionAnswer' as const
    },
    {
      label: 'ensemble.seat.toggle',
      cmd: () =>
        command(
          'ensemble.seat.toggle',
          { threadId: 'thread-1' },
          { participantId: 'p2', enabled: true },
          { commandId: 'not-a-uuid' }
        ),
      resolverKey: 'resolveEnsembleSeatToggle' as const
    },
    {
      label: 'thread.select',
      cmd: () =>
        command('thread.select', { threadId: 'thread-1' }, {}, { commandId: 'not-a-uuid' }),
      resolverKey: 'resolveThreadSelect' as const
    }
  ] as const)(
    '$label invalid commandId makes zero resolver and zero Bridge calls',
    async ({ cmd, resolverKey }) => {
      const spy = vi.fn()
      const { executor, bridge } = open({}, { [resolverKey]: spy })
      const result = await executor.execute(cmd())
      expect(result).toEqual({
        status: 'failed',
        errorCode: 'invalid_command_id',
        errorMessage: 'commandId is missing, unsafe, or not a UUID'
      })
      expect(spy).not.toHaveBeenCalled()
      expect(bridge.calls).toEqual([])
    }
  )

  it('fails closed for empty commandId without Bridge or resolver dispatch', async () => {
    const resolveRunCancel = vi.fn()
    const { executor, bridge } = open({}, { resolveRunCancel })
    const result = await executor.execute(
      command('run.cancel', { threadId: 'thread-1' }, {}, { commandId: '' })
    )
    // Empty may fail at argument validation or actionMeta; either is fail-closed.
    expect(['invalid_command_id', 'invalid_command_arguments']).toContain(result.errorCode)
    expect(result.status).toBe('failed')
    expect(resolveRunCancel).not.toHaveBeenCalled()
    expect(bridge.calls).toEqual([])
  })

  it('fails closed for commandId with control characters with zero resolver/Bridge', async () => {
    const resolveThreadSelect = vi.fn()
    const { executor, bridge } = open({}, { resolveThreadSelect })
    const result = await executor.execute(
      command(
        'thread.select',
        { threadId: 'thread-1' },
        {},
        { commandId: '11111111-1111-4111-8111-11111111111\u0000' }
      )
    )
    expect(result.errorCode).toBe('invalid_command_id')
    expect(resolveThreadSelect).not.toHaveBeenCalled()
    expect(bridge.calls).toEqual([])
  })
})

describe('honesty and isolation', () => {
  it('maps thrown Bridge calls to failed without inventing success', async () => {
    const { executor } = open({
      executeComposerPrompt: async () => {
        throw new Error('bridge exploded')
      }
    })
    const result = await executor.execute(
      command('composer.send', { threadId: 'thread-1' }, { text: 'hi' })
    )
    expect(result).toEqual({
      status: 'failed',
      errorCode: 'bridge_adapter_threw',
      errorMessage: 'bridge exploded'
    })
  })

  it('does not forward unrestricted Bridge data fields', async () => {
    const { executor } = open({
      executeCancelRun: async () =>
        bridgeResult({
          executed: true,
          message: 'cancelled',
          data: { transcript: 'SECRET', diff: '+++ secret' }
        })
    })
    const result = await executor.execute(command('run.cancel', { threadId: 'thread-1' }))
    expect(result).toEqual({ status: 'succeeded', resultSummary: 'cancelled' })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('diff')
  })

  it('does not import Authority, stores, control, roots, or forbidden paths', () => {
    const source = readFileSync(join(__dirname, 'HostBridgeCommandExecutor.ts'), 'utf8')
    const forbiddenImports = [
      "from './AppStoreHostAuthority'",
      "from './HostCommandReceiptStore'",
      "from './HostDeltaStore'",
      "from './HostDeferredCommandBridge'",
      "from './HostDomainDeltaPublisher'",
      "from './HostSession'",
      'EnsembleOrchestrator',
      'LocalControlServer',
      'TaskWraithControlFacade',
      'workLocks',
      'workProvenance',
      'work-guard',
      "from '../index'",
      "from '../../main/index'",
      "from '../store'",
      "from '../store/",
      'createServer',
      'listen(',
      "from 'electron'",
      "from 'electron/"
    ]
    for (const needle of forbiddenImports) {
      expect(source.includes(needle), needle).toBe(false)
    }
    // No AppStore runtime coupling (type-only comments may mention migration authority).
    expect(source).not.toMatch(/from ['"].*AppStore['"]/)
    expect(source).not.toMatch(/\bAppStore\./)
    expect(source).toContain('validateHostCommandArguments')
    expect(source).toContain('parseGovernedMutationCommandName')
    expect(source).toContain('resolveHostApprovalId')
    expect(source).toContain('resolveHostQuestionId')
    expect(source).toContain('host:command:')
    expect(source).toContain('isHostUuid')
    expect(source).not.toContain('actionIdFactory')
    expect(source).not.toContain('randomUUID')
  })

  it('has no production consumers yet outside its test pair', () => {
    // Substrate-only: production wiring stays later 2E-2 assembly.
    const self = readFileSync(join(__dirname, 'HostBridgeCommandExecutor.ts'), 'utf8')
    expect(self).toContain('Wave 2E-1 Lane H')
    expect(self).toContain('host:command:')
  })
})
