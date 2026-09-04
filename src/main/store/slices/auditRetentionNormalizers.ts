import type {
  AuditFinding,
  AuditGateResult,
  AuditParticipant,
  AuditRetentionPurgeReceipt,
  AuditRetentionSettings,
  AuditRetentionSurface,
  AuditRetentionSurfacePurgeCounts,
  AuditRunRecord,
  AuditVerdict,
  ProductAuditBundleVerificationReceipt
} from '../types'

/** Defensive shape-guard for a persisted audit run. Arrays default to empty
 * and the budget/coverage substructures are tolerated-missing so records
 * written by an older build still decode. Returns null only when the record
 * is too malformed to be useful (no id). */
export function normalizeAuditRunRecord(value: unknown): AuditRunRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<AuditRunRecord>
  if (typeof input.id !== 'string' || !input.id) return null
  const nowIso = new Date().toISOString()
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    schemaVersion: 1,
    id: input.id,
    mode: input.mode === 'deep' || input.mode === 'release' ? input.mode : 'quick',
    chatId: typeof input.chatId === 'string' ? input.chatId : '',
    workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
    workspacePath: typeof input.workspacePath === 'string' ? input.workspacePath : '',
    status: input.status ?? 'planning',
    phases: arr<AuditRunRecord['phases'][number]>(input.phases),
    profile: input.profile,
    dimensions: arr<string>(input.dimensions),
    roster: input.roster,
    participants: arr<AuditParticipant>(input.participants),
    findings: arr<AuditFinding>(input.findings),
    verdicts: arr<AuditVerdict>(input.verdicts),
    gates: arr<AuditGateResult>(input.gates),
    budget: input.budget ?? {
      maxAgents: 0,
      spentAgents: 0,
      spentTokens: 0,
      truncated: false
    },
    coverage: input.coverage,
    report: typeof input.report === 'string' ? input.report : undefined,
    error: typeof input.error === 'string' ? input.error : undefined,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso,
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : undefined,
    endedAt: typeof input.endedAt === 'string' ? input.endedAt : undefined
  }
}

export const AUDIT_RETENTION_SURFACES: AuditRetentionSurface[] = [
  'approvalLedger',
  'runEvents',
  'workspaceChanges',
  'auditRuns',
  'messageFeedback',
  'externalPublish',
  'productCrashes'
]

export const DEFAULT_AUDIT_RETENTION: AuditRetentionSettings = {
  enabled: false,
  maxAgeDays: {
    approvalLedger: 365,
    runEvents: 180,
    workspaceChanges: 180,
    auditRuns: 365,
    messageFeedback: 365,
    externalPublish: 365,
    productCrashes: 90
  }
}

export const AUDIT_RETENTION_PURGE_RECEIPT_CAP = 250
export const AUDIT_BUNDLE_VERIFICATION_RECEIPT_CAP = 250

export function normalizeAuditRetentionSettings(value: unknown): AuditRetentionSettings {
  const input = value && typeof value === 'object' ? (value as Partial<AuditRetentionSettings>) : {}
  const rawMaxAge = input.maxAgeDays && typeof input.maxAgeDays === 'object' ? input.maxAgeDays : {}
  const maxAgeDays: Partial<Record<AuditRetentionSurface, number>> = {}
  for (const surface of AUDIT_RETENTION_SURFACES) {
    const value = Number((rawMaxAge as Partial<Record<AuditRetentionSurface, number>>)[surface])
    if (Number.isFinite(value) && value > 0) {
      maxAgeDays[surface] = Math.min(3650, Math.max(1, Math.floor(value)))
    }
  }
  return {
    enabled: input.enabled === true,
    maxAgeDays: {
      ...DEFAULT_AUDIT_RETENTION.maxAgeDays,
      ...maxAgeDays
    }
  }
}

export function emptyAuditRetentionCounts(): Record<
  AuditRetentionSurface,
  AuditRetentionSurfacePurgeCounts
> {
  return AUDIT_RETENTION_SURFACES.reduce(
    (counts, surface) => {
      counts[surface] = { scanned: 0, retained: 0, deleted: 0 }
      return counts
    },
    {} as Record<AuditRetentionSurface, AuditRetentionSurfacePurgeCounts>
  )
}

export function auditRetentionCutoffMs(
  policy: AuditRetentionSettings,
  surface: AuditRetentionSurface,
  nowMs: number
): number | null {
  const days = policy.maxAgeDays?.[surface]
  if (!Number.isFinite(days) || Number(days) <= 0) return null
  return nowMs - Math.floor(Number(days)) * 24 * 60 * 60 * 1000
}

export function isBeforeAuditRetentionCutoff(value: unknown, cutoffMs: number | null): boolean {
  if (cutoffMs === null) return false
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''))
  return Number.isFinite(ms) && ms < cutoffMs
}

export function capAuditRetentionPurgeReceipts(
  receipts: AuditRetentionPurgeReceipt[],
  cap = AUDIT_RETENTION_PURGE_RECEIPT_CAP
): AuditRetentionPurgeReceipt[] {
  const normalized = receipts.filter((receipt): receipt is AuditRetentionPurgeReceipt =>
    Boolean(receipt?.id && receipt.schemaVersion === 1 && receipt.generatedAt)
  )
  return normalized.length <= cap ? normalized : normalized.slice(normalized.length - cap)
}

export function normalizeAuditBundleVerificationReceipt(
  receipt: unknown
): ProductAuditBundleVerificationReceipt | null {
  if (!receipt || typeof receipt !== 'object') return null
  const candidate = receipt as ProductAuditBundleVerificationReceipt
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    typeof candidate.verifiedAt !== 'string' ||
    typeof candidate.ok !== 'boolean'
  ) {
    return null
  }
  return candidate
}

export function capAuditBundleVerificationReceipts(
  receipts: unknown[],
  cap = AUDIT_BUNDLE_VERIFICATION_RECEIPT_CAP
): ProductAuditBundleVerificationReceipt[] {
  const normalized = receipts
    .map(normalizeAuditBundleVerificationReceipt)
    .filter((receipt): receipt is ProductAuditBundleVerificationReceipt => Boolean(receipt))
  return normalized.length <= cap ? normalized : normalized.slice(normalized.length - cap)
}
