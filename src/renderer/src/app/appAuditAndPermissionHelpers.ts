// Audit/permission helpers extracted from `src/renderer/src/App.tsx` (Wave 4).
// Pure module-level helpers with no React state/hook dependencies.
// Behaviour-preserving move: bodies are byte-identical to the App.tsx originals,
// with `export` added. Type-only imports from `src/main/store/types` keep this
// module free of renderer -> main runtime edges (architecture-guard safe).
// App.tsx reimports from here.
import { deepEqual } from '../lib/messagesRenderEqual'
import type { ContextCompactionProgressEvent } from '../../../shared/contextCompaction'
import type {
  AuditRetentionPurgeResult,
  ChatMessage,
  ChatWorkflowMode,
  PermissionPresetId,
  ProductAuditBundleVerificationResult
} from '../../../main/store/types'

export type AuditBundleExportScope = 'all' | 'workspace' | 'chat' | 'run'

export function summarizeAuditRetentionPurge(result: AuditRetentionPurgeResult): string {
  if (!result.ok) return `failed: ${result.error || 'unknown error'}`
  const receipt = result.receipt
  if (!receipt) return 'completed without a receipt'
  const totals = Object.values(receipt.counts).reduce(
    (acc, counts) => ({
      scanned: acc.scanned + counts.scanned,
      retained: acc.retained + counts.retained,
      deleted: acc.deleted + counts.deleted
    }),
    { scanned: 0, retained: 0, deleted: 0 }
  )
  const verb = receipt.dryRun ? 'would delete' : 'deleted'
  const mode = receipt.dryRun ? 'dry-run' : 'purge'
  const disabledNote = receipt.enabled ? '' : ' (retention disabled; forced dry-run)'

  return `${mode}${disabledNote}: scanned ${totals.scanned}, retained ${totals.retained}, ${verb} ${totals.deleted}`
}

export function auditBundleExportScopeLabel(scope: AuditBundleExportScope): string {
  switch (scope) {
    case 'workspace':
      return 'current workspace'
    case 'chat':
      return 'current thread'
    case 'run':
      return 'current run'
    default:
      return 'full local'
  }
}

export function summarizeAuditBundleVerification(
  result: ProductAuditBundleVerificationResult
): string {
  if (!result.ok) {
    const reason = result.verification?.reason || result.error || 'verification failed'
    return `failed: ${reason}`
  }
  const evidence = result.manifest?.tamperEvidence || 'unknown evidence'
  const keyId = result.verification?.keyId ? `, key ${result.verification.keyId}` : ''
  return `verified (${evidence}${keyId})`
}

export function contextCompactionProgressKey(
  event: Pick<ContextCompactionProgressEvent, 'chatId' | 'participantId' | 'provider'>
): string {
  return `${event.chatId}:${event.participantId || event.provider || 'chat'}`
}

export function permissionPresetToApprovalMode(preset?: string): string {
  if (preset === 'read_only') return 'plan'
  if (preset === 'plan') return 'plan'
  if (preset === 'workspace_write' || preset === 'full_access') return 'auto_edit'
  return 'default'
}

export function approvalModeToPermissionPreset(
  approvalMode: string,
  workflowMode: ChatWorkflowMode
): PermissionPresetId {
  if (approvalMode === 'plan') {
    return workflowMode === 'plan' ? 'plan' : 'read_only'
  }
  if (approvalMode === 'auto_edit') return 'workspace_write'
  return 'default'
}

export function isPermissionPresetId(value: unknown): value is PermissionPresetId {
  return (
    value === 'read_only' ||
    value === 'plan' ||
    value === 'default' ||
    value === 'workspace_write' ||
    value === 'full_access' ||
    value === 'custom'
  )
}

export function shareUnchangedMessageObjects(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[]
): ChatMessage[] {
  let changed = false
  const shared = next.map((message, index) => {
    const prior = previous[index]
    if (!prior || prior === message || prior.id !== message.id) return message
    if (!deepEqual(prior, message)) return message
    changed = true
    return prior
  })
  return changed ? shared : (next as ChatMessage[])
}
