import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string): string {
  const startIndex = appSource.indexOf(start)
  const endIndex = appSource.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return appSource.slice(startIndex, endIndex)
}

describe('execution-graph queued-run authority', () => {
  it('rehydrates graph-owned jobs from their persisted request instead of pending chat config', () => {
    const rehydrator = sourceBetween(
      'const queuedRunRequestFromJob =',
      'const discordContextSelectionQueueKey ='
    )
    const resolver = sourceBetween(
      'const resolveQueuedDesktopRunRequest =',
      'const applyRecoveryRecordsToChats ='
    )

    expect(rehydrator).toContain('const isExecutionGraphJob = Boolean(job.executionGraph)')
    expect(rehydrator).toContain(
      '!isExecutionGraphJob && chatRecord && hasPendingProviderChange(chatRecord)'
    )
    expect(rehydrator).toMatch(
      /const selectedModel = isExecutionGraphJob\s+\? request\.selectedModelType/
    )
    expect(resolver).toContain('if (job.executionGraph) {')
    expect(resolver).toContain('return queuedRunRequestFromJob(job, workspaces')
  })

  it('does not finalize pending chat changes or replace the leased provider at dispatch', () => {
    const scheduler = sourceBetween(
      'const queuedJobs = getQueuedDesktopRunJobs(runQueueJobs)',
      "window.localStorage.setItem('taskwraith.workspaceSidebarWidth'"
    )

    expect(scheduler).toContain('const isExecutionGraphDispatch = Boolean(leased.executionGraph)')
    expect(scheduler).toMatch(
      /if \(\s*!isExecutionGraphDispatch &&\s*dispatchChat &&\s*\(hasPendingProviderChange/
    )
    expect(scheduler).toMatch(
      /const dispatchProvider = isExecutionGraphDispatch\s+\? leased\.provider\s+: getChatProvider/
    )
    expect(scheduler).toContain('provider: dispatchProvider')
  })
})
