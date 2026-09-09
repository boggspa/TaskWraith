import { describe, expect, it } from 'vitest'
import { createRunToolCapabilityReceipt } from './RunToolCapabilityReceipt'
import { prepareRunEventPayload } from '../RunEventStore'
import {
  approvalRecordToolRefusal,
  createRunToolCapabilityReporter,
  getRunToolCapabilityReporter,
  withRunToolApprovalRefusals
} from './RunToolCapabilityRuntime'
import type { ApprovalLedgerRecord } from '../store/types'

/** Complete ledger rows, so the runtime is exercised against the real record
 * shape rather than a partial literal cast past the compiler. */
const ledgerRecord = (
  overrides: Partial<ApprovalLedgerRecord> & Pick<ApprovalLedgerRecord, 'approvalId'>
): ApprovalLedgerRecord => ({
  schemaVersion: 1,
  id: `ledger-${overrides.approvalId}`,
  provider: 'antigravity',
  method: 'native',
  title: 'scope',
  actions: [],
  status: 'denied',
  requestedAt: '2026-09-09T00:00:00.000Z',
  expiration: { mode: 'none', description: 'test fixture' },
  ...overrides
})

describe('run receipt runtime binding', () => {
  it('keeps ledger enrichment within the durable envelope and avoids double-counting a matched native reply', () => {
    const reporter = createRunToolCapabilityReceipt({
      runId: 'merge',
      chatId: 'chat',
      provider: 'antigravity',
      model: null,
      transport: 'agy',
      effectivePermissions: null,
      scope: { kind: 'global', workspacePath: null, paths: [] }
    })
    reporter.refusal({
      toolCallId: 'native-1',
      toolName: 'bash',
      origin: 'host-policy',
      decisionSource: 'system',
      reason: 'scope',
      reply: 'transport-written'
    })
    const matched = ledgerRecord({
      runId: 'merge',
      chatId: 'chat',
      approvalId: 'approval-native',
      decision: 'autoDeny',
      decisionSource: 'system',
      metadata: { toolCallId: 'native-1', generation: 1, refusalOrigin: 'host-policy' }
    })
    const deduped = withRunToolApprovalRefusals(reporter.snapshot(), [matched])
    expect(deduped.refusals).toHaveLength(1)
    expect(deduped.refusals[0].approvalId).toBe('approval-native')
    reporter.catalogue('managed', {
      names: Array.from({ length: 512 }, (_, i) => `${i}-${'x'.repeat(190)}`),
      source: 'provider-catalogue',
      complete: true,
      namespace: 'broker'
    })
    const rows = Array.from({ length: 64 }, (_, i) => ({
      ...matched,
      approvalId: `approval-${i}`,
      title: 'x'.repeat(2_000),
      metadata: {}
    }))
    const receipt = withRunToolApprovalRefusals(reporter.snapshot(), rows)
    const payload = { toolCapabilityReceipt: receipt }
    expect(prepareRunEventPayload(payload)).toBe(payload)
    expect(receipt.refusalCountIsLowerBound).toBe(true)
  })
  it('binds the reporter to exact run/chat/provider and never fills missing policy from settings', () => {
    const reporter = createRunToolCapabilityReporter({
      runId: 'runtime-fixture',
      chatId: 'chat-1',
      provider: 'antigravity',
      transport: 'agy-print',
      payload: { scope: 'workspace', workspace: '/workspace', model: 'model' },
      chat: null
    })
    expect(reporter.snapshot().effectivePermissions).toBeNull()
    expect(getRunToolCapabilityReporter('runtime-fixture', 'chat-2', 'antigravity')).toBeNull()
    expect(getRunToolCapabilityReporter('runtime-fixture', 'chat-1', 'cursor')).toBeNull()
    expect(getRunToolCapabilityReporter('runtime-fixture', 'chat-1', 'antigravity')).toBe(reporter)
  })
  it('attributes human decisions from ledger facts, not body prose, and excludes foreign rows', () => {
    const receipt = createRunToolCapabilityReceipt({
      runId: 'run',
      chatId: 'chat',
      provider: 'antigravity',
      model: null,
      transport: 'agy',
      effectivePermissions: null,
      scope: { kind: 'global', workspacePath: null, paths: [] }
    }).snapshot()
    const record = ledgerRecord({
      runId: 'run',
      chatId: 'chat',
      approvalId: 'a',
      decision: 'autoDeny',
      decisionSource: 'policy',
      method: 'shell',
      title: 'Blocked by policy',
      body: 'User rejected'
    })
    expect(approvalRecordToolRefusal(record, 1)?.origin).toBe('host-policy')
    expect(
      approvalRecordToolRefusal({ ...record, decision: 'decline', decisionSource: 'user' }, 1)
        ?.origin
    ).toBe('human')
    expect(
      withRunToolApprovalRefusals(receipt, [
        record,
        { ...record, approvalId: 'foreign', chatId: 'other' }
      ]).refusals
    ).toHaveLength(1)
  })
})
