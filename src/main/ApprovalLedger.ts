import { randomUUID } from 'crypto'
import type {
  AgentApprovalAction,
  ApprovalLedgerFilter,
  ApprovalLedgerExpiration,
  ApprovalLedgerRecord,
  ApprovalLedgerRequestInput,
  ApprovalLedgerScope,
  ApprovalLedgerStatus,
  ProviderId
} from './store/types'

export const APPROVAL_LEDGER_SCHEMA_VERSION = 1
export const PENDING_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
export const APPROVAL_TITLE_BACKFILL_VERSION = '1.0.7-M8'

const providerLabels: Record<ProviderId, string> = {
  gemini: 'Gemini',
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama',
  antigravity: 'Antigravity',
  pi: 'Pi',
  mistral: 'Mistral'
}

const providerIds = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'pi',
  'mistral'
])
const providerMcpMethodPattern = /^(gemini|codex|claude|kimi|grok|cursor|ollama|pi|mistral)-mcp\//

export interface ApprovalTitleBackfillChange {
  index: number
  id?: string
  approvalId?: string
  provider: ProviderId
  method?: string
  previousTitle: string
  nextTitle: string
  reason: string
}

export interface ApprovalTitleBackfillUnchangedRow {
  index: number
  id?: string
  approvalId?: string
  provider?: ProviderId
  method?: string
  title?: string
  reason: string
}

export interface ApprovalTitleBackfillResult {
  records: ApprovalLedgerRecord[]
  scanned: number
  changed: number
  unchanged: number
  changes: ApprovalTitleBackfillChange[]
  unchangedRows: ApprovalTitleBackfillUnchangedRow[]
  staleRowsAfter: ApprovalTitleBackfillChange[]
}

function addMs(isoTimestamp: string, ms: number): string {
  return new Date(new Date(isoTimestamp).getTime() + ms).toISOString()
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && providerIds.has(value as ProviderId)
}

function approvalTitleProviderFromMethod(method: unknown): ProviderId | undefined {
  if (typeof method !== 'string') return undefined
  const match = method.match(providerMcpMethodPattern)
  return isProviderId(match?.[1]) ? match[1] : undefined
}

function approvalTitleProviderFromRecord(record: Partial<ApprovalLedgerRecord>): ProviderId | undefined {
  const methodProvider = approvalTitleProviderFromMethod(record.method)
  if (methodProvider) return methodProvider
  if (isProviderId(record.provider)) return record.provider
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {}
  const metadataProvider = metadata.parentProvider || metadata.provider
  return isProviderId(metadataProvider) ? metadataProvider : undefined
}

function rewriteHistoricalApprovalTitle(
  title: string,
  provider: ProviderId
): { title: string; reason: string } | null {
  if (provider === 'gemini') return null
  const providerName = providerLabels[provider]
  if (title.startsWith('Approve Gemini ')) {
    return {
      title: title.replace(/^Approve Gemini\b/, `Approve ${providerName}`),
      reason: 'approve-title-provider-prefix'
    }
  }
  if (title.startsWith('Gemini wants ')) {
    return {
      title: title.replace(/^Gemini\b/, providerName),
      reason: 'delegation-title-provider-prefix'
    }
  }
  return null
}

