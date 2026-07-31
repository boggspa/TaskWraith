import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

// The startup recovery gates are a moving target: the 1.9.2 arc widened every
// one of them from `if (!historyDeletionStartupRecoveryBlockedReason)` to a
// conjunction that also demands `!workspaceLockStartupRecoveryBlockedReason`
// (and, at some sites, `!scheduledOccurrenceRecoveryBlockedReason`). Each added
// conjunct is a strict NARROWING of when recovery runs, so the deletion fence
// this tripwire exists to protect (TW-SEC-014) can never be weakened by one.
// Pin the fence clause and tolerate any number of further `&& !<name>`
// conjuncts — a longer literal has now broken this class twice.
const STARTUP_RECOVERY_GATE =
  /if\s*\(\s*!historyDeletionStartupRecoveryBlockedReason(\s*&&\s*![A-Za-z]+)*\s*\)\s*\{/

// The same gate, additionally required to carry the scheduled-occurrence fence
// somewhere in its conjunct list.
const SCHEDULED_OCCURRENCE_GATE =
  /if\s*\(\s*!historyDeletionStartupRecoveryBlockedReason\s*&&(\s*![A-Za-z]+\s*&&)*\s*!scheduledOccurrenceRecoveryBlockedReason\s*\)/

/** `lastIndexOf(gate, limit)` for a regex: last match starting at or before `limit`. */
function lastGateIndexAtOrBefore(source: string, limit: number): number {
  const scanner = new RegExp(STARTUP_RECOVERY_GATE.source, 'g')
  let found = -1
  let match: RegExpExecArray | null
  while ((match = scanner.exec(source)) !== null) {
    if (match.index > limit) break
    found = match.index
    scanner.lastIndex = match.index + 1
  }
  return found
}

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
    expect(source).toMatch(STARTUP_RECOVERY_GATE)
    expect(source.search(STARTUP_RECOVERY_GATE)).toBeLessThan(
      source.indexOf('AppStore.recoverRunQueueAfterStartup()')
    )
    expect(source).toMatch(SCHEDULED_OCCURRENCE_GATE)
    const wakeupRecovery = indexSource.lastIndexOf('recoverPersistedEnsembleWakeups()')
    const wakeupGuard = indexSource.lastIndexOf(
      '!historyDeletionStartupRecoveryBlockedReason',
      wakeupRecovery
    )
    const mailboxRecovery = indexSource.indexOf('recoverPendingSubThreadMailboxes()', wakeupRecovery)
    const mailboxGuard = lastGateIndexAtOrBefore(indexSource, mailboxRecovery)
    expect(wakeupGuard).toBeGreaterThan(end)
    expect(wakeupGuard).toBeLessThan(wakeupRecovery)
    expect(mailboxGuard).toBeGreaterThan(wakeupRecovery)
    expect(mailboxGuard).toBeLessThan(mailboxRecovery)
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
