import type { ApprovalLedgerRequestInput } from '../store/types'
import type { MuseMspApprovalOutcome } from './MuseMspClient'

/** Provider acknowledgment is permission evidence; it is never tool execution evidence. */
export function museApprovalOutcomeRecord(input: {
  appRunId: string
  appChatId?: string
  workspacePath: string
  outcome: MuseMspApprovalOutcome
}): ApprovalLedgerRequestInput {
  const { outcome } = input
  return {
    approvalId: `${input.appRunId}:muse:${outcome.approvalId}:${outcome.requirementId.sourceIndex}:outcome`,
    runId: input.appRunId,
    chatId: input.appChatId,
    workspacePath: input.workspacePath,
    provider: 'muse',
    service: 'mcpTools',
    method: 'muse-msp/approval-outcome',
    title: outcome.allowApplied
      ? 'Muse accepted the permission decision'
      : 'Muse permission was not applied',
    actions: [],
    status: outcome.allowApplied
      ? 'approved'
      : outcome.kind === 'withdrawn'
        ? 'cancelled'
        : 'denied',
    decision: outcome.allowApplied
      ? 'autoAllow'
      : outcome.kind === 'withdrawn'
        ? 'cancel'
        : 'autoDeny',
    decisionSource: 'system',
    ...(outcome.grantScope
      ? { grantedScope: outcome.grantScope === 'once' ? 'request' : 'session' }
      : {}),
    expiration: {
      mode: 'none',
      description: 'Provider decision outcome; no pending human approval.'
    },
    metadata: { ...outcome, executionObserved: false }
  }
}
