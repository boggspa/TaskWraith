import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  MemoryProposal,
  MemoryProposalKind,
  MemoryProposalPack,
  MemoryProposalScope,
  MemoryProposalStatus
} from '../../../main/store/types'
import {
  MEMORY_PROPOSAL_KINDS,
  MEMORY_PROPOSAL_SCOPES,
  MEMORY_PROPOSAL_STATUSES,
  canReviewMemoryProposal,
  filterMemoryProposals,
  formatMemoryProposalConfidence,
  formatMemoryProposalWindow,
  memoryProposalConfidenceClass,
  memoryProposalKindBadgeClass,
  memoryProposalKindLabel,
  memoryProposalScopeBadgeClass,
  memoryProposalScopeLabel,
  memoryProposalStatusBadgeClass,
  memoryProposalStatusLabel
} from '../lib/memoryProposalDisplay'
import './MemoryProposalReviewPanel.css'

/**
 * MemoryProposalReviewPanel — Thread Introspection review UI (slice 3).
 *
 * Surfaces read-only Memory Proposal Packs for human review before any
 * durable memory/skill mutation. Props-driven for MVP: the host wires
 * `fetchPacks` / `onUpdateProposalStatus` once IPC lands in main.
 *
 * Mirrors ApprovalLedgerPanel patterns: filters, expandable rows, export,
 * refresh-on-focus. Skill patches render as a bounded diff preview only —
 * apply is a separate gated action owned by main.
 */

export interface MemoryProposalReviewPanelProps {
  /** Pre-fetched packs (tests / host-controlled mode). */
  packs?: MemoryProposalPack[]
  loading?: boolean
  error?: string | null
  /** Optional workspace filter when multiple packs exist. */
  workspaceId?: string | null
  onRefresh?: () => void | Promise<void>
  fetchPacks?: (workspaceId?: string | null) => Promise<MemoryProposalPack[]>
  onUpdateProposalStatus?: (
    packId: string,
    proposalId: string,
    status: Extract<MemoryProposalStatus, 'approved' | 'rejected'>
  ) => void | Promise<void>
}