export function backfillApprovalLedgerTitles(
  records: ApprovalLedgerRecord[],
  migratedAt: string = new Date().toISOString()
): ApprovalTitleBackfillResult {
  const changes: ApprovalTitleBackfillChange[] = []
  const unchangedRows: ApprovalTitleBackfillUnchangedRow[] = []
  const nextRecords = records.map((record, index) => {
    const provider = approvalTitleProviderFromRecord(record)
    const baseRow = {
      index,
      id: record.id,
      approvalId: record.approvalId,
      provider,
      method: record.method,
      title: record.title
    }
    if (!provider) {
      unchangedRows.push({ ...baseRow, reason: 'provider-unresolved' })
      return record
    }
    const rewrite = rewriteHistoricalApprovalTitle(record.title, provider)
    if (!rewrite) {
      unchangedRows.push({
        ...baseRow,
        reason: provider === 'gemini' ? 'gemini-provider' : 'title-current-or-provider-agnostic'
      })
      return record
    }
    const nextRecord: ApprovalLedgerRecord = {
      ...record,
      title: rewrite.title,
      metadata: {
        ...(record.metadata || {}),
        approvalTitleBackfill: {
          version: APPROVAL_TITLE_BACKFILL_VERSION,
          migratedAt,
          previousTitle: record.title
        }
      }
    }
    changes.push({
      index,
      id: record.id,
      approvalId: record.approvalId,
      provider,
      method: record.method,
      previousTitle: record.title,
      nextTitle: rewrite.title,
      reason: rewrite.reason
    })
    return nextRecord
  })
  const staleRowsAfter: ApprovalTitleBackfillChange[] = []
  nextRecords.forEach((record, index) => {
    const provider = approvalTitleProviderFromRecord(record)
    if (!provider || provider === 'gemini') return
    const rewrite = rewriteHistoricalApprovalTitle(record.title, provider)
    if (!rewrite) return
    staleRowsAfter.push({
      index,
      id: record.id,
      approvalId: record.approvalId,
      provider,
      method: record.method,
      previousTitle: record.title,
      nextTitle: rewrite.title,
      reason: rewrite.reason
    })
  })
  return {
    records: nextRecords,
    scanned: records.length,
    changed: changes.length,
    unchanged: unchangedRows.length,
    changes,
    unchangedRows,
    staleRowsAfter
  }
}

export function scopeForApprovalAction(action: AgentApprovalAction): ApprovalLedgerScope {
  if (action === 'acceptForWorkspace') return 'workspace'
  if (action === 'acceptForSession') return 'session'
  if (action === 'accept') return 'run'
  return 'request'
}

export function statusForApprovalAction(action: AgentApprovalAction): ApprovalLedgerStatus {
  if (action === 'accept' || action === 'acceptForSession' || action === 'acceptForWorkspace') {
    return 'approved'
  }
  if (action === 'cancel') return 'cancelled'
  return 'denied'
}

export function expirationForApprovalAction(
  action: AgentApprovalAction,
  decidedAt: string
): ApprovalLedgerExpiration {
  const scope = scopeForApprovalAction(action)
  if (scope === 'workspace') {
    return {
      mode: 'workspace_revocation' as const,
      description: 'Workspace approval remains active until the workspace grant is revoked.'
    }
  }
  if (scope === 'session') {
    return {
      mode: 'session_end' as const,
      description: 'Session approval expires when the active provider runtime session ends.'
    }
  }
  if (scope === 'run') {
    return {
      mode: 'run_end' as const,
      description: 'Run approval expires when this run reaches a terminal state.'
    }
  }
  return {
    mode: 'on_decision' as const,
    description: 'Denied or cancelled requests expire immediately after the decision.',
    expiresAt: decidedAt,
    expiredAt: decidedAt,
    expiredReason: action
  }
}

export function createApprovalLedgerRecord(
  input: ApprovalLedgerRequestInput,
  now: string = new Date().toISOString()
): ApprovalLedgerRecord {
  const approvalId = String(input.approvalId || input.id || '').trim()
  if (!approvalId) {
    throw new Error('Approval ledger record requires an approvalId.')
  }

  return {
    schemaVersion: APPROVAL_LEDGER_SCHEMA_VERSION,
    id: input.id || approvalId || randomUUID(),
    approvalId,
    provider: input.provider,
    service: input.service,
    method: input.method,
    title: input.title,
    body: input.body,
    preview: input.preview,
    params: input.params,
    actions: Array.isArray(input.actions) ? input.actions : [],
    status: input.status || 'pending',
    requestedAt: input.requestedAt || now,
    respondedAt: input.respondedAt,
    decision: input.decision,
    decisionSource: input.decisionSource,
    grantedScope: input.grantedScope,
    expiration: input.expiration || {
      mode: 'pending_timeout',
      description: 'Pending approval expires if it is not answered within 24 hours.',
      expiresAt: addMs(input.requestedAt || now, PENDING_APPROVAL_TTL_MS)
    },
    runId: input.runId,
    chatId: input.chatId,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    providerSessionId: input.providerSessionId,
    providerRunId: input.providerRunId,
    rpcId: input.rpcId,
    metadata: input.metadata
  }
}

