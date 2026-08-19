import fs from 'fs'
import { describe, expect, it } from 'vitest'

const indexSource = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('sub-thread return main-process integration (ledger + projection, no auto-dispatch)', () => {
  it('durably ledgers the return before transcript dedupe can bail', () => {
    const producer = sourceBetween(
      'async function maybePropagateLinkedChildResult(',
      'function subThreadJoinTimerKey('
    )
    const enqueue = producer.indexOf('AppStore.enqueueSubThreadMailboxEvent({')
    const existingReturn = producer.indexOf('if (existingReturnForAssistant)')

    expect(enqueue).toBeGreaterThanOrEqual(0)
    expect(existingReturn).toBeGreaterThan(enqueue)
    expect(producer).toContain('sourceAssistantMessageId,')
    expect(producer).toContain('outcome: terminal.outcome')
    expect(producer).toContain('joinPolicy: linkedChild.delegationContext.joinPolicy')
    expect(producer).toContain('sourceRelation: decision.relation')
    expect(producer).toContain("resultTrust: 'untrusted-child-output'")
    expect(producer).toContain("providerContextVisibility: 'projection-only'")
    // UI-only wave stamp from durable join.groupId — create + backfill, never invented.
    expect(producer).toContain('resolveParallelResultWaveId(')
    expect(producer).toContain('parallelResultWaveId')
    expect(producer).toContain('mailboxResult.event.join')
  })

  it('has no auto-dispatch leg: a return can never start or ride a parent run', () => {
    // 2026-08-19 Cambridge regression: the user cancelled a round and the
    // mailbox drain immediately started another. The removal is structural —
    // none of the delivery machinery may exist, in any spelling. Agent-side
    // visibility is the pending-result context block at prompt composition
    // plus the list_subthreads({waveId}) poll and read_subthread_result.
    expect(indexSource).not.toContain('maybeDrainParentSubThreadMailbox')
    expect(indexSource).not.toContain('maybeDrainEnsembleSubThreadMailbox')
    expect(indexSource).not.toContain('dispatchParentRunWithPendingSubThreadMailbox')
    expect(indexSource).not.toContain('shouldAutoResumeParent')
    expect(indexSource).not.toContain('shouldDrainEnsembleMailbox')
    expect(indexSource).not.toContain('resolveAuthoritySeat')
    expect(indexSource).not.toContain('buildSubThreadMailboxContinuationPrompt')
    expect(indexSource).not.toContain('attachSubThreadMailboxToParentPrompt')
    expect(indexSource).not.toContain('claimSubThreadMailboxEvents')
    expect(indexSource).not.toContain('acknowledgeSubThreadMailboxDelivery')
    expect(indexSource).not.toContain('releaseSubThreadMailboxDelivery')
    expect(indexSource).not.toContain('createSubThreadMailboxDeliveryRunId')
    expect(indexSource).not.toContain('subThreadMailboxDeliveriesInFlight')
  })

  it('keeps the join deadline reaper alive without a delivery leg', () => {
    const timer = sourceBetween(
      'function scheduleSubThreadJoinEvaluation(',
      'async function failHungEphemeralFleetWorkersOnJoinDeadline('
    )
    expect(timer).toContain('ensureSubThreadJoinDeadlineEvent(parentChatId, current)')
    expect(timer).toContain('failHungEphemeralFleetWorkersOnJoinDeadline(parentChatId, groupId)')

    const reaper = sourceBetween(
      'async function failHungEphemeralFleetWorkersOnJoinDeadline(',
      'function recoverSubThreadControlPlane()'
    )
    expect(reaper).toContain('selectHungEphemeralFleetWorkers(')
    // Stamp `cancelled` on the persisted row BEFORE aborting (flusher contract).
    expect(reaper).toContain("status: 'cancelled' as const")
    expect(reaper).toContain('settleSubThreadWorkerRun(subThreadId, runId')
    expect(reaper).toContain("outcome: 'cancelled'")

    // Startup recovery keeps its orphan-run settle + worker-queue + join-timer
    // legs (renamed — the old name advertised the deleted drain leg).
    expect(indexSource).toContain('recoverSubThreadControlPlane()')
    expect(indexSource).not.toContain('recoverPendingSubThreadMailboxes')
    const recovery = sourceBetween(
      'function recoverSubThreadControlPlane()',
      '/**\n * Surface a sub-thread-dispatch failure'
    )
    expect(recovery).toContain('reconcileStaleChatRunsProjection({ minAgeMs: 0 })')
    expect(recovery).toContain('recoverSubThreadWorkerQueues()')
    expect(recovery).toContain('scheduleSubThreadJoinEvaluation(')
  })

  it('broadcasts the parent in the same synchronous turn as its save (wave-return ordering)', () => {
    const producer = sourceBetween(
      'async function maybePropagateLinkedChildResult(',
      'function subThreadJoinTimerKey('
    )
    const saveParent = producer.indexOf('AppStore.saveChat(updatedParent)')
    const broadcastParent = producer.indexOf('broadcastChatUpdated(updatedParent)')
    const primarySettle = producer.indexOf(
      'const primarySettle = await settleEphemeralFleetWriterIfNeeded('
    )
    expect(saveParent).toBeGreaterThanOrEqual(0)
    expect(broadcastParent).toBeGreaterThan(saveParent)
    expect(primarySettle).toBeGreaterThan(broadcastParent)
    // No awaited gap between the parent save and its broadcast: a sibling wave
    // child returning inside such a gap saves + broadcasts a FRESHER parent
    // revision first, turning this broadcast into a stale out-of-order
    // rebroadcast that regresses the transcript and degrades the patch chain
    // to full snapshots during return bursts.
    expect(producer.slice(saveParent, broadcastParent)).not.toContain('await ')
  })

  it('settles ephemeral fleet worktrees before archive, including empty done', () => {
    const producer = sourceBetween(
      'async function maybePropagateLinkedChildResult(',
      'function subThreadJoinTimerKey('
    )
    const helper = sourceBetween(
      'async function settleEphemeralFleetWriterIfNeeded(input: {',
      'async function maybePropagateLinkedChildResult('
    )
    const emptyGate = producer.indexOf("terminal.outcome === 'done'")
    const afterEmpty = producer.indexOf(
      'const { sourceAssistantMessageId, sourceRunId, resultContent } = decision'
    )
    expect(emptyGate).toBeGreaterThanOrEqual(0)
    expect(afterEmpty).toBeGreaterThan(emptyGate)
    const emptyRegion = producer.slice(emptyGate, afterEmpty)
    expect(emptyRegion).toContain('settleEphemeralFleetWriterIfNeeded')
    expect(emptyRegion).toContain('shouldArchiveEphemeralFleetChild')
    expect(helper).toContain('await settleEphemeralFleetWriterWorktreeOnReturn')
    expect(indexSource).not.toContain('void settleEphemeralFleetWriterWorktreeOnReturn')
    expect(producer).toContain('shouldArchiveEphemeralFleetAfterSettle')
    expect(producer).toContain('archiveEphemeral:')
    // Repair + primary return paths: settle completes before mark/archive.
    const repairSettle = producer.indexOf('settleEphemeralFleetWriterIfNeeded(', afterEmpty)
    const repairMark = producer.indexOf('markLinkedChildResultReturned(', afterEmpty)
    expect(repairSettle).toBeGreaterThan(afterEmpty)
    expect(repairMark).toBeGreaterThan(repairSettle)
  })

  it('keeps delegation worker trust caps and join scheduling on the spawn path', () => {
    const delegation = sourceBetween(
      "} else if (toolName === 'delegate_to_subthread') {",
      'const finalRichResult = richResult as McpToolExecutionResult | null'
    )
    expect(indexSource).toContain('scheduleSubThreadJoinEvaluation(')
    expect(indexSource).toContain("outcome: 'requires_action'")
    expect(delegation).toContain('joinPolicy')
    expect(delegation).toContain('sessionTrust: false')
    expect(delegation).toContain('resolveSubThreadWorkerPermissions({')
    expect(delegation).toContain("presetId: 'read_only'")
    expect(indexSource).toContain('child.delegationContext?.workerControl?.events')
  })

  it('dispatches through the run facade with no mailbox attachment tail', () => {
    // The facade wrapper survives for its history-clear gate and solo-wakeup
    // cancel; only its mailbox attachment tail is gone (absence pinned above).
    expect(indexSource).toContain('createRunDispatchFacade(runDispatchFacadeDeps)')
    expect(indexSource).toContain('return baseDispatchRunWithProviderPause(payload, event, observer)')
  })
})
