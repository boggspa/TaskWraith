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

  it('binds one unique ensemble round and consumes it exactly once', () => {
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
    expect(registry.consumeEnsembleRound('round-one')).toBe(ensemble)
    expect(registry.consumeEnsembleRound('round-one')).toBeUndefined()
    expect(registry.isAppRunIdLiveOwned(ensemble.ownerRunId)).toBe(false)
  })

  it('consumes a solo exit once and releases all indexes', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const solo = registry.register(owner('solo'))
    const exit = {
      appRunId: solo.ownerRunId,
      provider: solo.provider,
      chatId: solo.chatId
    }

    expect(registry.isAppRunIdLiveOwned(solo.ownerRunId)).toBe(true)
    expect(registry.consumeSoloExit(exit)).toBe(solo)
    expect(registry.consumeSoloExit(exit)).toBeUndefined()
    expect(registry.lookupByTaskId(solo.taskId)).toBeUndefined()
  })

  it('releases failed launches while leaving unrelated owners live', () => {
    const registry = new ScheduledOccurrenceOwnerRegistry()
    const first = registry.register(owner('first'))
    const second = registry.register(owner('second'))

    expect(registry.release(first.ownerRunId)).toBe(first)
    expect(registry.release(first.ownerRunId)).toBeUndefined()
    expect(registry.isAppRunIdLiveOwned(first.ownerRunId)).toBe(false)
    expect(registry.lookupByOwnerRunId(second.ownerRunId)).toBe(second)
  })
})