export function resolveApprovalLedgerRecord(
  record: ApprovalLedgerRecord,
  action: AgentApprovalAction,
  decidedAt: string = new Date().toISOString(),
  /** Phase E1.2: the actor responsible for the decision. Defaults to
   * `'user'` (renderer click / iOS reply). Pass `'system'` for the
   * auto-deny path that fires when an approval timer elapses. */
  decisionSource: 'user' | 'system' = 'user',
  /** Optional metadata to merge — used by the timeout path to record
   * `{ autoDeniedByTimeout: true, timeoutMs, timeoutSource }` so the
   * ledger UX can render a distinct badge. */
  extraMetadata: Record<string, unknown> = {}
): ApprovalLedgerRecord {
  // For the timeout auto-deny we override the user-action decision
  // with `'autoDeny'` so the ledger explicitly distinguishes it from
  // a manual decline.
  const decision = decisionSource === 'system' && action === 'decline' ? 'autoDeny' : action
  return {
    ...record,
    status: statusForApprovalAction(action),
    respondedAt: decidedAt,
    decision,
    decisionSource,
    grantedScope: scopeForApprovalAction(action),
    expiration: expirationForApprovalAction(action, decidedAt),
    metadata:
      Object.keys(extraMetadata).length > 0
        ? { ...(record.metadata || {}), ...extraMetadata }
        : record.metadata
  }
}

export function expireApprovalLedgerRecord(
  record: ApprovalLedgerRecord,
  expiredAt: string = new Date().toISOString(),
  reason = 'expired'
): ApprovalLedgerRecord {
  if (record.status === 'expired' || record.status === 'denied' || record.status === 'cancelled') {
    return record
  }
  return {
    ...record,
    status: 'expired',
    decision: record.decision || 'expired',
    expiration: {
      ...record.expiration,
      expiredAt,
      expiredReason: reason
    }
  }
}

export function recoverExpiredApprovalLedgerRecords(
  records: ApprovalLedgerRecord[],
  now: string = new Date().toISOString()
): ApprovalLedgerRecord[] {
  const nowMs = new Date(now).getTime()
  return records.map((record) => {
    if (record.status !== 'pending') return record
    const expiresAt = record.expiration?.expiresAt
    if (!expiresAt || new Date(expiresAt).getTime() > nowMs) return record
    return expireApprovalLedgerRecord(record, now, 'pending_timeout')
  })
}

export function expireScopedApprovalLedgerRecords(
  records: ApprovalLedgerRecord[],
  filter: {
    runId?: string
    provider?: string
    workspacePath?: string
    scopes: ApprovalLedgerScope[]
    reason: string
  },
  now: string = new Date().toISOString()
): ApprovalLedgerRecord[] {
  const scopeSet = new Set(filter.scopes)
  return records.map((record) => {
    // 1.0.4-AD: a pending request bound to the finishing run has no
    // decision path left — the renderer can't respond once the run is
    // gone, and the in-memory pendingX maps are cleared by
    // `runManager.finish`. Sweep these alongside the approved-scope
    // expiration so the auto-allow / manual-resolve / run-end paths
    // are transactional with the ledger and "completed runs" never
    // leave orphan pending rows hanging until the 24h recovery sweep.
    if (record.status === 'pending') {
      if (!filter.runId || record.runId !== filter.runId) return record
      if (filter.provider && record.provider !== filter.provider) return record
      if (filter.workspacePath && record.workspacePath !== filter.workspacePath) return record
      return expireApprovalLedgerRecord(record, now, filter.reason)
    }
    if (record.status !== 'approved') return record
    if (!record.grantedScope || !scopeSet.has(record.grantedScope)) return record
    if (filter.runId && record.runId !== filter.runId) return record
    if (filter.provider && record.provider !== filter.provider) return record
    if (filter.workspacePath && record.workspacePath !== filter.workspacePath) return record
    return expireApprovalLedgerRecord(record, now, filter.reason)
  })
}

