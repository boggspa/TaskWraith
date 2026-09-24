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

function handleRunSource(): string {
  return sourceBetween(appSource, '  const handleRun = (', '  const handleRunRef =')
}

describe('composer dispatch latch wiring', () => {
  // The hole is the window where the chat is not busy YET, because `executeRun`
  // has not registered the run. Feeding the claim into the same busy argument
  // `isChatBusy` feeds is what closes it.
  it('counts a dispatch in flight as busy for the queue decision', () => {
    const handleRun = handleRunSource()

    const holderIndex = handleRun.indexOf('chatDispatchLatchRef.current.holderRunId(targetChatId)')
    const queueDecisionIndex = handleRun.indexOf('shouldQueueRunBeforeDispatch({')

    expect(holderIndex).toBeGreaterThanOrEqual(0)
    expect(queueDecisionIndex).toBeGreaterThan(holderIndex)
    expect(handleRun).toContain('busy: isChatBusy(targetChatId) || dispatchInFlight')
  })

  // Refusing was the first shape and it ate a real second message typed inside
  // the dispatch window. The claim must now be unconditional.
  it('never turns a claim into a dropped submit', () => {
    const handleRun = handleRunSource()

    expect(handleRun).toContain(
      'chatDispatchLatchRef.current.claim(targetChatId, request.appRunId)'
    )
    expect(handleRun).not.toContain('if (!chatDispatchLatchRef.current.claim(')
  })

  it('claims the chat before it dispatches', () => {
    const handleRun = handleRunSource()

    const claimIndex = handleRun.indexOf('chatDispatchLatchRef.current.claim(')
    const dispatchIndex = handleRun.indexOf('void executeRun(request)')

    expect(claimIndex).toBeGreaterThanOrEqual(0)
    expect(dispatchIndex).toBeGreaterThan(claimIndex)
  })

  // Queueing is a different condition (a run is already RUNNING) and stays the
  // user's ordered second turn.
  it('leaves the busy-chat queue branch in place', () => {
    const handleRun = handleRunSource()

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
