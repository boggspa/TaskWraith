import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('history deletion startup integration', () => {
  it('recovers pending deletion and lifecycle-reaps orphans before run-queue revival', () => {
    const projectReferenceNeedCheck = indexSource.indexOf(
      'const projectReferenceOwnershipNeedsReconciliation ='
    )
    const projectReferenceReconciliation = indexSource.indexOf(
      'projectReferenceArtifactStore.reconcileLegacyOwnership('
    )
    const pendingReachability = indexSource.indexOf(
      'const pendingDeletionForProjectReferenceReachability ='
    )
    const deferredReconciliation = indexSource.indexOf(
      'DeferredProjectReferenceReconciler.prepare({'
    )
    const innerUsageRecovery = indexSource.indexOf(
      'recoverPendingUsageHistoryMutationBeforeOuterDeletion()'
    )
    const recover = indexSource.indexOf('await recoverPendingHistoryDeletionBeforeRunQueue()')
    const orphanDrain = indexSource.indexOf('await drainOrphanSubThreadsBeforeRunQueue()')
    const queueRecovery = indexSource.indexOf(
      'const startupRecoveryRecords = AppStore.recoverRunQueueAfterStartup()'
    )

    expect(pendingReachability).toBeGreaterThanOrEqual(0)
    expect(projectReferenceNeedCheck).toBeGreaterThan(pendingReachability)
    expect(projectReferenceReconciliation).toBeGreaterThan(pendingReachability)
    expect(projectReferenceReconciliation).toBeLessThan(deferredReconciliation)
    expect(indexSource).toContain(
      "await getRunRepository().getRunEventsAsync({ kinds: ['reference_context'] })"
    )
    expect(deferredReconciliation).toBeLessThan(innerUsageRecovery)
    expect(innerUsageRecovery).toBeGreaterThan(projectReferenceReconciliation)
    expect(recover).toBeGreaterThan(innerUsageRecovery)
    expect(orphanDrain).toBeGreaterThan(recover)
    expect(queueRecovery).toBeGreaterThan(orphanDrain)
  })

  it('defers ordinary ownership reconciliation until after first paint under a capture hold', () => {
    const readyToShowStart = indexSource.indexOf("mainWindow.on('ready-to-show', () => {")
    const readyToShowEnd = indexSource.indexOf("mainWindow.on('resize'", readyToShowStart)
    const readyToShowSource = indexSource.slice(readyToShowStart, readyToShowEnd)
    const startupStart = indexSource.indexOf(
      '// A crash after durable history prepare must replay every unreceipted'
    )
    const startupEnd = indexSource.indexOf(
      'recoverPendingUsageHistoryMutationBeforeOuterDeletion()',
      startupStart
    )
    const startupSource = indexSource.slice(startupStart, startupEnd)

    expect(readyToShowStart).toBeGreaterThanOrEqual(0)
    expect(readyToShowSource).toContain(
      'deferredProjectReferenceReconciler?.scheduleAfterFirstPaint()'
    )
    expect(startupSource).toContain('pendingDeletionForProjectReferenceReachability')
    expect(startupSource).toContain('DeferredProjectReferenceReconciler.prepare({')
    expect(startupSource).toContain(
      'projectReferenceArtifactStore.beginStartupReconciliation()'
    )
    expect(startupSource).toContain('loadOwnership: async () =>')
    expect(startupSource).toContain('endCaptureHold: (hold) =>')
  })

  it('keeps startup alive but skips resurrection recovery when strict deletion replay fails', () => {
    const start = indexSource.indexOf(
      '// A crash after durable history prepare must replay every unreceipted'
    )
    const end = indexSource.indexOf('AppStore.recoverExpiredApprovalLedger()', start)
    const source = indexSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source).toContain('projectReferenceArtifactStore.reconcileLegacyOwnership(')
    expect(source).toContain('recoverPendingUsageHistoryMutationBeforeOuterDeletion()')
    expect(source).toContain('await recoverPendingHistoryDeletionBeforeRunQueue()')
    expect(source).toContain("code: 'history_deletion_recovery_required'")
    expect(source).toContain('if (!historyDeletionStartupRecoveryBlockedReason) {')
    expect(source.indexOf('if (!historyDeletionStartupRecoveryBlockedReason) {')).toBeLessThan(
      source.indexOf('AppStore.recoverRunQueueAfterStartup()')
    )
    expect(source).toMatch(
      /if\s*\(\s*!historyDeletionStartupRecoveryBlockedReason\s*&&\s*!scheduledOccurrenceRecoveryBlockedReason\s*\)/
    )
    const wakeupRecovery = indexSource.lastIndexOf('recoverPersistedEnsembleWakeups()')
    const wakeupGuard = indexSource.lastIndexOf(
      '!historyDeletionStartupRecoveryBlockedReason',
      wakeupRecovery
    )
    const mailboxRecovery = indexSource.indexOf('recoverPendingSubThreadMailboxes()', wakeupRecovery)
    const mailboxGuard = indexSource.lastIndexOf(
      'if (!historyDeletionStartupRecoveryBlockedReason)',
      mailboxRecovery
    )
    expect(wakeupGuard).toBeGreaterThan(end)
    expect(wakeupGuard).toBeLessThan(wakeupRecovery)
    expect(mailboxGuard).toBeGreaterThan(wakeupRecovery)
    expect(mailboxGuard).toBeLessThan(mailboxRecovery)
  })

  /**
   * TW-SEC-014 completeness. The external-contribution queue is a SECOND store
   * of erasable content, and the only one that still holds message BODIES.
   * Every self-heal path deliberately refuses to touch an approved-but-
   * undelivered entry — sweep() skips non-queued states and isReapable()
   * exempts it from both the retention reap and the overflow eviction — so if
   * erasure does not purge it, nothing ever will.
   */
  it('purges the external-contribution queue on every erasure kind', () => {
    const fn = indexSource.indexOf('const purgeHumanCollaborationForErasure =')
    expect(fn).toBeGreaterThanOrEqual(0)
    const end = indexSource.indexOf('\n    }', indexSource.indexOf('reopenCollaborationRooms()', fn))
    const body = indexSource.slice(fn, end)

    expect(body).toContain('externalContributionQueue.purgeAll()')
    expect(body).toContain('externalContributionQueue.purgeChats(chatIds)')

    // The scoped purge must sit ABOVE the truncate early-return, or a truncate
    // keeps the share, erases the rows underneath it, and leaves the queued
    // contributions for those rows behind.
    const scopedPurge = body.indexOf('externalContributionQueue.purgeChats(chatIds)')
    const truncateReturn = body.indexOf("if (kind !== 'truncate') {")
    expect(scopedPurge).toBeGreaterThanOrEqual(0)
    expect(truncateReturn).toBeGreaterThan(scopedPurge)
  })

  it('releases the correlated usage hold only from the post-commit release phase', () => {
    const commit = indexSource.indexOf('commit: (operationId) => {')
    // Checkpoint and collaboration purges run under the frozen intent, before
    // the store commit inside the same commit phase (TW-SEC-2026-014).
    const checkpointPurge = indexSource.indexOf('store.purgeForHistoryDeletionScope(', commit)
    const collaborationPurge = indexSource.indexOf(
      'purgeHumanCollaborationForErasure(pending.kind',
      commit
    )
    const commitCall = indexSource.indexOf(
      'AppStore.commitPreparedHistoryDeletion(operationId)',
      commit
    )
    const release = indexSource.indexOf('releaseHolds: (preparation, holds) =>', commitCall)
    const usageRelease = indexSource.indexOf(
      'usageHistoryDeletionTarget.releaseAfterCommit(',
      release
    )
    const nextCoordinatorSection = indexSource.indexOf(
      'const clearBroadChatHistory =',
      release
    )

    expect(commit).toBeGreaterThanOrEqual(0)
    expect(checkpointPurge).toBeGreaterThan(commit)
    expect(checkpointPurge).toBeLessThan(commitCall)
    expect(collaborationPurge).toBeGreaterThan(checkpointPurge)
    expect(collaborationPurge).toBeLessThan(commitCall)
    expect(release).toBeGreaterThan(commitCall)
    expect(usageRelease).toBeGreaterThan(release)
    expect(usageRelease).toBeLessThan(nextCoordinatorSection)
  })

  it('uses one Project-reference store for reconciliation, held purge, and run capture', () => {
    expect(indexSource.match(/new ProjectReferenceArtifactStore\(/g)).toHaveLength(1)
    expect(indexSource).toContain("kind: 'project-reference'")
    expect(indexSource).toContain('projectReferenceArtifactStore.beginHistoryMutation(')
    expect(indexSource).toContain('projectReferenceArtifactStore.revokeOwnershipStrict({')
    expect(indexSource).toContain('await projectReferenceArtifactStore.clearAllStrict()')
    expect(indexSource).toContain('artifactStore: projectReferenceArtifactStore')
  })

  it('arms the scheduler from the deletion-fenced projection and cannot spin on hidden due work', () => {
    const start = indexSource.indexOf('function scheduleNextTaskTimer()')
    const end = indexSource.indexOf('\nasync function getCodexStatusSnapshotForCliRuntime', start)
    const source = indexSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source).toContain('historyDeletionStartupRecoveryBlockedReason')
    expect(source).toContain('tasks: AppStore.getDispatchableScheduledTasks()')
    expect(source).not.toContain('tasks: AppStore.getScheduledTasks()')
  })

  it('acknowledges an orphan only after the strict coordinator resolves', () => {
    const start = indexSource.indexOf('const drainOrphanSubThreadsBeforeRunQueue =')
    const end = indexSource.indexOf('\n    reconcileBridgeDaemonFromSettings()', start)
    const source = indexSource.slice(start, end)
    const deletion = source.indexOf('await broadHistoryDeletionCoordinator.run({')
    const acknowledgement = source.indexOf(
      'AppStore.acknowledgeOrphanSubThreadReapCandidate(rootChatId)'
    )

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(deletion).toBeGreaterThanOrEqual(0)
    expect(acknowledgement).toBeGreaterThan(deletion)
  })

  it('routes scoped and broad Ensemble history clears through timer cleanup without a running round', () => {
    const runtimeGuard = indexSource.indexOf('const ensembleHistoryRuntimeCouldExist =')
    const broadStart = indexSource.indexOf('const beginBroadEnsembleHistoryClear =')
    const broadEnd = indexSource.indexOf('\n    const broadSoloWakeupHistoryScope =', broadStart)
    const scopedStart = indexSource.indexOf('const beginEnsembleHistoryClear =')
    const scopedEnd = indexSource.indexOf('\n    const revokeApprovalsForChat =', scopedStart)
    const startupRecovery = indexSource.indexOf(
      'await recoverPendingHistoryDeletionBeforeRunQueue()'
    )
    const orchestratorConstruction = indexSource.indexOf(
      'ensembleOrchestratorRef = new EnsembleOrchestrator({'
    )
    const broad = indexSource.slice(broadStart, broadEnd)
    const scoped = indexSource.slice(scopedStart, scopedEnd)

    expect(runtimeGuard).toBeGreaterThanOrEqual(0)
    expect(broadStart).toBeGreaterThan(runtimeGuard)
    expect(broadEnd).toBeGreaterThan(broadStart)
    expect(scopedStart).toBeGreaterThanOrEqual(0)
    expect(scopedEnd).toBeGreaterThan(scopedStart)
    expect(startupRecovery).toBeGreaterThanOrEqual(0)
    expect(orchestratorConstruction).toBeGreaterThan(startupRecovery)
    for (const source of [broad, scoped]) {
      expect(source).toContain(
        "const expectedRoundId = round?.status === 'running' ? round.roundId : undefined"
      )
      expect(source).toContain(
        ".cancelRoundForHistory(chatId, 'chat history cleared', expectedRoundId)"
      )
      expect(source).toContain(
        'if (!ensembleHistoryRuntimeCouldExist(chatId)) return Promise.resolve()'
      )
      expect(source).not.toContain(
        "if (!round || round.status !== 'running') return Promise.resolve()"
      )
    }
  })
})
