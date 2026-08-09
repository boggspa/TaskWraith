import { describe, expect, it, vi } from 'vitest'
import { AttachmentCapabilityRegistry } from './AttachmentCapabilityRegistry'
import {
  ScopedHistoryDeletionCoordinator,
  type ScopedHistoryDeletionCoordinatorDeps
} from './ScopedHistoryDeletionCoordinator'
import type { HistoryDeletionPreparation, HistoryDeletionQuiescenceTarget } from './store'
import type { ChatRecord } from './store/types'

function chat(id: string): ChatRecord {
  return {
    appChatId: id,
    provider: 'codex',
    title: id,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function preparation(
  kind: 'chat' | 'truncate',
  rootChatId: string,
  targets: HistoryDeletionQuiescenceTarget[],
  completedQuiescenceTargetIds: string[] = []
): HistoryDeletionPreparation {
  return {
    operationId: 'operation-a',
    kind,
    rootChatId,
    chatIds: [rootChatId],
    runIds: targets.flatMap((target) => (target.runId ? [target.runId] : [])),
    quiescenceTargets: targets,
    completedQuiescenceTargetIds
  }
}

function createDeps(
  overrides: Partial<ScopedHistoryDeletionCoordinatorDeps> = {}
): ScopedHistoryDeletionCoordinatorDeps {
  let prepared: HistoryDeletionPreparation | null = null
  return {
    resolveChatIds: vi.fn((_kind, rootChatId) => [rootChatId]),
    listProviderRuns: vi.fn(() => [{ provider: 'codex' as const, runId: 'run-a' }]),
    getPending: vi.fn(() =>
      prepared
        ? { ...prepared, completedQuiescenceTargetIds: [...prepared.completedQuiescenceTargetIds] }
        : null
    ),
    prepare: vi.fn((input) => {
      prepared ??= preparation(input.kind, input.rootChatId, input.quiescenceTargets)
      return {
        ...prepared,
        completedQuiescenceTargetIds: [...prepared.completedQuiescenceTargetIds]
      }
    }),
    recordQuiesced: vi.fn((_operationId, targetIds) => {
      if (!prepared) throw new Error('not prepared')
      prepared.completedQuiescenceTargetIds = [
        ...new Set([...prepared.completedQuiescenceTargetIds, ...targetIds])
      ]
    }),
    commitDelete: vi.fn(),
    commitTruncate: vi.fn((rootChatId) => chat(rootChatId)),
    beginTranscriptMediaMutation: vi.fn(() => ({ id: 'media-hold' })),
    endTranscriptMediaMutation: vi.fn(),
    beginProjectReferenceMutation: vi.fn(() => ({ id: 'project-reference-hold' })),
    clearProjectReferenceArtifacts: vi.fn(async () => undefined),
    endProjectReferenceMutation: vi.fn(),
    beginUsageHistoryMutation: vi.fn(() => ({ id: 'usage-hold' })),
    purgeUsageHistoryStrict: vi.fn(async () => undefined),
    endUsageHistoryMutation: vi.fn(),
    beginCanvasClear: vi.fn(),
    endCanvasClear: vi.fn(),
    revokeChatAuthority: vi.fn(),
    terminateProviderRun: vi.fn(async () => undefined),
    clearExecutionGraph: vi.fn(async () => undefined),
    beginChannelsClear: vi.fn(async () => undefined),
    clearTranscriptMedia: vi.fn(async () => undefined),
    endBackgroundProcessDeletion: vi.fn(),
    ...overrides
  }
}

const delayedSinkCases: Array<{
  name: string
  overrides: (gate: ReturnType<typeof deferred>) => Partial<ScopedHistoryDeletionCoordinatorDeps>
}> = [
  {
    name: 'Ensemble cancellation',
    overrides: (gate) => ({ beginEnsembleClear: vi.fn(() => gate.promise) })
  },
  {
    name: 'provider termination',
    overrides: (gate) => ({ terminateProviderRun: vi.fn(() => gate.promise) })
  },
  {
    name: 'maintenance compaction',
    overrides: (gate) => ({
      listMaintenanceCompactions: vi.fn(() => [
        { id: 'compaction-a', provider: 'codex' as const, chatId: 'chat-a' }
      ]),
      beginMaintenanceCompactionDeletion: vi.fn(() => ({ id: 'maintenance-hold' })),
      cancelAndJoinMaintenanceCompaction: vi.fn(() => gate.promise),
      endMaintenanceCompactionDeletion: vi.fn()
    })
  },
  {
    name: 'Canvas closure',
    overrides: (gate) => ({ beginCanvasClear: vi.fn(() => gate.promise) })
  },
  {
    name: 'execution-graph deletion',
    overrides: (gate) => ({ clearExecutionGraph: vi.fn(() => gate.promise) })
  },
  {
    name: 'Channels quiescence',
    overrides: (gate) => ({ beginChannelsClear: vi.fn(() => gate.promise) })
  },
  {
    name: 'usage-history purge',
    overrides: (gate) => ({ purgeUsageHistoryStrict: vi.fn(() => gate.promise) })
  },
  {
    name: 'Project-reference purge',
    overrides: (gate) => ({ clearProjectReferenceArtifacts: vi.fn(() => gate.promise) })
  },
  {
    name: 'transcript-media purge',
    overrides: (gate) => ({ clearTranscriptMedia: vi.fn(() => gate.promise) })
  }
]

describe('ScopedHistoryDeletionCoordinator', () => {
  it('durably prepares, then raises every synchronous authority before awaiting sinks', async () => {
    const graph = deferred()
    const media = deferred()
    const provider = deferred()
    const order: string[] = []
    const deps = createDeps({
      prepare: vi.fn((input) => {
        order.push('prepare')
        return preparation(input.kind, input.rootChatId, input.quiescenceTargets)
      }),
      recordQuiesced: vi.fn(),
      beginUsageHistoryMutation: vi.fn(() => {
        order.push('usage-begin')
        return { id: 'usage-hold' }
      }),
      purgeUsageHistoryStrict: vi.fn(async () => {
        order.push('usage')
      }),
      endUsageHistoryMutation: vi.fn(() => order.push('usage-end')),
      beginProjectReferenceMutation: vi.fn(() => {
        order.push('project-reference-begin')
        return { id: 'project-reference-hold' }
      }),
      clearProjectReferenceArtifacts: vi.fn(async () => {
        order.push('project-reference')
      }),
      endProjectReferenceMutation: vi.fn(() => order.push('project-reference-end')),
      beginTranscriptMediaMutation: vi.fn(() => {
        order.push('media-begin')
        return { id: 'media-hold' }
      }),
      beginChannelsClear: vi.fn(async () => {
        order.push('channels-begin')
      }),
      endTranscriptMediaMutation: vi.fn(() => order.push('media-end')),
      beginCanvasClear: vi.fn(() => {
        order.push('canvas-begin')
      }),
      revokeChatAuthority: vi.fn(() => order.push('revoke')),
      terminateProviderRun: vi.fn(() => {
        order.push('provider')
        return provider.promise
      }),
      clearExecutionGraph: vi.fn(() => {
        order.push('graph')
        return graph.promise
      }),
      clearTranscriptMedia: vi.fn(() => {
        order.push('media')
        return media.promise
      }),
      commitDelete: vi.fn(() => order.push('commit')),
      endCanvasClear: vi.fn(() => order.push('canvas-end'))
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const deleting = coordinator.run('chat', 'chat-a')
    expect(order).toEqual([
      'prepare',
      'usage-begin',
      'project-reference-begin',
      'media-begin',
      'channels-begin',
      'canvas-begin',
      'revoke',
      'provider'
    ])
    expect(deps.commitDelete).not.toHaveBeenCalled()
    provider.resolve()
    await vi.waitFor(() => expect(order).toContain('graph'))
    expect(order).not.toContain('media')
    graph.resolve()
    await vi.waitFor(() => expect(order).toContain('media'))
    expect(order.indexOf('usage')).toBeLessThan(order.indexOf('project-reference'))
    expect(order.indexOf('project-reference')).toBeLessThan(order.indexOf('media'))
    media.resolve()
    await deleting

    expect(order.slice(-5)).toEqual([
      'commit',
      'usage-end',
      'project-reference-end',
      'media-end',
      'canvas-end'
    ])
    expect(deps.recordQuiesced).toHaveBeenCalledTimes(7)
  })

  it('does not start graph or media deletion before provider termination is confirmed', async () => {
    const provider = deferred()
    const deps = createDeps({
      terminateProviderRun: vi.fn(() => provider.promise)
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const deleting = coordinator.run('chat', 'chat-a')
    await Promise.resolve()
    expect(deps.clearExecutionGraph).not.toHaveBeenCalled()
    expect(deps.clearTranscriptMedia).not.toHaveBeenCalled()
    expect(deps.recordQuiesced).not.toHaveBeenCalledWith('operation-a', ['provider-run:run-a'])

    provider.resolve()
    await deleting
    expect(deps.clearExecutionGraph).toHaveBeenCalledTimes(1)
    expect(deps.clearTranscriptMedia).toHaveBeenCalledWith(
      ['chat-a'],
      expect.objectContaining({ id: 'media-hold' })
    )
  })

  it('retains the background-process admission hold through commit and awaits real close', async () => {
    const processClose = deferred()
    const order: string[] = []
    const hold = { completion: processClose.promise }
    const deps = createDeps({
      prepare: vi.fn((input) => {
        order.push('prepare')
        return preparation(input.kind, input.rootChatId, input.quiescenceTargets)
      }),
      recordQuiesced: vi.fn(),
      beginBackgroundProcessDeletion: vi.fn((kind, chatIds) => {
        order.push(`process-begin:${kind}:${chatIds.join(',')}`)
        return hold
      }),
      endBackgroundProcessDeletion: vi.fn((released) => {
        expect(released).toBe(hold)
        order.push('process-end')
      }),
      terminateProviderRun: vi.fn(async () => {
        order.push('provider')
      }),
      commitTruncate: vi.fn((rootChatId) => {
        order.push('commit')
        return chat(rootChatId)
      })
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const truncating = coordinator.run('truncate', 'chat-a')
    expect(order).toEqual(['prepare', 'process-begin:truncate:chat-a'])
    expect(deps.terminateProviderRun).not.toHaveBeenCalled()
    expect(deps.commitTruncate).not.toHaveBeenCalled()
    expect(deps.endBackgroundProcessDeletion).not.toHaveBeenCalled()

    processClose.resolve()
    await truncating
    expect(order.indexOf('provider')).toBeGreaterThan(
      order.indexOf('process-begin:truncate:chat-a')
    )
    expect(order.indexOf('commit')).toBeGreaterThan(order.indexOf('provider'))
    expect(order.indexOf('process-end')).toBeGreaterThan(order.indexOf('commit'))
  })

  it('synchronously fences and exactly joins a pre-dispatch Ensemble round before providers', async () => {
    const ensemble = deferred()
    const order: string[] = []
    const deps = createDeps({
      beginCanvasClear: vi.fn(() => {
        order.push('chat-gate')
      }),
      beginEnsembleClear: vi.fn(() => {
        order.push('ensemble-cancel')
        return ensemble.promise
      }),
      revokeChatAuthority: vi.fn(() => order.push('revoke')),
      terminateProviderRun: vi.fn(async () => {
        order.push('provider')
      }),
      clearTranscriptMedia: vi.fn(async () => {
        order.push('media')
      })
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const truncating = coordinator.run('truncate', 'chat-a')
    expect(order).toEqual(['chat-gate', 'ensemble-cancel', 'revoke'])
    expect(deps.terminateProviderRun).not.toHaveBeenCalled()
    expect(deps.clearTranscriptMedia).not.toHaveBeenCalled()

    ensemble.resolve()
    await truncating
    expect(order.indexOf('ensemble-cancel')).toBeLessThan(order.indexOf('provider'))
    expect(order.indexOf('provider')).toBeLessThan(order.indexOf('media'))
    expect(deps.commitTruncate).toHaveBeenCalledOnce()
  })

  it('joins concurrent same-scope callers and rejects a different scope before side effects', async () => {
    const graph = deferred()
    let pendingScope: string | null = null
    const deps = createDeps({
      prepare: vi.fn((input) => {
        const scope = `${input.kind}:${input.rootChatId}`
        if (pendingScope && pendingScope !== scope)
          throw new Error('different deletion scope pending')
        pendingScope = scope
        return preparation(input.kind, input.rootChatId, input.quiescenceTargets)
      }),
      recordQuiesced: vi.fn(),
      clearExecutionGraph: vi.fn(() => graph.promise)
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const first = coordinator.run('chat', 'chat-a')
    const joined = coordinator.run('chat', 'chat-a')
    expect(joined).toBe(first)
    expect(() => coordinator.run('truncate', 'chat-b')).toThrow('different deletion scope pending')
    expect(deps.beginCanvasClear).toHaveBeenCalledTimes(1)
    expect(deps.revokeChatAuthority).toHaveBeenCalledTimes(1)

    graph.resolve()
    await first
    expect(deps.commitDelete).toHaveBeenCalledTimes(1)
  })

  it('keeps the intent and holds after failure, then retries only incomplete targets', async () => {
    let mediaAttempts = 0
    let prepared: HistoryDeletionPreparation | null = null
    const deps = createDeps({
      prepare: vi.fn((input) => {
        prepared ??= preparation(input.kind, input.rootChatId, input.quiescenceTargets)
        return {
          ...prepared,
          completedQuiescenceTargetIds: [...prepared.completedQuiescenceTargetIds]
        }
      }),
      recordQuiesced: vi.fn((_operationId, targetIds) => {
        if (!prepared) throw new Error('not prepared')
        prepared.completedQuiescenceTargetIds = [
          ...new Set([...prepared.completedQuiescenceTargetIds, ...targetIds])
        ]
      }),
      clearTranscriptMedia: vi.fn(async () => {
        mediaAttempts += 1
        if (mediaAttempts === 1) throw new Error('media fsync failed')
      })
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(
      'could not quiesce every external sink'
    )
    expect(deps.commitDelete).not.toHaveBeenCalled()
    expect(deps.endCanvasClear).not.toHaveBeenCalled()
    expect(deps.clearExecutionGraph).toHaveBeenCalledTimes(1)
    expect(deps.terminateProviderRun).toHaveBeenCalledTimes(1)

    await coordinator.run('chat', 'chat-a')
    expect(deps.clearTranscriptMedia).toHaveBeenCalledTimes(2)
    expect(deps.purgeUsageHistoryStrict).toHaveBeenCalledTimes(2)
    expect(deps.clearExecutionGraph).toHaveBeenCalledTimes(1)
    expect(deps.terminateProviderRun).toHaveBeenCalledTimes(1)
    expect(deps.beginCanvasClear).toHaveBeenCalledTimes(1)
    expect(deps.endCanvasClear).toHaveBeenCalledTimes(1)
    expect(deps.commitDelete).toHaveBeenCalledTimes(1)
  })

  it('restarts a rejected Channels purge without reacquiring the retained outer holds', async () => {
    let channelsAttempts = 0
    const deps = createDeps({
      beginChannelsClear: vi.fn(async () => {
        channelsAttempts += 1
        if (channelsAttempts === 1) throw new Error('Channel audit fsync failed')
      })
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(
      'could not quiesce every external sink'
    )
    expect(deps.commitDelete).not.toHaveBeenCalled()
    expect(deps.beginCanvasClear).toHaveBeenCalledTimes(1)

    await coordinator.run('chat', 'chat-a')
    expect(deps.beginChannelsClear).toHaveBeenCalledTimes(2)
    expect(deps.beginCanvasClear).toHaveBeenCalledTimes(1)
    expect(deps.endCanvasClear).toHaveBeenCalledTimes(1)
    expect(deps.commitDelete).toHaveBeenCalledTimes(1)
  })

  it('resumes the frozen cascade after restart and reacquires holds for receipted Canvas targets', async () => {
    const targets: HistoryDeletionQuiescenceTarget[] = [
      { id: 'canvas:chat:parent', kind: 'canvas', chatId: 'parent' },
      { id: 'canvas:chat:child', kind: 'canvas', chatId: 'child' },
      { id: 'execution-graph:chat:parent', kind: 'execution-graph', chatId: 'parent' },
      { id: 'execution-graph:chat:child', kind: 'execution-graph', chatId: 'child' },
      { id: 'channels:chat-batch', kind: 'channels' },
      { id: 'usage:chat-batch', kind: 'usage' },
      { id: 'project-reference:chat-run-batch', kind: 'project-reference' },
      { id: 'media:chat-batch', kind: 'media' }
    ]
    const pending: HistoryDeletionPreparation = {
      operationId: 'operation-restart',
      kind: 'chat',
      rootChatId: 'parent',
      chatIds: ['parent', 'child'],
      runIds: [],
      quiescenceTargets: targets,
      completedQuiescenceTargetIds: targets.map((target) => target.id)
    }
    const deps = createDeps({
      getPending: vi.fn(() => pending),
      // Simulate a partial commit: the child no longer appears in a fresh
      // topology preview. Resume must never derive scope again.
      resolveChatIds: vi.fn(() => ['parent'])
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const result = await coordinator.run('chat', 'parent')

    expect(result.chatIds).toEqual(['parent', 'child'])
    expect(deps.resolveChatIds).not.toHaveBeenCalled()
    expect(deps.prepare).not.toHaveBeenCalled()
    expect(deps.beginCanvasClear).toHaveBeenCalledTimes(2)
    expect(deps.beginCanvasClear).toHaveBeenCalledWith('parent')
    expect(deps.beginCanvasClear).toHaveBeenCalledWith('child')
    expect(deps.beginUsageHistoryMutation).toHaveBeenCalledWith(pending)
    expect(deps.beginChannelsClear).toHaveBeenCalledWith('chat', ['parent', 'child'])
    expect(deps.purgeUsageHistoryStrict).toHaveBeenCalledTimes(1)
    expect(deps.clearProjectReferenceArtifacts).toHaveBeenCalledWith({
      appChatIds: ['parent', 'child'],
      runIds: []
    })
    expect(deps.clearTranscriptMedia).toHaveBeenCalledWith(
      ['parent', 'child'],
      expect.objectContaining({ id: 'media-hold' })
    )
    expect(deps.endCanvasClear).toHaveBeenCalledTimes(2)
    expect(deps.commitDelete).toHaveBeenCalledWith('parent')
  })

  it('purges a parent-child cascade in one strict transcript-media batch', async () => {
    const deps = createDeps({
      resolveChatIds: vi.fn(() => ['parent', 'child']),
      listProviderRuns: vi.fn(() => []),
      prepare: vi.fn((input) => ({
        ...preparation(input.kind, input.rootChatId, input.quiescenceTargets),
        chatIds: ['parent', 'child']
      })),
      getPending: vi.fn(() => null),
      recordQuiesced: vi.fn()
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    await coordinator.run('chat', 'parent')

    expect(deps.clearTranscriptMedia).toHaveBeenCalledTimes(1)
    expect(deps.beginChannelsClear).toHaveBeenCalledWith('chat', ['parent', 'child'])
    expect(deps.clearTranscriptMedia).toHaveBeenCalledWith(
      ['parent', 'child'],
      expect.objectContaining({ id: 'media-hold' })
    )
    expect(deps.commitDelete).toHaveBeenCalledTimes(1)
  })

  it('exhausts every post-commit hold release and resolves a committed deletion', async () => {
    const releasedCanvasChats: string[] = []
    const reportPostCommitReleaseError = vi.fn()
    const deps = createDeps({
      resolveChatIds: vi.fn(() => ['parent', 'child']),
      listProviderRuns: vi.fn(() => []),
      prepare: vi.fn((input) => ({
        ...preparation(input.kind, input.rootChatId, input.quiescenceTargets),
        chatIds: ['parent', 'child']
      })),
      getPending: vi.fn(() => null),
      recordQuiesced: vi.fn(),
      endTranscriptMediaMutation: vi.fn(() => {
        throw new Error('media hold release failed')
      }),
      endCanvasClear: vi.fn((chatId) => {
        releasedCanvasChats.push(chatId)
      }),
      reportPostCommitReleaseError
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    await expect(coordinator.run('chat', 'parent')).resolves.toEqual({
      chatIds: ['parent', 'child'],
      truncated: null
    })

    expect(deps.commitDelete).toHaveBeenCalledWith('parent')
    expect(deps.endUsageHistoryMutation).toHaveBeenCalledTimes(1)
    expect(deps.endProjectReferenceMutation).toHaveBeenCalledTimes(1)
    expect(deps.endTranscriptMediaMutation).toHaveBeenCalledTimes(1)
    expect(releasedCanvasChats).toEqual(['parent', 'child'])
    expect(deps.endCanvasClear).toHaveBeenCalledTimes(2)
    expect(reportPostCommitReleaseError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Scoped history deletion committed, but one or more admission holds could not be released.'
      })
    )
  })

  it('revokes only the target chat path capability before a deferred media purge', async () => {
    const registry = new AttachmentCapabilityRegistry()
    registry.authorizeMainPath('/tmp/chat-a.png', { appChatId: 'chat-a' })
    registry.authorizeMainPath('/tmp/chat-b.png', { appChatId: 'chat-b' })
    const media = deferred()
    const deps = createDeps({
      listProviderRuns: vi.fn(() => []),
      revokeChatAuthority: vi.fn((chatId) => {
        registry.revokeMainChat(chatId)
      }),
      clearTranscriptMedia: vi.fn(() => media.promise)
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const deleting = coordinator.run('truncate', 'chat-a')
    expect(registry.getMainAuthorizedPaths()).not.toContain('/tmp/chat-a.png')
    expect(registry.getMainAuthorizedPaths()).toContain('/tmp/chat-b.png')
    media.resolve()
    await deleting
    expect(deps.commitTruncate).toHaveBeenCalledWith('chat-a')
  })

  it('awaits strict usage purge before its receipt, media purge, or outer commit', async () => {
    const usage = deferred()
    const deps = createDeps({
      listProviderRuns: vi.fn(() => []),
      purgeUsageHistoryStrict: vi.fn(() => usage.promise)
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const deleting = coordinator.run('chat', 'chat-a')
    await vi.waitFor(() => expect(deps.purgeUsageHistoryStrict).toHaveBeenCalledOnce())
    expect(deps.recordQuiesced).not.toHaveBeenCalledWith('operation-a', ['usage:chat-batch'])
    expect(deps.clearTranscriptMedia).not.toHaveBeenCalled()
    expect(deps.commitDelete).not.toHaveBeenCalled()
    expect(deps.endUsageHistoryMutation).not.toHaveBeenCalled()
    expect(deps.endProjectReferenceMutation).not.toHaveBeenCalled()

    usage.resolve()
    await deleting
    expect(deps.recordQuiesced).toHaveBeenCalledWith('operation-a', ['usage:chat-batch'])
    expect(deps.clearTranscriptMedia).toHaveBeenCalledOnce()
    expect(deps.commitDelete).toHaveBeenCalledOnce()
    expect(deps.endUsageHistoryMutation).toHaveBeenCalledOnce()
    expect(deps.clearProjectReferenceArtifacts).toHaveBeenCalledOnce()
    expect(deps.endProjectReferenceMutation).toHaveBeenCalledOnce()
  })

  it('awaits one Project-reference purge for the frozen chat and run owner scope', async () => {
    const projectReference = deferred()
    const deps = createDeps({
      resolveChatIds: vi.fn(() => ['parent', 'child']),
      listProviderRuns: vi.fn(() => [{ provider: 'codex' as const, runId: 'run-a' }]),
      prepare: vi.fn((input) => ({
        ...preparation(input.kind, input.rootChatId, input.quiescenceTargets),
        chatIds: ['parent', 'child'],
        runIds: ['run-a', 'historical-run']
      })),
      getPending: vi.fn(() => null),
      recordQuiesced: vi.fn(),
      clearProjectReferenceArtifacts: vi.fn(() => projectReference.promise)
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    const deleting = coordinator.run('chat', 'parent')
    await vi.waitFor(() => expect(deps.clearProjectReferenceArtifacts).toHaveBeenCalledOnce())
    expect(deps.clearProjectReferenceArtifacts).toHaveBeenCalledWith({
      appChatIds: ['parent', 'child'],
      runIds: ['run-a', 'historical-run']
    })
    expect(deps.recordQuiesced).not.toHaveBeenCalledWith('operation-a', [
      'project-reference:chat-run-batch'
    ])
    expect(deps.clearTranscriptMedia).not.toHaveBeenCalled()
    expect(deps.commitDelete).not.toHaveBeenCalled()

    projectReference.resolve()
    await deleting
    expect(deps.recordQuiesced).toHaveBeenCalledWith('operation-a', [
      'project-reference:chat-run-batch'
    ])
    expect(deps.clearTranscriptMedia).toHaveBeenCalledOnce()
    expect(deps.commitDelete).toHaveBeenCalledOnce()
  })

  it('bounds the caller wait without releasing holds around an unsettled sink', async () => {
    const neverCloses = deferred()
    const deps = createDeps({
      quiescenceDeadlineMs: 25,
      beginBackgroundProcessDeletion: vi.fn(() => ({ completion: neverCloses.promise }))
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(/did not quiesce within 25ms/)
    // The underlying close is still live. Releasing any hold here would admit a
    // writer while that continuation can still mutate the frozen scope.
    expect(deps.commitDelete).not.toHaveBeenCalled()
    expect(deps.commitTruncate).not.toHaveBeenCalled()
    expect(deps.endBackgroundProcessDeletion).not.toHaveBeenCalled()
    expect(deps.endCanvasClear).not.toHaveBeenCalled()
    await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(/still reconciling/)
    expect(deps.beginCanvasClear).toHaveBeenCalledOnce()
  })

  it('reconciles a late sink without committing, then supports a clean same-process retry', async () => {
    const slowClose = deferred()
    const deps = createDeps({
      quiescenceDeadlineMs: 25,
      beginBackgroundProcessDeletion: vi.fn(() => ({ completion: slowClose.promise }))
    })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)

    await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(/did not quiesce/)
    expect(deps.commitDelete).not.toHaveBeenCalled()
    expect(deps.endBackgroundProcessDeletion).not.toHaveBeenCalled()
    expect(deps.endCanvasClear).not.toHaveBeenCalled()

    // The sink finally closes. The late continuation reaches the commit
    // boundary under its retained holds, refuses the commit, then releases
    // exactly those holds while leaving the durable intent available.
    slowClose.resolve()
    await vi.waitFor(() => expect(deps.endBackgroundProcessDeletion).toHaveBeenCalledOnce())
    expect(deps.commitDelete).not.toHaveBeenCalled()
    expect(deps.endUsageHistoryMutation).toHaveBeenCalledOnce()
    expect(deps.endProjectReferenceMutation).toHaveBeenCalledOnce()
    expect(deps.endTranscriptMediaMutation).toHaveBeenCalledOnce()
    expect(deps.endCanvasClear).toHaveBeenCalledOnce()
    expect(deps.getPending()).not.toBeNull()

    await coordinator.run('chat', 'chat-a')
    expect(deps.commitDelete).toHaveBeenCalledOnce()
    expect(deps.beginCanvasClear).toHaveBeenCalledTimes(2)
    expect(deps.endCanvasClear).toHaveBeenCalledTimes(2)
    expect(deps.endBackgroundProcessDeletion).toHaveBeenCalledTimes(2)
  })

  it.each(delayedSinkCases)(
    'reconciles late $name without a late commit or duplicated holds',
    async ({ overrides }) => {
      const gate = deferred()
      const deps = createDeps({
        quiescenceDeadlineMs: 20,
        ...overrides(gate)
      })
      const coordinator = new ScopedHistoryDeletionCoordinator(deps)

      await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(/did not quiesce/)
      expect(deps.commitDelete).not.toHaveBeenCalled()
      expect(deps.endCanvasClear).not.toHaveBeenCalled()
      await expect(coordinator.run('chat', 'chat-a')).rejects.toThrow(/still reconciling/)
      expect(deps.beginCanvasClear).toHaveBeenCalledOnce()

      gate.resolve()
      await vi.waitFor(() => expect(deps.endCanvasClear).toHaveBeenCalledOnce())
      expect(deps.commitDelete).not.toHaveBeenCalled()
      expect(deps.getPending()).not.toBeNull()

      await coordinator.run('chat', 'chat-a')
      expect(deps.commitDelete).toHaveBeenCalledOnce()
      expect(deps.beginCanvasClear).toHaveBeenCalledTimes(2)
      expect(deps.endCanvasClear).toHaveBeenCalledTimes(2)
      expect(deps.beginUsageHistoryMutation).toHaveBeenCalledTimes(2)
      expect(deps.endUsageHistoryMutation).toHaveBeenCalledTimes(2)
      expect(deps.beginProjectReferenceMutation).toHaveBeenCalledTimes(2)
      expect(deps.endProjectReferenceMutation).toHaveBeenCalledTimes(2)
      expect(deps.beginTranscriptMediaMutation).toHaveBeenCalledTimes(2)
      expect(deps.endTranscriptMediaMutation).toHaveBeenCalledTimes(2)
    }
  )

  it('leaves the backstop off when a caller supplies its own bound', async () => {
    // A non-positive deadline disables the race entirely; proves the guard is
    // opt-out rather than silently clamped to some minimum.
    const deps = createDeps({ quiescenceDeadlineMs: 0 })
    const coordinator = new ScopedHistoryDeletionCoordinator(deps)
    await coordinator.run('chat', 'chat-a')
    expect(deps.commitDelete).toHaveBeenCalledOnce()
  })
})
