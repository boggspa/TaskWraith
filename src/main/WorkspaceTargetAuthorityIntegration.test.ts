import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('workspace target authority integration', () => {
  it('reconciles conservative real-path pins before run services and scheduler recovery', () => {
    const service = indexSource.indexOf('const workspaceService = new WorkspaceService({')
    const reconcile = indexSource.indexOf(
      'await workspaceService.reconcileWorkspaceRealPaths',
      service
    )
    const runQueue = indexSource.indexOf('const runQueueService = new RunQueueService({', service)
    const occurrenceReplay = indexSource.indexOf(
      'const occurrenceReplay = AppStore.replayScheduledOccurrenceMutations()',
      service
    )
    const remoteWorkflowActions = indexSource.indexOf(
      'const remoteWorkflowActions = new RemoteWorkflowActions({',
      service
    )
    const runQueueRecovery = indexSource.indexOf(
      'const startupRecoveryRecords = AppStore.recoverRunQueueAfterStartup()',
      service
    )
    const scheduledRecovery = indexSource.indexOf(
      'AppStore.recoverInterruptedScheduledTasksAfterStartup()',
      service
    )
    const schedulerTimer = indexSource.indexOf('scheduleNextTaskTimer()', service)

    expect(service).toBeGreaterThanOrEqual(0)
    expect(reconcile).toBeGreaterThan(service)
    expect(occurrenceReplay).toBeGreaterThan(reconcile)
    expect(runQueue).toBeGreaterThan(occurrenceReplay)
    expect(remoteWorkflowActions).toBeGreaterThan(occurrenceReplay)
    expect(runQueueRecovery).toBeGreaterThan(occurrenceReplay)
    expect(scheduledRecovery).toBeGreaterThan(occurrenceReplay)
    expect(schedulerTimer).toBeGreaterThan(occurrenceReplay)
  })

  it('fails scheduled startup closed when occurrence replay is blocked', () => {
    const replay = indexSource.indexOf(
      'const occurrenceReplay = AppStore.replayScheduledOccurrenceMutations()'
    )
    const blocked = indexSource.indexOf("if (occurrenceReplay.status === 'blocked')", replay)
    const scheduledRecovery = indexSource.indexOf(
      'AppStore.recoverInterruptedScheduledTasksAfterStartup()',
      replay
    )
    const guardedRecovery = indexSource.lastIndexOf(
      'if (!scheduledOccurrenceRecoveryBlockedReason)',
      scheduledRecovery
    )
    const emitGuard = indexSource.indexOf(
      'if (scheduledOccurrenceRecoveryBlockedReason) {',
      indexSource.indexOf('function emitDueScheduledTasks()')
    )

    expect(replay).toBeGreaterThanOrEqual(0)
    expect(blocked).toBeGreaterThan(replay)
    expect(guardedRecovery).toBeGreaterThan(blocked)
    expect(guardedRecovery).toBeLessThan(scheduledRecovery)
    expect(emitGuard).toBeGreaterThanOrEqual(0)
  })
})
