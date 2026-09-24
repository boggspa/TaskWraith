import { describe, expect, it } from 'vitest'
import type {
  AuditRetentionPurgeResult,
  ChatMessage,
  ProductAuditBundleVerificationResult
} from '../../../main/store/types'
import {
  approvalModeToPermissionPreset,
  auditBundleExportScopeLabel,
  contextCompactionProgressKey,
  isPermissionPresetId,
  permissionPresetToApprovalMode,
  shareUnchangedMessageObjects,
  summarizeAuditBundleVerification,
  summarizeAuditRetentionPurge
} from './appAuditAndPermissionHelpers'

function purgeResult(partial: unknown): AuditRetentionPurgeResult {
  return partial as unknown as AuditRetentionPurgeResult
}

function verificationResult(partial: unknown): ProductAuditBundleVerificationResult {
  return partial as unknown as ProductAuditBundleVerificationResult
}

function chatMessage(partial: unknown): ChatMessage {
  return partial as unknown as ChatMessage
}

describe('summarizeAuditRetentionPurge', () => {
  it('reports the failure reason when the purge did not run', () => {
    expect(summarizeAuditRetentionPurge(purgeResult({ ok: false, error: 'boom' }))).toBe(
      'failed: boom'
    )
    expect(summarizeAuditRetentionPurge(purgeResult({ ok: false }))).toBe('failed: unknown error')
  })

  it('notes a missing receipt on success', () => {
    expect(summarizeAuditRetentionPurge(purgeResult({ ok: true }))).toBe(
      'completed without a receipt'
    )
  })

  it('totals scanned/retained/deleted counts across surfaces', () => {
    const result = purgeResult({
      ok: true,
      receipt: {
        dryRun: false,
        enabled: true,
        counts: {
          auditRuns: { scanned: 10, retained: 7, deleted: 3 },
          runEvents: { scanned: 20, retained: 10, deleted: 10 }
        }
      }
    })
    expect(summarizeAuditRetentionPurge(result)).toBe('purge: scanned 30, retained 17, deleted 13')
  })

  it('marks dry-run mode and forced dry-run when retention is disabled', () => {
    const result = purgeResult({
      ok: true,
      receipt: {
        dryRun: true,
        enabled: false,
        counts: { auditRuns: { scanned: 4, retained: 4, deleted: 0 } }
      }
    })
    expect(summarizeAuditRetentionPurge(result)).toBe(
      'dry-run (retention disabled; forced dry-run): scanned 4, retained 4, would delete 0'
    )
  })
})

describe('auditBundleExportScopeLabel', () => {
  it('labels every scope and defaults unknown scopes to full local', () => {
    expect(auditBundleExportScopeLabel('workspace')).toBe('current workspace')
    expect(auditBundleExportScopeLabel('chat')).toBe('current thread')
    expect(auditBundleExportScopeLabel('run')).toBe('current run')
    expect(auditBundleExportScopeLabel('all')).toBe('full local')
  })
})

describe('summarizeAuditBundleVerification', () => {
  it('prefers the verification reason, then error, then a fallback', () => {
    expect(
      summarizeAuditBundleVerification(
        verificationResult({ ok: false, verification: { reason: 'bad sig' }, error: 'x' })
      )
    ).toBe('failed: bad sig')
    expect(summarizeAuditBundleVerification(verificationResult({ ok: false, error: 'x' }))).toBe(
      'failed: x'
    )
    expect(summarizeAuditBundleVerification(verificationResult({ ok: false }))).toBe(
      'failed: verification failed'
    )
  })

  it('reports evidence and key id on success', () => {
    expect(
      summarizeAuditBundleVerification(
        verificationResult({
          ok: true,
          manifest: { tamperEvidence: 'local_hashes_signed' },
          verification: { keyId: 'k1' }
        })
      )
    ).toBe('verified (local_hashes_signed, key k1)')
    expect(summarizeAuditBundleVerification(verificationResult({ ok: true }))).toBe(
      'verified (unknown evidence)'
    )
  })
})

describe('contextCompactionProgressKey', () => {
  it('keys by chat plus participant, provider, or chat fallback', () => {
    expect(
      contextCompactionProgressKey({ chatId: 'c1', participantId: 'p1', provider: 'prov' })
    ).toBe('c1:p1')
    expect(contextCompactionProgressKey({ chatId: 'c1', provider: 'prov' })).toBe('c1:prov')
    expect(contextCompactionProgressKey({ chatId: 'c1' })).toBe('c1:chat')
  })
})

describe('permissionPresetToApprovalMode', () => {
  it('maps presets to approval modes with a default fallback', () => {
    expect(permissionPresetToApprovalMode('read_only')).toBe('plan')
    expect(permissionPresetToApprovalMode('plan')).toBe('plan')
    expect(permissionPresetToApprovalMode('workspace_write')).toBe('auto_edit')
    expect(permissionPresetToApprovalMode('full_access')).toBe('auto_edit')
    expect(permissionPresetToApprovalMode(undefined)).toBe('default')
    expect(permissionPresetToApprovalMode('custom')).toBe('default')
  })
})

describe('approvalModeToPermissionPreset', () => {
  it('derives the preset from approval mode and workflow mode', () => {
    expect(approvalModeToPermissionPreset('plan', 'plan')).toBe('plan')
    expect(approvalModeToPermissionPreset('plan', 'normal')).toBe('read_only')
    expect(approvalModeToPermissionPreset('auto_edit', 'plan')).toBe('workspace_write')
    expect(approvalModeToPermissionPreset('default', 'normal')).toBe('default')
  })
})

describe('isPermissionPresetId', () => {
  it('accepts exactly the six known preset ids', () => {
    for (const id of ['read_only', 'plan', 'default', 'workspace_write', 'full_access', 'custom']) {
      expect(isPermissionPresetId(id)).toBe(true)
    }
    expect(isPermissionPresetId('nope')).toBe(false)
    expect(isPermissionPresetId(undefined)).toBe(false)
    expect(isPermissionPresetId(null)).toBe(false)
    expect(isPermissionPresetId(42)).toBe(false)
  })
})

describe('shareUnchangedMessageObjects', () => {
  it('returns the prior instance for deeply equal messages with the same id', () => {
    const prior = chatMessage({ id: 'm1', role: 'user', content: 'hi' })
    const next = chatMessage({ id: 'm1', role: 'user', content: 'hi' })
    expect(next).not.toBe(prior)
    const shared = shareUnchangedMessageObjects([prior], [next])
    expect(shared[0]).toBe(prior)
  })

  it('keeps the new instance when content or identity differs', () => {
    const prior = chatMessage({ id: 'm1', role: 'user', content: 'hi' })
    const changed = chatMessage({ id: 'm1', role: 'user', content: 'bye' })
    const renamed = chatMessage({ id: 'm2', role: 'user', content: 'hi' })
    expect(shareUnchangedMessageObjects([prior], [changed])[0]).toBe(changed)
    expect(shareUnchangedMessageObjects([prior], [renamed])[0]).toBe(renamed)
    expect(shareUnchangedMessageObjects([], [changed])[0]).toBe(changed)
  })

  it('returns the same next array when nothing was shared', () => {
    const prior = chatMessage({ id: 'm1', role: 'user', content: 'hi' })
    const next = [chatMessage({ id: 'm1', role: 'user', content: 'bye' })]
    expect(shareUnchangedMessageObjects([prior], next)).toBe(next)
  })
})
