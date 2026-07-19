import { describe, expect, it, vi } from 'vitest'

import { ScopedHistoryDeletionCoordinator } from './ScopedHistoryDeletionCoordinator'
import type { HistoryDeletionPreparation, HistoryDeletionQuiescenceTarget } from './store'

function prepared(
  targets: HistoryDeletionQuiescenceTarget[],
  completedQuiescenceTargetIds: string[] = []
): HistoryDeletionPreparation {
  return {
    operationId: 'delete-operation',
    kind: 'chat',
    rootChatId: 'chat-a',
    chatIds: ['chat-a'],
    runIds: ['run-a'],
    quiescenceTargets: targets,
    completedQuiescenceTargetIds
  }
}

describe('ScopedHistoryDeletionCoordinator maintenance compaction fencing', () => {
  it('durably discovers exact compactions, raises the scope hold synchronously, and joins before commit', async () => {
    const calls: string[] = []
    let capturedTargets: HistoryDeletionQuiescenceTarget[] = []
    const coordinator = new ScopedHistoryDeletionCoordinator({
      resolveChatIds: () => ['chat-a'],
      listProviderRuns: () => [{ provider: 'codex', runId: 'run-a' }],
      listMaintenanceCompactions: () => [
        { id: 'compaction-a', provider: 'kimi', chatId: 'chat-a' }
      ],
      getPending: () => null,
      prepare: (input) => {
        calls.push('prepare')
        capturedTargets = input.quiescenceTargets
        return prepared(input.quiescenceTargets)
      },
      recordQuiesced: (_operationId, targetIds) => calls.push(`receipt:${targetIds[0]}`),
      commitDelete: () => calls.push('commit'),
      commitTruncate: () => null,
      beginTranscriptMediaMutation: () => {
        calls.push('media-hold')
        return 'media-hold'
      },
      endTranscriptMediaMutation: () => calls.push('media-release'),
      beginMaintenanceCompactionDeletion: () => {
        calls.push('compaction-hold')
        return 'compaction-hold'
      },
      cancelAndJoinMaintenanceCompaction: async (id) => {
        calls.push(`compaction-join:${id || 'scope'}`)
      },
      endMaintenanceCompactionDeletion: () => calls.push('compaction-release'),
      beginUsageHistoryMutation: () => {
        calls.push('usage-hold')
        return 'usage-hold'
      },
      purgeUsageHistoryStrict: async () => {
        calls.push('usage-clear')
      },
      endUsageHistoryMutation: () => calls.push('usage-release'),
      beginProjectReferenceMutation: () => {
        calls.push('project-reference-hold')
        return 'project-reference-hold'
      },
      clearProjectReferenceArtifacts: async () => {
        calls.push('project-reference-clear')
      },
      endProjectReferenceMutation: () => calls.push('project-reference-release'),
      beginCanvasClear: () => {
        calls.push('canvas-hold')
      },
      endCanvasClear: () => calls.push('canvas-release'),
      revokeChatAuthority: () => calls.push('revoke'),
      terminateProviderRun: async () => {
        calls.push('provider-join')
      },
      clearExecutionGraph: async () => {
        calls.push('graph-clear')
      },
      clearTranscriptMedia: async () => {
        calls.push('media-clear')
      }
    })

    await coordinator.run('chat', 'chat-a')

    expect(capturedTargets).toEqual(
      expect.arrayContaining([
        { id: 'maintenance-compaction:chat-batch', kind: 'maintenance-compaction' },
        expect.objectContaining({
          id: 'maintenance-compaction:compaction-a',
          kind: 'maintenance-compaction',
          maintenanceCompactionId: 'compaction-a',
          provider: 'kimi',
          chatId: 'chat-a'
        })
      ])
    )
    expect(calls.indexOf('compaction-hold')).toBeLessThan(calls.indexOf('revoke'))
    expect(calls.indexOf('provider-join')).toBeLessThan(
      calls.indexOf('compaction-join:scope')
    )
    expect(calls.indexOf('compaction-join:compaction-a')).toBeLessThan(
      calls.indexOf('commit')
    )
    expect(calls.indexOf('commit')).toBeLessThan(calls.indexOf('compaction-release'))
    expect(calls).toContain('media-release')
    expect(calls).toContain('canvas-release')
  })

  it('keeps the durable deletion pending when a pre-crash exact compaction has no termination proof', async () => {
    const exactTarget: HistoryDeletionQuiescenceTarget = {
      id: 'maintenance-compaction:pre-crash',
      kind: 'maintenance-compaction',
      maintenanceCompactionId: 'pre-crash',
      provider: 'kimi',
      chatId: 'chat-a'
    }
    const pending = prepared([
      exactTarget,
      { id: 'maintenance-compaction:chat-batch', kind: 'maintenance-compaction' },
      { id: 'canvas:chat:chat-a', kind: 'canvas', chatId: 'chat-a' },
      { id: 'execution-graph:chat:chat-a', kind: 'execution-graph', chatId: 'chat-a' },
      { id: 'usage:chat-batch', kind: 'usage' },
      { id: 'project-reference:chat-run-batch', kind: 'project-reference' },
      { id: 'media:chat-batch', kind: 'media' }
    ])
    const commit = vi.fn()
    const release = vi.fn()
    const coordinator = new ScopedHistoryDeletionCoordinator({
      resolveChatIds: () => ['chat-a'],
      listProviderRuns: () => [],
      getPending: () => pending,
      prepare: () => pending,
      recordQuiesced: vi.fn(),
      commitDelete: commit,
      commitTruncate: () => null,
      beginTranscriptMediaMutation: () => 'media-hold',
      endTranscriptMediaMutation: release,
      beginMaintenanceCompactionDeletion: () => 'fresh-process-hold',
      cancelAndJoinMaintenanceCompaction: async (id) => {
        if (id === 'pre-crash') throw new Error('no exact termination proof')
      },
      endMaintenanceCompactionDeletion: release,
      beginUsageHistoryMutation: () => 'usage-hold',
      purgeUsageHistoryStrict: vi.fn(),
      endUsageHistoryMutation: release,
      beginProjectReferenceMutation: () => 'project-reference-hold',
      clearProjectReferenceArtifacts: vi.fn(),
      endProjectReferenceMutation: release,
      beginCanvasClear: vi.fn(),
      endCanvasClear: release,
      revokeChatAuthority: vi.fn(),
      terminateProviderRun: vi.fn(),
      clearExecutionGraph: vi.fn(),
      clearTranscriptMedia: vi.fn()
    })

    await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(
      'Scoped history deletion could not quiesce every external sink.'
    )
    expect(commit).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })
})
