import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start, `Missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0)
  expect(end, `Missing end marker: ${endMarker}`).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

function expectContains(source: string, needle: string): void {
  expect(source.includes(needle), `Missing source contract: ${needle}`).toBe(true)
}

describe('sub-thread long-lived worker main-process integration', () => {
  it('opts active recall into the durable queue without seeding the child transcript early', () => {
    const delegation = sourceBetween(
      "} else if (toolName === 'delegate_to_subthread') {",
      'const finalRichResult = richResult as McpToolExecutionResult | null'
    )

    expectContains(delegation, 'allowActiveWorker: true')
    expectContains(delegation, "recallResolution.mode === 'active'")
    expectContains(delegation, 'enqueueSubThreadWorkerEvent(')
    expectContains(delegation, 'sourceToolCallId: toolId')
    expectContains(delegation, 'priority: workerPriority')
    expectContains(delegation, 'cancelProviderRun(providerArg, recallResolution.activeRunId)')
    expectContains(delegation, 'workerPermissions.effectivePermissions')
    expectContains(delegation, "presetId: 'read_only'")
    expectContains(delegation, "providerContextVisibility: 'projection-only'")
    expect(delegation.indexOf('enqueueSubThreadWorkerEvent(')).toBeLessThan(
      delegation.indexOf('seedAgentDrivenSubThreadTranscript({')
    )
  })

  it('claims and prebinds the stable run identity before normal RunCoordinator dispatch', () => {
    const drain = sourceBetween(
      'async function maybeDrainSubThreadWorkerQueue(',
      'function recoverSubThreadWorkerQueues()'
    )

    expectContains(drain, 'claimNextSubThreadWorkerEvent(')
    expectContains(drain, 'plannedRunId: claimed.event.plannedRunId')
    expectContains(drain, 'workerEventClaim:')
    expectContains(drain, 'resolveSubThreadWorkerPermissions(')
    expectContains(drain, "presetId: 'read_only'")
    expectContains(drain, 'runCoordinatorRef.dispatch(')
    expectContains(drain, 'sessionTrust: false')
  })

  it('fails closed for workers queued by a scheduled parent without waking that parent', () => {
    const drain = sourceBetween(
      'async function maybeDrainSubThreadWorkerQueue(',
      'function recoverSubThreadWorkerQueues()'
    )
    const localFailure = sourceBetween(
      'function failClaimedScheduledParentSubThreadWorker(',
      'function settleSubThreadWorkerRun('
    )

    expectContains(drain, 'wasScheduledOccurrenceRunIdObserved(event.parentRunId)')
    expectContains(drain, 'failClaimedScheduledParentSubThreadWorker(chat, event, claimId)')
    expect(drain.indexOf('wasScheduledOccurrenceRunIdObserved(event.parentRunId)')).toBeLessThan(
      drain.indexOf('failClaimedSubThreadWorker(')
    )
    expectContains(localFailure, 'failClaimedSubThreadWorkerEvent(')
    expect(localFailure).not.toContain('enqueueSubThreadMailboxEvent(')
    expect(localFailure).not.toContain('maybeDrainParentSubThreadMailbox(')
  })

  it('rejects scheduled delegation before approval, spawn, or recall dispatch', () => {
    const delegation = sourceBetween(
      "} else if (toolName === 'delegate_to_subthread') {",
      'const finalRichResult = richResult as McpToolExecutionResult | null'
    )
    const guard = delegation.indexOf(
      'wasScheduledOccurrenceRunIdObserved(context.appRunId)'
    )

    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(delegation.indexOf('resolveSubThreadRecall('))
    expect(guard).toBeLessThan(delegation.indexOf('requestAgenticServiceApproval('))
    expect(guard).toBeLessThan(delegation.indexOf('seedAgentDrivenSubThreadTranscript({'))
  })

  it('settles terminal worker events, drains the next item, and recovers queues on startup', () => {
    expectContains(indexSource, 'settleSubThreadWorkerEvent(')
    expectContains(indexSource, 'recoverSubThreadWorkerControl(')
    expectContains(indexSource, 'recoverSubThreadWorkerQueues()')
    expectContains(indexSource, 'maybeDrainSubThreadWorkerQueue(')
    expectContains(indexSource, 'child.delegationContext?.workerControl?.events')
    expectContains(indexSource, 'isActiveChatRunStatus(run.status)')
    expectContains(indexSource, 'isChatRunLive(run.runId)')
    expectContains(indexSource, 'settleStaleChatRun(run, recoveredAt)')
  })

  it('reconciles orphaned chat.runs for all chats at startup and on a periodic sweep', () => {
    expectContains(indexSource, "from './ChatRunReconciler'")
    expectContains(indexSource, 'function isChatRunLive(')
    expectContains(indexSource, 'function reconcileStaleChatRunsProjection(')
    expectContains(indexSource, 'reconcileStaleChatRunsProjection({ minAgeMs: 0 })')
    expectContains(indexSource, 'getRunSession: (runId) => runManager.get(runId)')
    expectContains(indexSource, "eventType: 'chat_run_terminal_recovered'")
    expectContains(indexSource, 'chatRunReconcilerInterval = setInterval')
    expectContains(indexSource, 'pushBridgeRunTaskCardDelta?.(saved.appChatId)')
    expectContains(indexSource, 'broadcastThreadList()')
    expectContains(indexSource, 'broadcastRemoteProjectionSnapshot()')
    // Universal settle runs before sub-thread worker control recovery.
    const recoverPending = sourceBetween(
      'function recoverSubThreadControlPlane(): void {',
      '/**\n * Surface a sub-thread-dispatch failure'
    )
    expect(
      recoverPending.indexOf('reconcileStaleChatRunsProjection({ minAgeMs: 0 })')
    ).toBeLessThan(recoverPending.indexOf('recoverSubThreadWorkerQueues()'))
  })

  it('preserves the frozen Codex startup lease and canonical gateway target dispatch', () => {
    expectContains(indexSource, 'codexAppServerStartupLeaseCount')
    expectContains(indexSource, 'shouldRestartCodexAppServerForMcpConfig')
    expectContains(indexSource, 'dispatchResolvedGatewayTarget({')
    expectContains(indexSource, 'executeCanonical: executeGeminiMcpTool')
  })
})
