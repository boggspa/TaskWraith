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
    const scheduledRecovery = indexSource.indexOf(
      'AppStore.recoverInterruptedScheduledTasksAfterStartup()',
      service
    )
    const schedulerTimer = indexSource.indexOf('scheduleNextTaskTimer()', service)

    expect(service).toBeGreaterThanOrEqual(0)
    expect(reconcile).toBeGreaterThan(service)
    expect(runQueue).toBeGreaterThan(reconcile)
    expect(scheduledRecovery).toBeGreaterThan(reconcile)
    expect(schedulerTimer).toBeGreaterThan(reconcile)
  })
})
