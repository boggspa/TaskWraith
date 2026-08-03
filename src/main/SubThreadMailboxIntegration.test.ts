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

describe('sub-thread mailbox main-process integration', () => {
  it('durably enqueues before transcript dedupe can return', () => {
    const producer = sourceBetween(
      'async function maybePropagateLinkedChildResult(',
      'const SUBTHREAD_MAILBOX_DELIVERY_BATCH_LIMIT'
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
  })

  it('claims before dispatch, then acknowledges success or releases failure', () => {
    const drain = sourceBetween(
      'async function maybeDrainParentSubThreadMailbox(',
      'function recoverPendingSubThreadMailboxes()'
    )
    const claim = drain.indexOf('AppStore.claimSubThreadMailboxEvents(')
    const dispatch = drain.indexOf('dispatchRunWithProviderPauseRef(payload, { sender })')
    const acknowledge = drain.indexOf('AppStore.acknowledgeSubThreadMailboxDelivery(')

    expect(claim).toBeGreaterThanOrEqual(0)
    expect(dispatch).toBeGreaterThan(claim)
    expect(acknowledge).toBeGreaterThan(dispatch)
    expect(drain).toContain('AppStore.releaseSubThreadMailboxDelivery(')
    expect(drain).toContain('createSubThreadMailboxDeliveryRunId(')
    expect(drain).toContain('sessionTrust: false')
    // Solo drain must not flip ensembles through shouldAutoResumeParent —
    // ensemble parents branch to maybeDrainEnsembleSubThreadMailbox first.
    expect(drain).toContain("parent.chatKind === 'ensemble'")
    expect(drain).toContain('maybeDrainEnsembleSubThreadMailbox(parentChatId)')
  })

  it('keeps delivery under the hood and wires terminal/startup replay seams', () => {
    const drain = sourceBetween(
      'async function maybeDrainParentSubThreadMailbox(',
      'function recoverPendingSubThreadMailboxes()'
    )

    expect(drain).not.toContain('autoresume-prompt-')
    expect(drain).not.toContain('AUTO_RESUME_CONTINUATION_KIND')
    expect(indexSource).toContain('void maybeDrainParentSubThreadMailbox(event.session.appChatId)')
    expect(indexSource).toContain('recoverPendingSubThreadMailboxes()')
    expect(indexSource).toContain('async function maybeDrainEnsembleSubThreadMailbox(')
  })

  it('attaches pending events to the next ordinary parent dispatch without bypassing main', () => {
    const attachment = sourceBetween(
      'async function dispatchParentRunWithPendingSubThreadMailbox(',
      '/**\n * Surface a sub-thread-dispatch failure'
    )

    expect(attachment).toContain("parentPrompt.trimStart().startsWith('/')")
    expect(attachment).toContain('buildSubThreadMailboxContinuationPrompt(claimed.events)')
    expect(attachment).toContain('attachSubThreadMailboxToParentPrompt(parentPrompt, mailboxPrompt)')
    expect(attachment).toContain('originalPostureWasValid')
    expect(attachment).toContain('verifyRunPosture(')
    expect(attachment).toContain('runPostureContextFromPayload(mailboxPayload)')
    expect(attachment).toContain('await dispatch(mailboxPayload, event, observer)')
    expect(attachment).toContain('AppStore.acknowledgeSubThreadMailboxDelivery(')
    expect(attachment).toContain('AppStore.releaseSubThreadMailboxDelivery(')
    expect(attachment).not.toContain('taskWraithMcpProfileId:')
  })

  it('wraps the normal dispatch facade instead of creating a parallel runtime path', () => {
    expect(indexSource).toContain(
      'const baseDispatchRunWithProviderPause = createRunDispatchFacade(runDispatchFacadeDeps)'
    )
    expect(indexSource).toContain('dispatchParentRunWithPendingSubThreadMailbox(')
    const runtimeProfile = sourceBetween(
      'function applyRuntimeProfileToPayload(',
      'async function getCliProviderStatus('
    )
    expect(runtimeProfile).toContain('const resolution = resolveTaskWraithMcpProfile({')
    expect(runtimeProfile).toContain('const providerSeat = applyProviderSeatGeneration({')
    expect(runtimeProfile).toContain('applied.taskWraithMcpProfileId = providerSeat.profileId')
  })

  it('gates automatic wake by durable join readiness and preserves worker trust caps', () => {
    const drain = sourceBetween(
      'async function maybeDrainParentSubThreadMailbox(',
      'function recoverPendingSubThreadMailboxes()'
    )
    const ensembleDrain = sourceBetween(
      'async function maybeDrainEnsembleSubThreadMailbox(',
      'async function maybeDrainParentSubThreadMailbox('
    )
    const delegation = sourceBetween(
      "} else if (toolName === 'delegate_to_subthread') {",
      'const finalRichResult = richResult as McpToolExecutionResult | null'
    )

    expect(drain).toContain('deliverableSubThreadMailboxEvents(parentChatId, pending)')
    expect(ensembleDrain).toContain('deliverableSubThreadMailboxEvents(parentChatId, pending)')
    expect(ensembleDrain).toContain('shouldDrainEnsembleMailbox({')
    expect(indexSource).toContain('scheduleSubThreadJoinEvaluation(')
    expect(indexSource).toContain("outcome: 'requires_action'")
    expect(delegation).toContain('joinPolicy')
    expect(delegation).toContain('sessionTrust: false')
    expect(delegation).toContain('resolveSubThreadWorkerPermissions({')
    expect(delegation).toContain("presetId: 'read_only'")
    expect(indexSource).toContain('child.delegationContext?.workerControl?.events')
  })
})
