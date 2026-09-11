import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function handleRunSource(): string {
  const startIndex = appSource.indexOf('  const handleRun = (')
  const endIndex = appSource.indexOf('  const handleRunRef =', startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return appSource.slice(startIndex, endIndex)
}

describe('composer submit ledger wiring', () => {
  // The whole point of the placement: one accept point ahead of the branch, so
  // dispatch, queue AND steer inherit it. Duplicates were most visible in the
  // queue, as a stack of identical copies of one message.
  it('accepts the submit before the dispatch, queue and steer branch', () => {
    const handleRun = handleRunSource()

    const acceptIndex = handleRun.indexOf('composerSubmitLedgerRef.current.accept(')
    const queueIndex = handleRun.indexOf('shouldQueueRunBeforeDispatch(')
    const steerIndex = handleRun.indexOf('appendBusyRunToExecutionStack(')
    const dispatchIndex = handleRun.indexOf('void executeRun(request)')
    const workflowIndex = handleRun.indexOf('void createWorkflowFromDraft(request)')

    expect(acceptIndex).toBeGreaterThanOrEqual(0)
    for (const branchIndex of [queueIndex, steerIndex, dispatchIndex, workflowIndex]) {
      expect(branchIndex).toBeGreaterThan(acceptIndex)
    }
  })

  // Identity is the draft revision, read for the chat whose draft supplied the
  // prompt — the same chat id `buildRunRequest` reads the text from.
  it('keys the submit on the composer draft revision', () => {
    expect(handleRunSource()).toContain(
      'composerDraftState.getDraftRevision(currentComposerChatId)'
    )
  })

  // A submit that carries its own text never moves the draft revision, so
  // deduping it would refuse every resend after the first one forever.
  it('scopes the ledger to submits that read the draft', () => {
    const handleRun = handleRunSource()
    const acceptIndex = handleRun.indexOf('composerSubmitLedgerRef.current.accept(')
    const guard = handleRun.slice(Math.max(0, acceptIndex - 220), acceptIndex)

    expect(guard).toContain('!existingPrompt')
    expect(guard).toContain('!backgroundTarget')
  })

  // An ignored repeat settles the one-send reference-context claim its request
  // took during construction; leaving it claimed would strand the selection.
  it('settles the rejected repeat rather than stranding its claim', () => {
    const handleRun = handleRunSource()
    const acceptIndex = handleRun.indexOf('composerSubmitLedgerRef.current.accept(')
    const afterAccept = handleRun.slice(acceptIndex, acceptIndex + 260)

    expect(afterAccept).toContain("settleProjectReferenceContextForRequest(request, 'rejected')")
  })
})
