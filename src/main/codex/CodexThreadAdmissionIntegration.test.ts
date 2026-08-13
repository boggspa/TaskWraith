import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('Codex app-server thread admission integration', () => {
  it('reserves a normal resumed thread before setup and retains exact terminal ownership', () => {
    const provider = between(
      'async function runCodexAppServerWithClient(',
      'async function runCodexExecFallback('
    )
    const reserved = provider.indexOf('codexThreadAdmissionRegistry.reserve({')
    const acquired = provider.indexOf('await waitForCodexThreadAdmission(', reserved)
    const started = provider.indexOf('await client.ensureStarted', acquired)
    const launchPlan = provider.indexOf('buildCodexAppServerThreadLaunchPlan({', started)
    const requestedThread = provider.indexOf(
      'threadResponse = await client.request(\n      threadLaunchPlan.request.method',
      launchPlan
    )
    const stateBound = provider.indexOf("codexState.admissionKind = 'turn'", requestedThread)
    const registered = provider.indexOf('registerRunSession(', stateBound)
    const requested = provider.indexOf("const turnStartResult = await client.request(\n      'turn/start'", registered)
    const exactBound = provider.indexOf('bindCodexRunExactOperationId(codexState', requested)

    expect(reserved).toBeGreaterThanOrEqual(0)
    expect(reserved).toBeLessThan(acquired)
    expect(acquired).toBeLessThan(started)
    expect(started).toBeLessThan(launchPlan)
    expect(launchPlan).toBeLessThan(requestedThread)
    expect(requestedThread).toBeLessThan(stateBound)
    expect(stateBound).toBeLessThan(registered)
    expect(registered).toBeLessThan(requested)
    expect(requested).toBeLessThan(exactBound)
    expect(provider).not.toContain('pendingCompactionAtDispatch')
    expect(provider).toContain('signal: payload.providerSetupAbortSignal')
    expect(provider).toContain(
      'isTerminalClaimed: () => Boolean(runManager.getClaimedTerminalStatus(payload.appRunId))'
    )
    expect(provider).not.toContain('await admissionReservation.waitUntilAcquired()')
  })

  it('publishes manual compaction state only after the shared admission is acquired', () => {
    const compaction = between(
      'async function compactCodexProviderContext(',
      '/**\n * Host-triggered Claude context compaction'
    )
    const reserved = compaction.indexOf('codexThreadAdmissionRegistry.reserve({')
    const acquired = compaction.indexOf('await admissionReservation.waitUntilAcquired()', reserved)
    const published = compaction.indexOf('pendingCodexManualCompactions.set(', acquired)
    const started = compaction.indexOf('await client.ensureStarted', published)
    const compactRequest = compaction.indexOf("'thread/compact/start'", started)
    const timeout = compaction.indexOf(
      "isCodexAppServerRequestTimeout(firstError, 'thread/compact/start')",
      compactRequest
    )
    const noRetry = compaction.indexOf('throw firstError', timeout)

    expect(reserved).toBeGreaterThanOrEqual(0)
    expect(reserved).toBeLessThan(acquired)
    expect(acquired).toBeLessThan(published)
    expect(published).toBeLessThan(started)
    expect(started).toBeLessThan(compactRequest)
    expect(timeout).toBeLessThan(noRetry)
  })

  it('journals manual compaction usage only from its exact terminal notification', () => {
    const notifications = between(
      'function handleCodexManualCompactionNotification(message: any): void {',
      '/**\n * Append the persisted "Context compacted" system card'
    )
    const usageSnapshot = notifications.indexOf('pending.tokenUsage = tokenUsage')
    const terminal = notifications.indexOf(
      "message.method === 'turn/completed' || message.method === 'turn/failed'"
    )
    const usageRecord = notifications.indexOf('recordCodexUsageOnCompletion({', terminal)
    const settle = notifications.indexOf('pending.settle({ ok: true })', terminal)

    expect(usageSnapshot).toBeGreaterThanOrEqual(0)
    expect(terminal).toBeGreaterThan(usageSnapshot)
    expect(usageRecord).toBeGreaterThan(terminal)
    expect(usageRecord).toBeLessThan(settle)
    expect(notifications).toContain('runId: `codex-maintenance:${pending.turnId}`')
  })

  it('uses the same lane and exact response id for inline native review', () => {
    const review = between("'start-agent-review'", '// Single source for per-provider model catalogs')
    const verified = review.indexOf('const reviewDispatchPayload = normalizeAgentRunPayload(')
    const lifecycle = review.indexOf('acquireProviderRunLifecycleOwnership(', verified)
    const reserved = review.indexOf('codexThreadAdmissionRegistry.reserve({')
    const acquired = review.indexOf('await waitForCodexThreadAdmission(', reserved)
    const started = review.indexOf('await client.ensureStarted', acquired)
    const stateBound = review.indexOf("reviewState.admissionKind = 'review'", started)
    const requested = review.indexOf("'review/start'", stateBound)
    const exactBound = review.indexOf('bindCodexRunExactOperationId(reviewState', requested)

    expect(verified).toBeGreaterThanOrEqual(0)
    expect(review).toContain('Native review permission posture failed main verification.')
    expect(review).toContain('reviewDispatchPayload.effectivePermissionsSignature !== claimedSignature')
    expect(verified).toBeLessThan(lifecycle)
    expect(lifecycle).toBeLessThan(reserved)
    expect(reserved).toBeGreaterThanOrEqual(0)
    expect(reserved).toBeLessThan(acquired)
    expect(acquired).toBeLessThan(started)
    expect(started).toBeLessThan(stateBound)
    expect(stateBound).toBeLessThan(requested)
    expect(requested).toBeLessThan(exactBound)
    expect(review).toContain("delivery: 'inline'")
    expect(review).toContain('result.reviewThreadId !== threadId')
    expect(review).toContain('signal: lifecycleOwnership.setupAbortSignal')
    expect(review).toContain('runManager.canAdmitTransport(lifecycleOwnership.runId, true)')
  })

  it('fences terminal notifications and approval requests with the exact operation id', () => {
    const notifications = between(
      'function handleCodexNotification(message: any)',
      'function formatCodexApprovalRequest('
    )
    const childRoute = notifications.indexOf('findCodexMultiAgentOwnerState(String(messageThreadId))')
    const exactFence = notifications.indexOf('codexNotificationBelongsToRunState(state, message)')
    const terminal = notifications.indexOf("message.method === 'turn/completed'", exactFence)
    expect(childRoute).toBeGreaterThanOrEqual(0)
    expect(childRoute).toBeLessThan(exactFence)
    expect(exactFence).toBeLessThan(terminal)

    // End-marker follows handleCodexServerRequest in index.ts; the function was named
    // maybeRequestCodexHostRerun (the test's old `sendCodexHostRerunRequired` never existed).
    const requests = between('function handleCodexServerRequest(message: any)', 'function maybeRequestCodexHostRerun(')
    expect(requests).toContain('const requestOperationId = codexProviderOperationId(message)')
    expect(requests).toContain(
      'state.admissionReservation?.matchesExactOperationId(requestOperationId)'
    )
  })
})
