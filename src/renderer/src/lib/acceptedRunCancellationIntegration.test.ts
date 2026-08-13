import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const preloadTypes = readFileSync(new URL('../../../preload/index.d.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startIndex = appSource.indexOf(start)
  const endIndex = appSource.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return appSource.slice(startIndex, endIndex)
}

describe('accepted renderer run cancellation integration', () => {
  it('seeds renderer-created runs as starting so reconciliation can recover them', () => {
    const runSeed = between('const newRun: ChatRun = {', 'chatToUpdate.runs = [')

    expect(runSeed).toContain("status: 'starting'")
  })

  it('uses the exact chat-scoped target and only finalizes an accepted Stop', () => {
    const cancel = between(
      'const cancelExactSoloChatRun = async',
      'const cancelLinkedChatRun = async'
    )

    expect(cancel).toContain('resolveSteerCancelTargetRunId({')
    expect(cancel).toContain('activeContext')
    expect(cancel).toContain('runQueueJobs: runQueueJobsRef.current')
    expect(cancel).toContain('const accepted = await window.api.cancelAgentRun(provider, runId)')
    expect(cancel).toContain('if (!accepted)')
    expect(cancel.indexOf('if (!accepted)')).toBeLessThan(
      cancel.indexOf('finalizeAcceptedRendererRunCancellation(')
    )
  })

  it('seals, ends, and clears only the exact accepted run context', () => {
    const finalize = between(
      'const finalizeAcceptedRendererRunCancellation =',
      'const cancelExactSoloChatRun = async'
    )

    expect(finalize).toContain('finalizeAcceptedRunCancellationChat(source, runId, endedAt)')
    expect(finalize).toContain('activeContext?.runId === runId ? activeContext : null')
    expect(finalize.indexOf('exactContext?.adapter.end()')).toBeLessThan(
      finalize.indexOf('clearActiveRunContext(exactContext)')
    )
    expect(finalize).toContain('exitCode: 130')
    expect(finalize).toContain('setIsThinking(false)')
  })

  it('types cancellation IPC as an acceptance result', () => {
    expect(preloadTypes).toContain(
      'cancelAgentRun: (provider?: ProviderId, runId?: string) => Promise<boolean>'
    )
  })
})
