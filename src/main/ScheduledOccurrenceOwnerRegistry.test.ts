import { describe, expect, it } from 'vitest'
import type { ProviderId, ScheduledOccurrenceRootOwner, ScheduledTask } from './store/types'
import {
  createScheduledOccurrenceOwner,
  deriveScheduledWorkflowOccurrence,
  ScheduledOccurrenceOwnerRegistry,
  ScheduledOccurrenceOwnerRegistryError,
  type ScheduledOccurrenceOwner
} from './ScheduledOccurrenceOwnerRegistry'

const PLANNED_FOR = '2026-07-15T10:00:00.000Z'

function task(
  overrides: Partial<ScheduledTask> = {},
  rootOwner: ScheduledOccurrenceRootOwner = 'solo'
): ScheduledTask {
  return {
    id: 'task-one',
    workspaceId: 'workspace-one',
    workspacePath: '/Users/test/one',
    chatId: 'chat-one',
    provider: 'codex',
    prompt: 'Run the workflow.',
    selectedModelType: 'default',
    customModel: '',
    approvalMode: 'plan',
    sessionTrust: false,
    imageAttachments: [],
    runAt: PLANNED_FOR,
    timezone: 'UTC',
    status: 'running',
    createdAt: PLANNED_FOR,
    updatedAt: PLANNED_FOR,
    runId: 'run-one',
    kind: rootOwner === 'ensemble-root' ? 'ensemble' : 'single',
    ...overrides
  }
}

