import { describe, expect, it, vi } from 'vitest'
import type { ExecutionRunState } from './ExecutionGraphModel'
import type { ExecutionRunProjection } from './ExecutionGraphRun'
import {
  clearExecutionGraphHistory,
  deleteExecutionGraphHistoryForChat,
  type ExecutionGraphHistoryRetentionDeps
} from './ExecutionGraphHistoryRetention'

function projection(
  executionId: string,
  state: ExecutionRunState,
  rootChatId = 'chat-one',
  workspaceId = 'workspace-one'
): ExecutionRunProjection {
  return {
    executionId,
    state,
    rootChatId,
    workspaceId,
    topology: { steps: [], edges: [] },
    topologyDigest: 'topology-digest',
    activations: {},
    attempts: {},
    eventCount: 1,
    lastSequence: 1,
    integrity: 'valid',
    baseRevisionMissing: false,
    diagnostics: []
  }
}

function depsWith(initial: ExecutionRunProjection[]) {
  let projections = [...initial]
  const order: string[] = []
  const coordinator = {
    listExecutions: vi.fn(
      (filter?: { workspaceId?: string; rootChatId?: string; includeTerminal?: boolean }) =>
        projections.filter(
          (entry) =>
            (!filter?.workspaceId || entry.workspaceId === filter.workspaceId) &&
            (!filter?.rootChatId || entry.rootChatId === filter.rootChatId)
        )
    ),
    cancelExecution: vi.fn(async (executionId: string) => {
      order.push(`cancel:${executionId}`)
      projections = projections.map((entry) =>
        entry.executionId === executionId
          ? projection(entry.executionId, 'cancelled', entry.rootChatId, entry.workspaceId)
          : entry
      )
    })
  }
  const repository = {
    hasHistoryForRootChat: vi.fn((rootChatId: string) =>
      projections.some((entry) => entry.rootChatId === rootChatId)
    ),
    hasHistoryForWorkspace: vi.fn((workspaceId: string) =>
      projections.some((entry) => entry.workspaceId === workspaceId)
    ),
    deleteExecutionsForRootChat: vi.fn((rootChatId: string) => {
      order.push(`delete-chat:${rootChatId}`)
      return {
        deletedExecutionIds: ['execution-one'],
        deletedRunTemplateIds: [],
        unscopedQuarantinedExecutionIds: []
      }
    }),
    deleteExecutionsForWorkspace: vi.fn((workspaceId: string) => {
      order.push(`delete-workspace:${workspaceId}`)
      return {
        deletedExecutionIds: ['execution-one'],
        deletedRunTemplateIds: [],
        unscopedQuarantinedExecutionIds: []
      }
    }),
    clearAllHistory: vi.fn(() => {
      order.push('clear-all')
      return {
        deletedExecutionIds: ['execution-one'],
        deletedRunTemplateIds: [],
        deletedRevisionIds: [],
        deletedLayoutIds: [],
        unscopedQuarantinedExecutionIds: []
      }
    })
  }
  return {
    deps: { coordinator, repository } satisfies ExecutionGraphHistoryRetentionDeps,
    coordinator,
    repository,
    order,
    setProjections: (next: ExecutionRunProjection[]) => {
      projections = next
    }
  }
}

describe('execution-graph chat-history retention', () => {
  it('proves exact active work terminal before deleting its chat-rooted ledger', async () => {
    const harness = depsWith([
      projection('execution-one', 'running'),
      projection('execution-sibling', 'running', 'chat-two')
    ])

    await deleteExecutionGraphHistoryForChat(harness.deps, 'chat-one')

    expect(harness.order).toEqual(['cancel:execution-one', 'delete-chat:chat-one'])
    expect(harness.coordinator.listExecutions).toHaveBeenNthCalledWith(1, {
      rootChatId: 'chat-one',
      includeTerminal: true
    })
    expect(harness.repository.deleteExecutionsForRootChat).toHaveBeenCalledWith('chat-one')
  })

  it('fails closed without deleting when cancellation cannot prove a terminal graph', async () => {
    const harness = depsWith([projection('execution-one', 'running')])
    harness.coordinator.cancelExecution.mockImplementation(async () => {
      harness.setProjections([projection('execution-one', 'requires_action')])
    })

    await expect(deleteExecutionGraphHistoryForChat(harness.deps, 'chat-one')).rejects.toThrow(
      /could not prove terminal cleanup/
    )
    expect(harness.repository.deleteExecutionsForRootChat).not.toHaveBeenCalled()
  })

  it('uses repository-wide clear for global history and workspace-only purge when scoped', async () => {
    const global = depsWith([projection('execution-one', 'cancelled')])
    await clearExecutionGraphHistory(global.deps)
    expect(global.order).toEqual(['clear-all'])
    expect(global.repository.clearAllHistory).toHaveBeenCalledTimes(1)

    const scoped = depsWith([
      projection('execution-one', 'cancelled'),
      projection('execution-two', 'cancelled', 'chat-two', 'workspace-two')
    ])
    await clearExecutionGraphHistory(scoped.deps, 'workspace-one')
    expect(scoped.order).toEqual(['delete-workspace:workspace-one'])
    expect(scoped.repository.deleteExecutionsForWorkspace).toHaveBeenCalledWith('workspace-one')
    expect(scoped.repository.clearAllHistory).not.toHaveBeenCalled()
  })

  it('does not make unrelated chat deletion depend on graph cleanup health', async () => {
    const harness = depsWith([projection('execution-other', 'running', 'chat-other')])
    harness.coordinator.cancelExecution.mockRejectedValue(new Error('graph cleanup unavailable'))

    await expect(
      deleteExecutionGraphHistoryForChat(harness.deps, 'chat-unrelated')
    ).resolves.toEqual({
      deletedExecutionIds: [],
      deletedRunTemplateIds: [],
      unscopedQuarantinedExecutionIds: []
    })
    expect(harness.coordinator.listExecutions).not.toHaveBeenCalled()
    expect(harness.coordinator.cancelExecution).not.toHaveBeenCalled()
    expect(harness.repository.deleteExecutionsForRootChat).not.toHaveBeenCalled()
  })
})
