import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('composer dispatch latch wiring', () => {
  // The guard has to sit on the DISPATCH branch, not merely exist: the queue
  // branch above it already handles a busy chat, and the hole is the window
  // where the chat is not busy yet because `executeRun` has not registered the
  // run. A claim placed after the dispatch would latch nothing.
  it('claims the chat before handleRun dispatches a composer submit', () => {
    const handleRun = sourceBetween(appSource, '  const handleRun = (', '  const handleRunRef =')

    const claimIndex = handleRun.indexOf('chatDispatchLatchRef.current.claim(')
    const dispatchIndex = handleRun.indexOf('void executeRun(request)')

    expect(claimIndex).toBeGreaterThanOrEqual(0)
    expect(dispatchIndex).toBeGreaterThan(claimIndex)
  })

  // Queueing is a different condition (a run is already RUNNING) and stays the
  // user's ordered second turn. The latch must not have replaced it.
  it('leaves the busy-chat queue branch in place', () => {
    const handleRun = sourceBetween(appSource, '  const handleRun = (', '  const handleRunRef =')

    expect(handleRun).toContain('shouldQueueRunBeforeDispatch(')
    expect(handleRun).toContain('queueRunRequest(request)')
  })

  // Released in a `finally`, so a throw between claim and registration cannot
  // wedge the chat for the rest of the session.
  it('releases the claim when the dispatch settles, on every path', () => {
    const executeRun = sourceBetween(
      appSource,
      '  const executeRun = async',
      '  const executeRunRef ='
    )

    const releaseIndex = executeRun.indexOf('chatDispatchLatchRef.current.release(')
    expect(releaseIndex).toBeGreaterThanOrEqual(0)
    expect(executeRun.slice(0, releaseIndex)).toContain('} finally {')
  })
})