function owner(
  suffix: string,
  overrides: Partial<ScheduledOccurrenceOwner> = {}
): ScheduledOccurrenceOwner {
  const provider = (overrides.provider ?? 'codex') as ProviderId
  return createScheduledOccurrenceOwner(
    task({
      id: `task-${suffix}`,
      runId: `run-${suffix}`,
      chatId: `chat-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      workspacePath: `/Users/test/${suffix}`,
      provider,
      kind: overrides.rootOwner === 'ensemble-root' ? 'ensemble' : 'single'
    }),
    overrides.rootOwner ?? 'solo'
  )
}

function expectCode(
  action: () => unknown,
  code: ScheduledOccurrenceOwnerRegistryError['code']
): void {
  try {
    action()
    throw new Error(`Expected ScheduledOccurrenceOwnerRegistryError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduledOccurrenceOwnerRegistryError)
    expect((error as ScheduledOccurrenceOwnerRegistryError).code).toBe(code)
  }
}

describe('ScheduledOccurrenceOwnerRegistry', () => {
  it('rejects partial workflow linkage and freezes an exact complete tuple', () => {
    expectCode(
      () => deriveScheduledWorkflowOccurrence(task({ workflowId: 'workflow-one' })),
      'partial-workflow-linkage'
    )

    const exact = deriveScheduledWorkflowOccurrence(
      task({
        workflowId: 'workflow-one',
        workflowExecutionId: 'execution-one',
        workflowOccurrenceAt: PLANNED_FOR
      })
    )
    expect(exact).toEqual({
      workflowId: 'workflow-one',
      executionId: 'execution-one',
      plannedFor: PLANNED_FOR,
      taskId: 'task-one'
    })
    expect(Object.isFrozen(exact)).toBe(true)
  })

  it('constructs only immutable, claimed owners with matching root kinds', () => {
    expectCode(
      () => createScheduledOccurrenceOwner(task({ status: 'due' }), 'solo'),
      'invalid-task-state'
    )
    expectCode(
      () => createScheduledOccurrenceOwner(task({ kind: 'single' }), 'ensemble-root'),
      'owner-kind-mismatch'
    )

    const created = createScheduledOccurrenceOwner(task(), 'solo')
    expect(created.ownerRunId).toBe('run-one')
    expect(Object.isFrozen(created)).toBe(true)
  })

  it('rejects duplicate live task and run ownership', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const first = registry.register(owner('first'))
    expectCode(
      () => registry.register({ ...owner('second'), taskId: first.taskId }),
      'duplicate-task'
    )
    expectCode(
      () => registry.register({ ...owner('third'), ownerRunId: first.ownerRunId }),
      'duplicate-run'
    )
  })

  it('makes scheduled and ordinary chat reservations mutually exclusive', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const reservation = registry.reserveOrdinaryChatDispatch('chat-reserved')

    expect(registry.hasOrdinaryChatDispatchReservation('chat-reserved')).toBe(true)
    expectCode(
      () => registry.register({ ...owner('scheduled'), chatId: 'chat-reserved' }),
      'duplicate-chat'
    )
    expect(registry.releaseOrdinaryChatDispatch({ ...reservation })).toBe(false)
    expect(registry.releaseOrdinaryChatDispatch(reservation)).toBe(true)

    const scheduled = registry.register({ ...owner('scheduled'), chatId: 'chat-reserved' })
    expect(registry.lookupByChatId('chat-reserved')).toBe(scheduled)
    expectCode(() => registry.reserveOrdinaryChatDispatch('chat-reserved'), 'duplicate-chat')
    expect(registry.release(scheduled)).toBe(true)
    expect(registry.lookupByChatId('chat-reserved')).toBeUndefined()
  })

  it('keeps concurrent ordinary reservations independently live on one chat', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const first = registry.reserveOrdinaryChatDispatch('chat-fanout')
    const second = registry.reserveOrdinaryChatDispatch('chat-fanout')

    expect(second).not.toBe(first)
    expect(registry.hasOrdinaryChatDispatchReservation('chat-fanout')).toBe(true)
    expectCode(
      () => registry.register({ ...owner('scheduled'), chatId: 'chat-fanout' }),
      'duplicate-chat'
    )

    expect(registry.releaseOrdinaryChatDispatch(first)).toBe(true)
    expect(registry.releaseOrdinaryChatDispatch(first)).toBe(false)
    expect(registry.hasOrdinaryChatDispatchReservation('chat-fanout')).toBe(true)
    expectCode(
      () => registry.register({ ...owner('scheduled'), chatId: 'chat-fanout' }),
      'duplicate-chat'
    )

    expect(registry.releaseOrdinaryChatDispatch(second)).toBe(true)
    expect(registry.hasOrdinaryChatDispatchReservation('chat-fanout')).toBe(false)
    const scheduled = registry.register({ ...owner('scheduled'), chatId: 'chat-fanout' })
    expect(registry.lookupByChatId('chat-fanout')).toBe(scheduled)
  })

  it('lets graph lanes overlap their parent turn and sibling graph lanes', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const parent = registry.reserveOrdinaryChatDispatch('chat-ultratask')
    const firstScout = registry.reserveConcurrentGraphChatDispatch('chat-ultratask')
    const secondScout = registry.reserveConcurrentGraphChatDispatch('chat-ultratask')

    expect(registry.hasOrdinaryChatDispatchReservation('chat-ultratask')).toBe(true)
    expect(registry.hasConcurrentGraphChatDispatchReservation('chat-ultratask')).toBe(true)
    expectCode(
      () => registry.register({ ...owner('scheduled'), chatId: 'chat-ultratask' }),
      'duplicate-chat'
    )
    expectCode(() => registry.reserveExclusiveChatDispatch('chat-ultratask'), 'duplicate-chat')

    expect(registry.releaseConcurrentGraphChatDispatch(firstScout)).toBe(true)
    expect(registry.hasConcurrentGraphChatDispatchReservation('chat-ultratask')).toBe(true)
    expect(registry.releaseOrdinaryChatDispatch(parent)).toBe(true)
    // A later ordinary parent turn may also coexist with the durable graph.
    const continuedParent = registry.reserveOrdinaryChatDispatch('chat-ultratask')
    expect(registry.releaseConcurrentGraphChatDispatch(secondScout)).toBe(true)
    expect(registry.hasConcurrentGraphChatDispatchReservation('chat-ultratask')).toBe(false)
    expect(registry.releaseOrdinaryChatDispatch(continuedParent)).toBe(true)

    const scheduled = registry.register({ ...owner('scheduled'), chatId: 'chat-ultratask' })
    expectCode(
      () => registry.reserveConcurrentGraphChatDispatch('chat-ultratask'),
      'duplicate-chat'
    )
    expect(registry.release(scheduled)).toBe(true)
  })

  it('uses an exclusive pre-session reservation to fence every competing launch', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const exclusive = registry.reserveExclusiveChatDispatch('chat-graph')

    expect(registry.hasExclusiveChatDispatchReservation('chat-graph')).toBe(true)
    expectCode(() => registry.reserveOrdinaryChatDispatch('chat-graph'), 'duplicate-chat')
    expectCode(() => registry.reserveConcurrentGraphChatDispatch('chat-graph'), 'duplicate-chat')
    expectCode(() => registry.reserveExclusiveChatDispatch('chat-graph'), 'duplicate-chat')
    expectCode(
      () => registry.register({ ...owner('scheduled'), chatId: 'chat-graph' }),
      'duplicate-chat'
    )
    expect(registry.releaseExclusiveChatDispatch({ ...exclusive })).toBe(false)
    expect(registry.releaseExclusiveChatDispatch(exclusive)).toBe(true)
    expect(registry.hasExclusiveChatDispatchReservation('chat-graph')).toBe(false)

    const ordinary = registry.reserveOrdinaryChatDispatch('chat-graph')
    expectCode(() => registry.reserveExclusiveChatDispatch('chat-graph'), 'duplicate-chat')
    expect(registry.releaseOrdinaryChatDispatch(ordinary)).toBe(true)

    const scheduled = registry.register({ ...owner('scheduled'), chatId: 'chat-graph' })
    expectCode(() => registry.reserveExclusiveChatDispatch('chat-graph'), 'duplicate-chat')
    expect(registry.release(scheduled)).toBe(true)
  })

  it('requires exact provider and chat identity for solo exit lookup', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const registered = registry.register(owner('solo'))

    expect(
      registry.lookupSoloExit({
        appRunId: registered.ownerRunId,
        provider: 'claude',
        chatId: registered.chatId
      })
    ).toBeUndefined()
    expect(
      registry.lookupSoloExit({
        appRunId: registered.ownerRunId,
        provider: registered.provider,
        chatId: 'chat-other'
      })
    ).toBeUndefined()
    expect(
      registry.lookupSoloExit({
        appRunId: registered.ownerRunId,
        provider: registered.provider,
        chatId: registered.chatId
      })
    ).toBe(registered)
  })

  it('binds one unique ensemble round and releases only the exact live owner', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const ensemble = registry.register(owner('ensemble', { rootOwner: 'ensemble-root' }))
    registry.bindEnsembleRound('round-one', ensemble.ownerRunId)

    expectCode(
      () => registry.bindEnsembleRound('round-one', ensemble.ownerRunId),
      'duplicate-round'
    )
    expectCode(
      () => registry.bindEnsembleRound('round-two', ensemble.ownerRunId),
      'duplicate-round'
    )
    expect(registry.lookupEnsembleRound('round-one')).toBe(ensemble)
    expect(registry.wasEnsembleRoundIdObserved('round-one')).toBe(true)
    expect(registry.lookupEnsembleRoundIdForOwner(ensemble)).toBe('round-one')
    expect(registry.release({ ...ensemble })).toBe(false)
    expect(registry.release(ensemble)).toBe(true)
    expect(registry.release(ensemble)).toBe(false)
    expect(registry.lookupEnsembleRound('round-one')).toBeUndefined()
    expect(registry.wasEnsembleRoundIdObserved('round-one')).toBe(true)
    expect(registry.isAppRunIdLiveOwned(ensemble.ownerRunId)).toBe(false)
  })

  it('binds ensemble children to their exact round and tombstones them after release', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const ensemble = registry.register(owner('ensemble-child', { rootOwner: 'ensemble-root' }))
    registry.bindEnsembleRound('round-child', ensemble.ownerRunId)

    expect(registry.bindEnsembleChildRun('child-ensemble', 'round-child', 'claude')).toBe(ensemble)
    expect(registry.lookupEnsembleChildRun('child-ensemble', 'claude')).toBe(ensemble)
    expect(registry.lookupEnsembleChildRun('child-ensemble', 'codex')).toBeUndefined()
    expect(registry.isAppRunIdLiveOwned('child-ensemble')).toBe(true)

    expect(registry.release(ensemble)).toBe(true)
    expect(registry.lookupEnsembleChildRun('child-ensemble', 'claude')).toBeUndefined()
    expect(registry.isAppRunIdLiveOwned('child-ensemble')).toBe(false)
    expect(registry.wasChildRunIdObserved('child-ensemble')).toBe(true)
    expectCode(
      () => registry.register({ ...owner('replacement'), ownerRunId: 'child-ensemble' }),
      'duplicate-run'
    )
  })

  it('binds loop children only to a live loop root and releases every child with it', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const loop = registry.register(owner('loop', { rootOwner: 'loop-root' }))

    expectCode(
      () => registry.bindLoopChildRun('child-wrong-owner', owner('solo').ownerRunId, 'codex'),
      'owner-kind-mismatch'
    )
    expect(registry.bindLoopChildRun('child-one', loop.ownerRunId, 'claude')).toBe(loop)
    expect(registry.bindLoopChildRun('child-two', loop.ownerRunId, 'codex')).toBe(loop)
    expect(registry.lookupLoopChildRun('child-one', 'claude')).toBe(loop)
    expect(registry.lookupLoopChildRun('child-one', 'codex')).toBeUndefined()
    expect(registry.lookupChildRunIdsForOwner(loop)).toEqual(['child-one', 'child-two'])
    expect(Object.isFrozen(registry.lookupChildRunIdsForOwner(loop))).toBe(true)
    expect(registry.isAppRunIdLiveOwned('child-one')).toBe(true)
    expectCode(
      () => registry.bindLoopChildRun('child-one', loop.ownerRunId, 'claude'),
      'duplicate-child-run'
    )

    expect(registry.release(loop)).toBe(true)
    expect(registry.lookupLoopChildRun('child-one', 'claude')).toBeUndefined()
    expect(registry.lookupChildRunIdsForOwner(loop)).toEqual([])
    expect(registry.isAppRunIdLiveOwned('child-one')).toBe(false)
    expect(registry.wasChildRunIdObserved('child-one')).toBe(true)
    expectCode(
      () => registry.bindLoopChildRun('child-one', loop.ownerRunId, 'claude'),
      'owner-kind-mismatch'
    )
  })

  it('looks up a solo exit without consuming settlement authority', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const solo = registry.register(owner('solo'))
    const exit = {
      appRunId: solo.ownerRunId,
      provider: solo.provider,
      chatId: solo.chatId
    }

    expect(registry.isAppRunIdLiveOwned(solo.ownerRunId)).toBe(true)
    expect(registry.lookupSoloExit(exit)).toBe(solo)
    expect(registry.lookupSoloExit(exit)).toBe(solo)
    expect(registry.release(solo)).toBe(true)
    expect(registry.lookupByTaskId(solo.taskId)).toBeUndefined()
  })

  it('releases failed launches while leaving unrelated owners live', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const first = registry.register(owner('first'))
    const second = registry.register(owner('second'))

    expect(registry.release(first)).toBe(true)
    expect(registry.release(first)).toBe(false)
    expect(registry.isAppRunIdLiveOwned(first.ownerRunId)).toBe(false)
    expect(registry.lookupByOwnerRunId(second.ownerRunId)).toBe(second)
  })
})
