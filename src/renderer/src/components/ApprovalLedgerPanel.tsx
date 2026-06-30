import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgenticWorkspaceGrant,
  ApprovalLedgerRecord,
  ApprovalLedgerStatus,
  ProviderId
} from '../../../main/store/types'
import { getWorkspacePolicyServiceLabel } from '../lib/workspacePolicyServices'

/**
 * ApprovalLedgerPanel — Phase E2 admin UI for the durable approval ledger.
 *
 * Surfaces every recorded approval decision (manual, auto-allowed by
 * policy, auto-denied by timeout) so the user can audit what happened
 * across runs. Self-contained — pulls state via the existing
 * `api.getApprovalLedger(filter)` preload binding (wired since the
 * ledger landed in commit `8752630`).
 *
 * Two filter axes:
 *   - Status checkboxes (multi-select)
 *   - Provider dropdown (single-select, plus "all")
 * Plus a client-side date-range filter (last 24h / 7d / 30d / all)
 * and an approvalId substring search.
 *
 * Export: JSON download of the currently-filtered set. Useful for
 * forensics ("why did this run auto-deny at 02:14?") and for sharing
 * audit excerpts.
 *
 * Refresh: pull-on-mount + manual refresh button + auto-refresh on
 * focus (re-running approvals between visits should be visible
 * without a manual reload).
 */

const ALL_PROVIDERS: Array<ProviderId | 'all'> = [
  'all',
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]
const ALL_STATUSES: ApprovalLedgerStatus[] = [
  'pending',
  'approved',
  'denied',
  'cancelled',
  'expired'
]
const DATE_RANGES = [
  { id: 'all', label: 'All time', windowMs: undefined as number | undefined },
  { id: '24h', label: 'Last 24 hours', windowMs: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', windowMs: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', windowMs: 30 * 24 * 60 * 60 * 1000 }
] as const

type DateRangeId = (typeof DATE_RANGES)[number]['id']

const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: 'Gemini',
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama'
}

export interface ApprovalLedgerPanelProps {
  workspaceGrants?: AgenticWorkspaceGrant[]
  onRevokeWorkspaceGrant?: (grant: AgenticWorkspaceGrant) => Promise<void> | void
  /**
   * Path of the workspace the user is currently viewing. Used by the
   * "Forget all sub-thread delegations for this workspace" affordance:
   * we filter `workspaceGrants` to the matching subset and bulk-revoke
   * via repeated `onRevokeWorkspaceGrant` calls. When omitted (global
   * scope, or the host doesn't pass it) the button stays hidden.
   */
  currentWorkspacePath?: string | null
}

