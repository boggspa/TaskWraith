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
  it('can rehydrate graph-owned rows for projections without treating chat config as authority', () => {
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

  it('keeps graph-owned rows out of the renderer lease and dispatch pump', () => {
    const queueSelector = sourceBetween(
      'const getQueuedDesktopRunJobs =',
      'const resolveQueuedDesktopRunRequest ='
    )

    expect(queueSelector).toContain('.filter((job) => !job.executionGraph)')
  })
})