export function filterApprovalLedgerRecords(
  records: ApprovalLedgerRecord[],
  filter: ApprovalLedgerFilter = {}
): ApprovalLedgerRecord[] {
  const statusSet = filter.statuses?.length ? new Set(filter.statuses) : null
  const scopeSet = filter.scopes?.length ? new Set(filter.scopes) : null
  const filtered = records.filter((record) => {
    if (filter.approvalId && record.approvalId !== filter.approvalId) return false
    if (filter.runId && record.runId !== filter.runId) return false
    if (filter.chatId && record.chatId !== filter.chatId) return false
    if (filter.workspaceId && record.workspaceId !== filter.workspaceId) return false
    if (filter.provider && record.provider !== filter.provider) return false
    if (filter.service && record.service !== filter.service) return false
    if (statusSet && !statusSet.has(record.status)) return false
    if (scopeSet && (!record.grantedScope || !scopeSet.has(record.grantedScope))) return false
    if (!filter.includeExpired && record.status === 'expired') return false
    return true
  })
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
  )
  return filter.limit && filter.limit > 0 ? sorted.slice(0, Math.floor(filter.limit)) : sorted
}

/**
 * Cap on retained NON-live approval history. The ledger is rewritten in full
 * (synchronously) on every approval event — including an `autoAllow` audit row
 * per auto-allowed tool call — so an unbounded ledger turns each tool call into
 * an ever-slower main-thread write (it had reached ~7.2MB / ~3200 rows). Live
 * records are NEVER dropped (see isLiveApprovalLedgerRecord); only the oldest
 * terminal/audit rows beyond the cap are shed. Capping fails safe: dropping a
 * stale grant at worst re-prompts the user, never auto-allows.
 */
export const MAX_APPROVAL_LEDGER_HISTORY = 1000

/**
 * A record that must survive capping: a pending request still awaiting a
 * decision, or an active remembered grant (session/workspace scope). Workspace
 * grants persist until revoked and session grants until the runtime session
 * ends — both are flipped to a terminal `expired` status (cappable) by the
 * expiry/recovery sweeps when they die, so an `approved` session/workspace row
 * here is by definition still live.
 */
export function isLiveApprovalLedgerRecord(record: ApprovalLedgerRecord): boolean {
  if (record.status === 'pending') return true
  return (
    record.status === 'approved' &&
    (record.grantedScope === 'session' || record.grantedScope === 'workspace')
  )
}

function approvalLedgerRecencyMs(record: ApprovalLedgerRecord): number {
  const stamp = record.respondedAt || record.requestedAt
  const ms = stamp ? Date.parse(stamp) : NaN
  return Number.isFinite(ms) ? ms : 0
}

export function capApprovalLedgerRecords(
  records: ApprovalLedgerRecord[],
  maxHistory = MAX_APPROVAL_LEDGER_HISTORY
): ApprovalLedgerRecord[] {
  const history = records.filter((record) => !isLiveApprovalLedgerRecord(record))
  if (history.length <= maxHistory) return records
  const keepHistoryIds = new Set(
    [...history]
      .sort((a, b) => approvalLedgerRecencyMs(b) - approvalLedgerRecencyMs(a))
      .slice(0, maxHistory)
      .map((record) => record.id)
  )
  return records.filter(
    (record) => isLiveApprovalLedgerRecord(record) || keepHistoryIds.has(record.id)
  )
}
