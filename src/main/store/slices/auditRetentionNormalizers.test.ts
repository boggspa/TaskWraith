import { describe, expect, it } from 'vitest'
import type { AuditRetentionPurgeReceipt } from '../types'
import {
  AUDIT_BUNDLE_VERIFICATION_RECEIPT_CAP,
  AUDIT_RETENTION_PURGE_RECEIPT_CAP,
  AUDIT_RETENTION_SURFACES,
  DEFAULT_AUDIT_RETENTION,
  auditRetentionCutoffMs,
  capAuditBundleVerificationReceipts,
  capAuditRetentionPurgeReceipts,
  emptyAuditRetentionCounts,
  isBeforeAuditRetentionCutoff,
  normalizeAuditBundleVerificationReceipt,
  normalizeAuditRetentionSettings,
  normalizeAuditRunRecord
} from './auditRetentionNormalizers'

const NOW_MS = Date.parse('2026-09-04T08:00:00.000Z')

function purgeReceipt(id: string): AuditRetentionPurgeReceipt {
  return {
    schemaVersion: 1,
    id,
    generatedAt: '2026-09-04T08:00:00.000Z',
    dryRun: true,
    enabled: false,
    policy: DEFAULT_AUDIT_RETENTION,
    counts: emptyAuditRetentionCounts()
  }
}

describe('auditRetentionNormalizers', () => {
  it('rejects audit run records without an id', () => {
    expect(normalizeAuditRunRecord(null)).toBeNull()
    expect(normalizeAuditRunRecord({})).toBeNull()
    expect(normalizeAuditRunRecord({ id: '' })).toBeNull()
  })

  it('defaults arrays, mode, status, and budget for a persisted audit run', () => {
    const record = normalizeAuditRunRecord({
      id: 'run-1',
      chatId: 'chat-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T01:00:00.000Z'
    })
    expect(record).toMatchObject({
      schemaVersion: 1,
      id: 'run-1',
      mode: 'quick',
      chatId: 'chat-1',
      workspacePath: '',
      status: 'planning',
      phases: [],
      dimensions: [],
      participants: [],
      findings: [],
      verdicts: [],
      gates: [],
      budget: { maxAgents: 0, spentAgents: 0, spentTokens: 0, truncated: false },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T01:00:00.000Z'
    })
    expect(record?.workspaceId).toBeUndefined()
  })

  it('keeps deep/release modes and fills missing timestamps', () => {
    const record = normalizeAuditRunRecord({ id: 'run-2', mode: 'deep' })
    expect(record?.mode).toBe('deep')
    expect(record?.createdAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
    expect(normalizeAuditRunRecord({ id: 'run-3', mode: 'release' })?.mode).toBe('release')
    expect(normalizeAuditRunRecord({ id: 'run-4', mode: 'other' })?.mode).toBe('quick')
  })

  it('normalizes audit retention settings with defaults, clamps, and enabled-true only', () => {
    expect(normalizeAuditRetentionSettings(undefined)).toEqual({
      enabled: false,
      maxAgeDays: DEFAULT_AUDIT_RETENTION.maxAgeDays
    })
    expect(
      normalizeAuditRetentionSettings({ enabled: 'yes' } as unknown as {
        enabled: boolean
      }).enabled
    ).toBe(false)
    expect(
      normalizeAuditRetentionSettings({
        enabled: true,
        maxAgeDays: { productCrashes: 0, runEvents: 4000, auditRuns: 12.9 }
      })
    ).toEqual({
      enabled: true,
      maxAgeDays: {
        ...DEFAULT_AUDIT_RETENTION.maxAgeDays,
        runEvents: 3650,
        auditRuns: 12
      }
    })
  })

  it('builds empty purge counts for every retention surface', () => {
    const counts = emptyAuditRetentionCounts()
    expect(Object.keys(counts)).toEqual(AUDIT_RETENTION_SURFACES)
    expect(counts.approvalLedger).toEqual({ scanned: 0, retained: 0, deleted: 0 })
  })

  it('computes retention cutoffs and compares timestamps', () => {
    expect(auditRetentionCutoffMs({ maxAgeDays: { auditRuns: 2 } }, 'auditRuns', NOW_MS)).toBe(
      NOW_MS - 2 * 24 * 60 * 60 * 1000
    )
    expect(auditRetentionCutoffMs({ maxAgeDays: { auditRuns: 0 } }, 'auditRuns', NOW_MS)).toBeNull()
    expect(isBeforeAuditRetentionCutoff('2026-09-01T00:00:00.000Z', NOW_MS)).toBe(true)
    expect(isBeforeAuditRetentionCutoff(NOW_MS, NOW_MS)).toBe(false)
    expect(isBeforeAuditRetentionCutoff('not-a-date', NOW_MS)).toBe(false)
    expect(isBeforeAuditRetentionCutoff(NOW_MS - 1, null)).toBe(false)
  })

  it('caps purge receipts and drops malformed entries', () => {
    const kept = capAuditRetentionPurgeReceipts([
      { schemaVersion: 2, id: 'bad' } as unknown as AuditRetentionPurgeReceipt,
      purgeReceipt('a'),
      purgeReceipt('b')
    ])
    expect(kept.map((receipt) => receipt.id)).toEqual(['a', 'b'])
    const overflow = Array.from({ length: AUDIT_RETENTION_PURGE_RECEIPT_CAP + 3 }, (_, i) =>
      purgeReceipt(`r-${i}`)
    )
    const capped = capAuditRetentionPurgeReceipts(overflow)
    expect(capped).toHaveLength(AUDIT_RETENTION_PURGE_RECEIPT_CAP)
    expect(capped[0]?.id).toBe('r-3')
    expect(capped.at(-1)?.id).toBe(`r-${AUDIT_RETENTION_PURGE_RECEIPT_CAP + 2}`)
  })

  it('normalizes and caps audit bundle verification receipts', () => {
    expect(normalizeAuditBundleVerificationReceipt(null)).toBeNull()
    expect(
      normalizeAuditBundleVerificationReceipt({
        schemaVersion: 1,
        id: 'ok-1',
        verifiedAt: '2026-09-04T00:00:00.000Z',
        ok: true
      })
    ).toMatchObject({ id: 'ok-1', ok: true })
    const receipts = Array.from({ length: AUDIT_BUNDLE_VERIFICATION_RECEIPT_CAP + 1 }, (_, i) => ({
      schemaVersion: 1 as const,
      id: `v-${i}`,
      verifiedAt: '2026-09-04T00:00:00.000Z',
      ok: i % 2 === 0
    }))
    receipts.splice(1, 0, { schemaVersion: 1 as const, id: '', verifiedAt: 'x', ok: true })
    const capped = capAuditBundleVerificationReceipts(receipts)
    expect(capped).toHaveLength(AUDIT_BUNDLE_VERIFICATION_RECEIPT_CAP)
    expect(capped[0]?.id).toBe('v-1')
  })
})