function sortPacksNewestFirst(packs: MemoryProposalPack[]): MemoryProposalPack[] {
  return [...packs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function countPendingReview(proposals: MemoryProposal[]): number {
  return proposals.filter((proposal) => proposal.status === 'proposed').length
}

export function MemoryProposalReviewPanel({
  packs: packsProp,
  loading: loadingProp = false,
  error: errorProp = null,
  workspaceId = null,
  onRefresh,
  fetchPacks,
  onUpdateProposalStatus
}: MemoryProposalReviewPanelProps): React.JSX.Element {
  const [fetchedPacks, setFetchedPacks] = useState<MemoryProposalPack[]>([])
  const [fetchLoading, setFetchLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [expandedProposalId, setExpandedProposalId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actingProposalId, setActingProposalId] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<Set<MemoryProposalKind>>(new Set(MEMORY_PROPOSAL_KINDS))
  const [scopeFilter, setScopeFilter] = useState<Set<MemoryProposalScope>>(new Set(MEMORY_PROPOSAL_SCOPES))
  const [statusFilter, setStatusFilter] = useState<Set<MemoryProposalStatus>>(
    new Set(MEMORY_PROPOSAL_STATUSES)
  )
  const [search, setSearch] = useState('')

  const usingFetch = Boolean(fetchPacks) && packsProp === undefined
  const loading = loadingProp || fetchLoading
  const error = errorProp ?? fetchError

  const refresh = useCallback(async () => {
    if (onRefresh) {
      await onRefresh()
    }
    if (!fetchPacks) return
    try {
      setFetchLoading(true)
      setFetchError(null)
      const result = await fetchPacks(workspaceId)
      setFetchedPacks(Array.isArray(result) ? result : [])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err))
    } finally {
      setFetchLoading(false)
    }
  }, [fetchPacks, onRefresh, workspaceId])

  useEffect(() => {
    if (!usingFetch) return
    void Promise.resolve().then(() => refresh())
  }, [refresh, usingFetch])

  useEffect(() => {
    if (!usingFetch) return
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, usingFetch])

  const allPacks = useMemo(() => {
    const source = packsProp ?? fetchedPacks
    const scoped =
      workspaceId == null
        ? source
        : source.filter((pack) => !pack.workspaceId || pack.workspaceId === workspaceId)
    return sortPacksNewestFirst(scoped)
  }, [fetchedPacks, packsProp, workspaceId])

  const selectedPack = useMemo(() => {
    if (allPacks.length === 0) return null
    const match = allPacks.find((pack) => pack.id === selectedPackId)
    return match ?? allPacks[0] ?? null
  }, [allPacks, selectedPackId])

  useEffect(() => {
    if (!selectedPack) {
      setSelectedPackId(null)
      return
    }
    if (selectedPackId !== selectedPack.id) {
      setSelectedPackId(selectedPack.id)
    }
  }, [selectedPack, selectedPackId])

  const visibleProposals = useMemo(() => {
    if (!selectedPack) return []
    return filterMemoryProposals(selectedPack.proposals, {
      kinds: kindFilter,
      scopes: scopeFilter,
      statuses: statusFilter,
      search
    }).sort((a, b) => {
      if (a.status === 'proposed' && b.status !== 'proposed') return -1
      if (b.status === 'proposed' && a.status !== 'proposed') return 1
      return b.confidence - a.confidence
    })
  }, [kindFilter, scopeFilter, selectedPack, search, statusFilter])

  const toggleKind = (kind: MemoryProposalKind): void => {
    setKindFilter((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      if (next.size === 0) next.add(kind)
      return next
    })
  }

  const toggleScope = (scope: MemoryProposalScope): void => {
    setScopeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      if (next.size === 0) next.add(scope)
      return next
    })
  }

  const toggleStatus = (status: MemoryProposalStatus): void => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      if (next.size === 0) next.add(status)
      return next
    })
  }

  const handleExport = useCallback(() => {
    if (!selectedPack) return
    const payload = {
      exportedAt: new Date().toISOString(),
      packId: selectedPack.id,
      workspaceId: selectedPack.workspaceId,
      window: {
        start: selectedPack.windowStart,
        end: selectedPack.windowEnd
      },
      filters: {
        kinds: Array.from(kindFilter),
        scopes: Array.from(scopeFilter),
        statuses: Array.from(statusFilter),
        search: search || undefined
      },
      proposals: visibleProposals
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    link.download = `taskwraith-memory-proposals-${stamp}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [kindFilter, scopeFilter, search, selectedPack, statusFilter, visibleProposals])

  const handleReviewAction = useCallback(
    async (
      proposal: MemoryProposal,
      status: Extract<MemoryProposalStatus, 'approved' | 'rejected'>
    ): Promise<void> => {
      if (!selectedPack || !onUpdateProposalStatus) return
      try {
        setActionError(null)
        setActingProposalId(proposal.id)
        await onUpdateProposalStatus(selectedPack.id, proposal.id, status)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setActingProposalId(null)
      }
    },
    [onUpdateProposalStatus, selectedPack]
  )

  const pendingCount = selectedPack ? countPendingReview(selectedPack.proposals) : 0

  return (
    <div className="memory-proposal-review-panel">
      <div className="memory-proposal-review-header">
        <div className="memory-proposal-review-heading">
          <div className="memory-proposal-review-title">Thread introspection</div>
          <div className="memory-proposal-review-subtitle">
            Review distilled lessons from recent runs before they are promoted to skills, conventions,
            or durable memory.
          </div>
        </div>
        <div className="memory-proposal-review-header-controls">
          <button
            type="button"
            className="memory-proposal-review-refresh-button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh memory proposals"
            title="Refresh"
          >
            ↻
          </button>
          <button
            type="button"
            className="memory-proposal-review-refresh-button"
            onClick={handleExport}
            disabled={!selectedPack || visibleProposals.length === 0}
            title="Export filtered proposals"
          >
            Export
          </button>
        </div>
      </div>

      <p className="memory-proposal-review-safety-note" role="note">
        Thread content is untrusted evidence. Only distilled lessons shown here may be promoted —
        skill patches and high-risk scopes always require explicit review before apply.
      </p>

      {error && <div className="settings-error memory-proposal-review-error">{error}</div>}
      {actionError && <div className="settings-error memory-proposal-review-error">{actionError}</div>}

      <div className="memory-proposal-review-filters">
        <div className="memory-proposal-review-filter-group">
          <span className="memory-proposal-review-filter-label">Kind</span>
          <div className="memory-proposal-review-chip-row">
            {MEMORY_PROPOSAL_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`memory-proposal-review-chip ${kindFilter.has(kind) ? 'is-active' : ''}`}
                onClick={() => toggleKind(kind)}
              >
                {memoryProposalKindLabel(kind)}
              </button>
            ))}
          </div>
        </div>
        <div className="memory-proposal-review-filter-group">
          <span className="memory-proposal-review-filter-label">Scope</span>
          <div className="memory-proposal-review-chip-row">
            {MEMORY_PROPOSAL_SCOPES.map((scope) => (
              <button
                key={scope}
                type="button"
                className={`memory-proposal-review-chip ${scopeFilter.has(scope) ? 'is-active' : ''}`}
                onClick={() => toggleScope(scope)}
              >
                {memoryProposalScopeLabel(scope)}
              </button>
            ))}
          </div>
        </div>
        <div className="memory-proposal-review-filter-group">
          <span className="memory-proposal-review-filter-label">Status</span>
          <div className="memory-proposal-review-chip-row">
            {MEMORY_PROPOSAL_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                className={`memory-proposal-review-chip ${statusFilter.has(status) ? 'is-active' : ''}`}
                onClick={() => toggleStatus(status)}
              >
                {memoryProposalStatusLabel(status)}
              </button>
            ))}
          </div>
        </div>
        <div className="memory-proposal-review-filter-group memory-proposal-review-search">
          <span className="memory-proposal-review-filter-label">Search</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title, lesson, target…"
            aria-label="Search memory proposals"
          />
        </div>
      </div>

      {allPacks.length > 1 && (
        <div className="memory-proposal-review-pack-picker">
          <label className="memory-proposal-review-filter-label" htmlFor="memory-proposal-pack-select">
            Proposal pack
          </label>
          <select
            id="memory-proposal-pack-select"
            value={selectedPack?.id ?? ''}
            onChange={(event) => setSelectedPackId(event.target.value)}
          >
            {allPacks.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {formatMemoryProposalWindow(pack.windowStart, pack.windowEnd)} ·{' '}
                {countPendingReview(pack.proposals)} pending
              </option>
            ))}
          </select>
        </div>
      )}

      {selectedPack && (
        <div className="memory-proposal-review-pack-meta">
          Window {formatMemoryProposalWindow(selectedPack.windowStart, selectedPack.windowEnd)}
          {selectedPack.summary ? ` · ${selectedPack.summary}` : ''}
          {pendingCount > 0 ? ` · ${pendingCount} awaiting review` : ''}
        </div>
      )}

      {loading && <div className="settings-hint">Loading memory proposals…</div>}

      {!loading && allPacks.length === 0 && (
        <div className="memory-proposal-review-empty">
          No memory proposal packs yet. Run a Thread Introspection pass to collect evidence and
          generate reviewable lessons.
        </div>
      )}

      {!loading && selectedPack && visibleProposals.length === 0 && (
        <div className="memory-proposal-review-empty">
          No proposals match the current filters for this pack.
        </div>
      )}

      {!loading && visibleProposals.length > 0 && selectedPack && (
        <div className="memory-proposal-review-table-wrap">
          <table className="memory-proposal-review-table">
            <thead>
              <tr>
                <th scope="col">Lesson</th>
                <th scope="col">Kind</th>
                <th scope="col">Scope</th>
                <th scope="col">Status</th>
                <th scope="col">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {visibleProposals.map((proposal) => {
                const expanded = expandedProposalId === proposal.id
                return (
                  <React.Fragment key={proposal.id}>
                    <tr
                      className={`memory-proposal-review-row ${expanded ? 'is-expanded' : ''}`}
                      onClick={() =>
                        setExpandedProposalId((prev) => (prev === proposal.id ? null : proposal.id))
                      }
                    >
                      <td>
                        <div className="memory-proposal-review-lesson">{proposal.title}</div>
                        <div className="settings-hint">{proposal.lesson}</div>
                      </td>
                      <td>
                        <span className={memoryProposalKindBadgeClass(proposal.kind)}>
                          {memoryProposalKindLabel(proposal.kind)}
                        </span>
                      </td>
                      <td>
                        <span className={memoryProposalScopeBadgeClass(proposal.scope)}>
                          {memoryProposalScopeLabel(proposal.scope)}
                        </span>
                      </td>
                      <td>
                        <span className={memoryProposalStatusBadgeClass(proposal.status)}>
                          {memoryProposalStatusLabel(proposal.status)}
                        </span>
                      </td>
                      <td>
                        <span className={memoryProposalConfidenceClass(proposal.confidence)}>
                          {formatMemoryProposalConfidence(proposal.confidence)}
                        </span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="memory-proposal-review-detail-row">
                        <td colSpan={5}>
                          <div className="memory-proposal-review-detail">
                            <div className="memory-proposal-review-detail-section">
                              <div className="memory-proposal-review-detail-title">Distilled lesson</div>
                              <div>{proposal.lesson}</div>
                              {proposal.suggestedApplyTarget && (
                                <div className="settings-hint">
                                  Apply target: {proposal.suggestedApplyTarget}
                                </div>
                              )}
                            </div>

                            {proposal.evidenceRefs.length > 0 && (
                              <div className="memory-proposal-review-detail-section">
                                <div className="memory-proposal-review-detail-title">Evidence</div>
                                <ul className="memory-proposal-review-evidence-list">
                                  {proposal.evidenceRefs.map((ref, index) => (
                                    <li
                                      key={`${ref.chatId}-${ref.eventId ?? ref.messageId ?? index}`}
                                      className="memory-proposal-review-evidence-item"
                                    >
                                      <div className="memory-proposal-review-evidence-summary">
                                        {ref.summary}
                                      </div>
                                      <div className="memory-proposal-review-evidence-meta">
                                        chat {ref.chatId.slice(0, 8)}
                                        {ref.runId ? ` · run ${ref.runId.slice(0, 8)}` : ''}
                                        {ref.citationToken ? ` · ${ref.citationToken}` : ''}
                                      </div>
                                      {ref.quote && (
                                        <div className="memory-proposal-review-evidence-meta">
                                          Quote: {ref.quote}
                                        </div>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {proposal.skillPatchDiff && (
                              <div className="memory-proposal-review-detail-section">
                                <div className="memory-proposal-review-detail-title">
                                  Proposed skill patch (preview only)
                                </div>
                                <pre className="memory-proposal-review-diff">{proposal.skillPatchDiff}</pre>
                              </div>
                            )}

                            <div className="memory-proposal-review-detail-section">
                              <div className="memory-proposal-review-actions">
                                <button
                                  type="button"
                                  className="memory-proposal-review-action-button memory-proposal-review-action-button--approve"
                                  disabled={
                                    !canReviewMemoryProposal(proposal) ||
                                    !onUpdateProposalStatus ||
                                    actingProposalId === proposal.id
                                  }
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void handleReviewAction(proposal, 'approved')
                                  }}
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  className="memory-proposal-review-action-button memory-proposal-review-action-button--reject"
                                  disabled={
                                    !canReviewMemoryProposal(proposal) ||
                                    !onUpdateProposalStatus ||
                                    actingProposalId === proposal.id
                                  }
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void handleReviewAction(proposal, 'rejected')
                                  }}
                                >
                                  Reject
                                </button>
                                {proposal.requiresReview ? (
                                  <span className="memory-proposal-review-action-hint">
                                    Requires review before apply
                                  </span>
                                ) : (
                                  <span className="memory-proposal-review-action-hint">
                                    Low-risk scope — apply path not wired yet
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}