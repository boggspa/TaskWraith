import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

describe('renderer run queue lease pump', () => {
  it('claims a durable row before IPC and removes its mirror only after lease acceptance', () => {
    const start = appSource.indexOf('const queuedJobs = getQueuedDesktopRunJobs(runQueueJobs)')
    const end = appSource.indexOf('}, [queuedRuns, runningChatIds, runQueueJobs,', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const pump = appSource.slice(start, end)

    const claim = pump.indexOf('queuedDispatchLeaseClaimsRef.current.tryClaim(')
    const lease = pump.indexOf('.leaseRunQueueJob({')
    const accepted = pump.indexOf('if (!leased) {')
    const remove = pump.indexOf('removeExactQueuedRunRequest(prev, nextRunId)')

    expect(claim).toBeGreaterThanOrEqual(0)
    expect(lease).toBeGreaterThan(claim)
    expect(accepted).toBeGreaterThan(lease)
    expect(remove).toBeGreaterThan(accepted)
    expect(pump).toContain('!queuedDispatchLeaseClaimsRef.current.has(request.appRunId)')
    expect(pump).toContain('queuedDispatchLeaseClaimsRef.current.release(nextRunId)')
  })
})