export function ApprovalLedgerPanel({
  workspaceGrants = [],
  onRevokeWorkspaceGrant,
  currentWorkspacePath
}: ApprovalLedgerPanelProps): React.JSX.Element {
  const [records, setRecords] = useState<ApprovalLedgerRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null)
  // Slice (1.0.3) — bulk-revoke confirmation state for the
  // "Forget all sub-thread delegations for this workspace" button.
  // `pending` holds the grants the modal is about to revoke;
  // `bulkRevoking` blocks both the button + the modal while the
  // sequential revoke loop runs.
  const [bulkForgetPending, setBulkForgetPending] = useState<AgenticWorkspaceGrant[] | null>(null)
  const [bulkRevoking, setBulkRevoking] = useState(false)
  const [providerFilter, setProviderFilter] = useState<ProviderId | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<Set<ApprovalLedgerStatus>>(new Set(ALL_STATUSES))
  const [dateRange, setDateRange] = useState<DateRangeId>('7d')
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (!bulkForgetPending) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !bulkRevoking) {
        event.preventDefault()
        setBulkForgetPending(null)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [bulkForgetPending, bulkRevoking])

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      // Server-side filters: provider + statuses + limit. Date range
      // + search stay client-side for snappy interaction.
      const filter: {
        provider?: ProviderId
        statuses?: ApprovalLedgerStatus[]
        includeExpired?: boolean
        limit?: number
      } = {
        statuses: Array.from(statusFilter),
        includeExpired: statusFilter.has('expired'),
        limit: 1000
      }
      if (providerFilter !== 'all') filter.provider = providerFilter
      const result = (await window.api.getApprovalLedger(filter)) as ApprovalLedgerRecord[]
      setRecords(Array.isArray(result) ? result : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [providerFilter, statusFilter])

  // Initial load + refetch when filters change. Defer to microtask so
  // the synchronous state burst doesn't trigger React's "cascading
  // renders" lint guard.
  useEffect(() => {
    void Promise.resolve().then(() => refresh())
  }, [refresh])

  // Refresh on window focus so a decision made between visits shows up
  // without a manual reload.
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Client-side filters: date range + search. Date.now() is read at
  // memo computation time — the cutoff is a snapshot the filter pass
  // uses for the current render. The `react-hooks/purity` lint flags
  // it but the snapshot pattern is correct here: re-renders pick a
  // fresh cutoff, which is what the user wants for a "last N hours"
  // filter.
  const visibleRecords = useMemo(() => {
    const rangeWindow = DATE_RANGES.find((r) => r.id === dateRange)?.windowMs
    // eslint-disable-next-line react-hooks/purity
    const cutoff = rangeWindow ? Date.now() - rangeWindow : 0
    const needle = search.trim().toLowerCase()
    return records
      .filter((record) => {
        if (rangeWindow) {
          const requestedMs = Date.parse(record.requestedAt)
          if (Number.isFinite(requestedMs) && requestedMs < cutoff) return false
        }
        if (needle) {
          const haystack =
            `${record.approvalId} ${record.title} ${record.method} ${record.workspacePath ?? ''}`.toLowerCase()
          if (!haystack.includes(needle)) return false
        }
        return true
      })
      .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
  }, [records, dateRange, search])

  const sortedWorkspaceGrants = useMemo(
    () =>
      [...workspaceGrants].sort((a, b) => {
        const workspaceCompare = a.workspacePath.localeCompare(b.workspacePath)
        if (workspaceCompare !== 0) return workspaceCompare
        const providerCompare = a.provider.localeCompare(b.provider)
        if (providerCompare !== 0) return providerCompare
        return a.service.localeCompare(b.service)
      }),
    [workspaceGrants]
  )

  const toggleStatus = (status: ApprovalLedgerStatus): void => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      // Never let the filter become empty — that would hide everything.
      if (next.size === 0) next.add(status)
      return next
    })
  }

  const handleExport = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      filters: {
        provider: providerFilter,
        statuses: Array.from(statusFilter),
        dateRange,
        search: search || undefined
      },
      count: visibleRecords.length,
      records: visibleRecords
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    link.download = `taskwraith-approval-ledger-${stamp}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [providerFilter, statusFilter, dateRange, search, visibleRecords])

  const handleRevokeWorkspaceGrant = useCallback(
    async (grant: AgenticWorkspaceGrant): Promise<void> => {
      if (!onRevokeWorkspaceGrant) return
      try {
        setRevokeError(null)
        setRevokingGrantId(grant.id)
        await onRevokeWorkspaceGrant(grant)
      } catch (err) {
        setRevokeError(err instanceof Error ? err.message : String(err))
      } finally {
        setRevokingGrantId(null)
      }
    },
    [onRevokeWorkspaceGrant]
  )

  // Slice (1.0.3) — set of sub-thread delegation grants scoped to the
  // workspace the user is currently viewing. Only populated when the
  // host passes `currentWorkspacePath`; otherwise stays empty (and the
  // "Forget all" button stays hidden).
  const subThreadGrantsHere = useMemo<AgenticWorkspaceGrant[]>(() => {
    if (!currentWorkspacePath) return []
    return workspaceGrants.filter(
      (grant) =>
        grant.service === 'subThreadDelegation' && grant.workspacePath === currentWorkspacePath
    )
  }, [workspaceGrants, currentWorkspacePath])

  const handleConfirmBulkForget = useCallback(async (): Promise<void> => {
    if (!bulkForgetPending || !onRevokeWorkspaceGrant) return
    setRevokeError(null)
    setBulkRevoking(true)
    try {
      // Sequential rather than parallel — the underlying IPC writes
      // to disk through AppStore; serialising keeps the audit log
      // ordered and avoids racy partial updates. If one grant fails
      // we stop and surface the error so the user can retry rather
      // than silently leaving some intact.
      for (const grant of bulkForgetPending) {
        await onRevokeWorkspaceGrant(grant)
      }
      setBulkForgetPending(null)
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err))
    } finally {
      setBulkRevoking(false)
    }
  }, [bulkForgetPending, onRevokeWorkspaceGrant])

  return (
    <div className="approval-ledger-panel">
      <div className="approval-ledger-header">
        <label className="settings-label">Approvals</label>
        <div className="settings-hint approval-ledger-hint">
          Review durable workspace grants and the approval ledger for manual, policy, and timeout
          decisions.
        </div>
      </div>

      {error && <div className="settings-error approval-ledger-error">{error}</div>}
      {revokeError && <div className="settings-error approval-ledger-error">{revokeError}</div>}

      <section className="approval-grant-admin" aria-label="Workspace approval grants">
        <div className="approval-grant-admin-header">
          <div>
            <div className="approval-grant-admin-title">Workspace grants</div>
            <div className="settings-hint approval-grant-admin-hint">
              Session and run grants expire automatically; workspace grants stay active until
              revoked.
            </div>
          </div>
          <span className="approval-grant-admin-count">{sortedWorkspaceGrants.length}</span>
        </div>
        {/*
          Slice (1.0.3) — one-click bulk revoke for sub-thread
          delegation grants in the workspace the user is currently
          viewing. Only shown when there's at least one matching
          grant (and the host passed a workspace path). Opens a
          confirmation modal so the user sees what'll go before any
          IPC fires.
        */}
        {subThreadGrantsHere.length > 0 && (
          <div className="approval-grant-bulk-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost approval-grant-bulk-forget"
              onClick={() => setBulkForgetPending(subThreadGrantsHere)}
              disabled={!onRevokeWorkspaceGrant || bulkRevoking}
              title="Revoke every sub-thread delegation grant in this workspace"
            >
              Forget all sub-thread delegations for this workspace ({subThreadGrantsHere.length})
            </button>
          </div>
        )}
        {sortedWorkspaceGrants.length === 0 ? (
          <div className="settings-hint approval-grant-empty">No active workspace grants.</div>
        ) : (
          <ul className="approval-grant-list">
            {sortedWorkspaceGrants.map((grant) => {
              const createdAt = formatTimestamp(grant.createdAt)
              const isRevoking = revokingGrantId === grant.id
              return (
                <li key={grant.id} className="approval-grant-row">
                  <div className="approval-grant-row-main">
                    <span className="approval-grant-row-title">
                      {PROVIDER_LABELS[grant.provider]} ·{' '}
                      {getWorkspacePolicyServiceLabel(grant.service)}
                    </span>
                    <span className="approval-grant-row-meta" title={grant.workspacePath}>
                      {workspaceBasename(grant.workspacePath)} · Granted {createdAt}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost approval-grant-revoke"
                    onClick={() => void handleRevokeWorkspaceGrant(grant)}
                    disabled={!onRevokeWorkspaceGrant || isRevoking}
                  >
                    {isRevoking ? 'Revoking…' : 'Revoke'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <div className="approval-ledger-controls">
        <div className="approval-ledger-control-group">
          <label className="approval-ledger-control-label">Provider</label>
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value as ProviderId | 'all')}
            className="approval-ledger-select"
          >
            {ALL_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p === 'all' ? 'All providers' : p}
              </option>
            ))}
          </select>
        </div>

        <div className="approval-ledger-control-group">
          <label className="approval-ledger-control-label">Time range</label>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRangeId)}
            className="approval-ledger-select"
          >
            {DATE_RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div className="approval-ledger-control-group approval-ledger-control-search">
          <label className="approval-ledger-control-label">Search</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="approval id, title, workspace…"
            className="approval-ledger-input"
          />
        </div>
      </div>

      <div className="approval-ledger-status-row">
        {ALL_STATUSES.map((status) => (
          <label key={status} className="approval-ledger-status-chip">
            <input
              type="checkbox"
              checked={statusFilter.has(status)}
              onChange={() => toggleStatus(status)}
            />
            <span>{status}</span>
          </label>
        ))}
      </div>

      <div className="approval-ledger-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleExport}
          disabled={visibleRecords.length === 0}
        >
          Export JSON ({visibleRecords.length})
        </button>
      </div>

      <div className="approval-ledger-list">
        {loading && records.length === 0 ? (
          <div className="settings-hint">Loading…</div>
        ) : visibleRecords.length === 0 ? (
          <div className="settings-hint">No matching approval records.</div>
        ) : (
          <ul className="approval-ledger-rows">
            {visibleRecords.map((record) => (
              <ApprovalLedgerRow
                key={record.id}
                record={record}
                expanded={expandedId === record.id}
                onToggleExpand={() => setExpandedId(expandedId === record.id ? null : record.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {/*
        Slice (1.0.3) — confirmation modal for the bulk-forget action.
        Lists exactly which grants are about to be revoked so the user
        can audit the list before committing. Renders inline (no
        portal) since the Settings panel already establishes its own
        stacking context.
      */}
      {bulkForgetPending && (
        <div
          className="modal-overlay approval-grant-bulk-modal-overlay"
          role="presentation"
          onClick={() => {
            if (!bulkRevoking) setBulkForgetPending(null)
          }}
        >
          <div
            className="modal-card approval-grant-bulk-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-grant-bulk-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h2 id="approval-grant-bulk-modal-title">Forget sub-thread delegations?</h2>
                <p>
                  Revoke every sub-thread delegation grant in this workspace. Future delegations
                  will prompt for approval again.
                </p>
              </div>
            </div>
            <ul className="approval-grant-bulk-list">
              {bulkForgetPending.map((grant) => (
                <li key={grant.id} className="approval-grant-bulk-list-row">
                  <span className="approval-grant-bulk-list-provider">
                    {PROVIDER_LABELS[grant.provider]}
                  </span>
                  <span className="approval-grant-bulk-list-meta" title={grant.workspacePath}>
                    {workspaceBasename(grant.workspacePath)} · Granted{' '}
                    {formatTimestamp(grant.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setBulkForgetPending(null)}
                disabled={bulkRevoking}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary approval-grant-bulk-confirm"
                onClick={() => void handleConfirmBulkForget()}
                disabled={bulkRevoking}
              >
                {bulkRevoking ? 'Revoking…' : `Forget ${bulkForgetPending.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ApprovalLedgerRow({
  record,
  expanded,
  onToggleExpand
}: {
  record: ApprovalLedgerRecord
  expanded: boolean
  onToggleExpand: () => void
}): React.JSX.Element {
  const requestedAt = useMemo(() => formatTimestamp(record.requestedAt), [record.requestedAt])
  const respondedAt = useMemo(
    () => (record.respondedAt ? formatTimestamp(record.respondedAt) : undefined),
    [record.respondedAt]
  )
  const outcomeLabel = formatOutcome(record)
  const outcomeKind = outcomeKindFor(record)
  // Order-4 — optional one-line "why" note the user attached at
  // decision time. Stored on the ledger row's metadata as `intentNote`
  // (no schema migration). Surfaced read-only as a dedicated detail
  // line; only shown when present.
  const intentNote = intentNoteFor(record)

  return (
    <li className={`approval-ledger-row approval-ledger-row-${outcomeKind}`}>
      <button
        type="button"
        className="approval-ledger-row-header"
        onClick={onToggleExpand}
        aria-expanded={expanded}
      >
        <div className="approval-ledger-row-primary">
          <span className={`approval-ledger-badge approval-ledger-badge-${outcomeKind}`}>
            {outcomeLabel}
          </span>
          <span className="approval-ledger-row-title">{record.title}</span>
        </div>
        <div className="approval-ledger-row-meta">
          <span>{record.provider}</span>
          <span aria-hidden>·</span>
          <span>{requestedAt}</span>
          {record.workspacePath && (
            <>
              <span aria-hidden>·</span>
              <span className="approval-ledger-row-workspace" title={record.workspacePath}>
                {workspaceBasename(record.workspacePath)}
              </span>
            </>
          )}
        </div>
      </button>
      {expanded && (
        <div className="approval-ledger-row-details">
          <DetailLine label="Approval id" value={record.approvalId} />
          <DetailLine label="Method" value={record.method} />
          {record.service && <DetailLine label="Service" value={record.service} />}
          <DetailLine label="Status" value={record.status} />
          {record.decision && <DetailLine label="Decision" value={record.decision} />}
          {record.decisionSource && (
            <DetailLine label="Decision source" value={record.decisionSource} />
          )}
          {record.grantedScope && <DetailLine label="Granted scope" value={record.grantedScope} />}
          {intentNote && <DetailLine label="Note" value={intentNote} />}
          <DetailLine label="Requested" value={requestedAt} />
          {respondedAt && <DetailLine label="Responded" value={respondedAt} />}
          {record.expiration && (
            <DetailLine
              label="Expiration"
              value={`${record.expiration.mode} — ${record.expiration.description}`}
            />
          )}
          {record.runId && <DetailLine label="Run id" value={record.runId} />}
          {record.chatId && <DetailLine label="Chat id" value={record.chatId} />}
          {record.workspacePath && (
            <DetailLine label="Workspace path" value={record.workspacePath} />
          )}
          {record.body && (
            <div className="approval-ledger-row-body">
              <div className="approval-ledger-row-body-label">Body</div>
              <pre className="approval-ledger-row-body-text">{record.body}</pre>
            </div>
          )}
          {record.metadata && Object.keys(record.metadata).length > 0 && (
            <div className="approval-ledger-row-metadata">
              <div className="approval-ledger-row-body-label">Metadata</div>
              <pre className="approval-ledger-row-body-text">
                {JSON.stringify(record.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function DetailLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="approval-ledger-detail-line">
      <span className="approval-ledger-detail-label">{label}</span>
      <span className="approval-ledger-detail-value">{value}</span>
    </div>
  )
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return iso
  }
}

/** Order-4 — the optional one-line "why" note the user attached when
 * making this decision. Lives on the ledger metadata channel as
 * `intentNote` (no schema migration). Returns undefined when absent or
 * not a non-empty string. */
function intentNoteFor(record: ApprovalLedgerRecord): string | undefined {
  const note = record.metadata?.intentNote
  if (typeof note === 'string' && note.trim().length > 0) return note.trim()
  return undefined
}

/** True when the record was auto-denied by the Phase E1 timer (vs
 * auto-denied by policy). Detected by the metadata flag the timeout
 * path attaches in `index.ts`. */
function wasAutoDeniedByTimeout(record: ApprovalLedgerRecord): boolean {
  return (
    record.decision === 'autoDeny' &&
    typeof record.metadata?.autoDeniedByTimeout === 'boolean' &&
    record.metadata.autoDeniedByTimeout === true
  )
}

/** Human-friendly outcome label that includes auto-denial via timeout
 * as a distinct value the user cares about. */
function formatOutcome(record: ApprovalLedgerRecord): string {
  if (record.status === 'pending') return 'Pending'
  if (wasAutoDeniedByTimeout(record)) {
    const timeoutMs =
      typeof record.metadata?.timeoutMs === 'number' ? record.metadata.timeoutMs : undefined
    return timeoutMs
      ? `Auto-denied · ${Math.round(timeoutMs / 1000)}s timeout`
      : 'Auto-denied · timeout'
  }
  if (record.decision === 'autoAllow') return 'Auto-allowed'
  if (record.decision === 'autoDeny') return 'Auto-denied'
  if (record.decision === 'expired') return 'Expired'
  if (record.status === 'approved') return 'Approved'
  if (record.status === 'denied') return 'Denied'
  if (record.status === 'cancelled') return 'Cancelled'
  if (record.status === 'expired') return 'Expired'
  return record.decision ?? record.status
}

/** Short kind code used for badge + row CSS variants. */
function outcomeKindFor(record: ApprovalLedgerRecord): string {
  if (record.status === 'pending') return 'pending'
  if (wasAutoDeniedByTimeout(record)) return 'auto-deny-timeout'
  if (record.decision === 'autoAllow') return 'auto-allow'
  if (record.decision === 'autoDeny') return 'auto-deny'
  if (record.decision === 'expired' || record.status === 'expired') return 'expired'
  if (record.status === 'approved') return 'approved'
  if (record.status === 'denied') return 'denied'
  if (record.status === 'cancelled') return 'cancelled'
  return 'unknown'
}

function workspaceBasename(workspacePath: string): string {
  const parts = workspacePath.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || workspacePath
}
