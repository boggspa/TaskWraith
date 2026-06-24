import React, { useCallback, useEffect, useState } from 'react'
import type { WorkflowRunSummary, WorkflowRunEvent } from '../../../main/WorkflowRunStore'

// Slice 7a-2 — the Electron loop-progress surface. A self-contained, read-only
// panel for the SELECTED workflow's recent executions, reading the durable ledger
// via the Stage-1 query IPC (getWorkflowRunSummaries / getWorkflowRunEvents). For a
// LOOP execution it drills into the per-iteration maker→verifier→verdict timeline
// (the verdict + stopReason persisted in slice 7a-1); a single-occurrence run shows
// just its lifecycle. No mutation, no global state — it mounts inside the sidebar's
// selected-workflow detail and fetches its own data, so App.tsx is untouched.

const MAX_RUNS = 6

interface WorkflowRunHistoryProps {
  workflowId: string
}

interface IterationRow {
  iteration: number
  tokens?: number
  decision?: 'accept' | 'revise' | 'reject'
  evidence?: string
}

/** Fold an execution's raw events into per-iteration rows (the verifier's harvested
 * event carries the verdict; both maker + verifier carry tokens, summed). Pure. */
export function foldIterations(events: readonly WorkflowRunEvent[]): IterationRow[] {
  const byIter = new Map<number, IterationRow>()
  for (const event of events) {
    if (typeof event.iteration !== 'number') continue
    const row = byIter.get(event.iteration) ?? { iteration: event.iteration }
    if (typeof event.tokens === 'number') row.tokens = (row.tokens ?? 0) + event.tokens
    if (event.verdict) {
      row.decision = event.verdict.decision
      row.evidence = event.verdict.evidence
    }
    byIter.set(event.iteration, row)
  }
  return [...byIter.values()].sort((a, b) => a.iteration - b.iteration)
}

/** Map a folded status to a short label + a tone class shared with the sidebar. */
function statusLabel(status: WorkflowRunSummary['status']): string {
  switch (status) {
    case 'loop_settled':
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'skipped':
      return 'Skipped'
    case 'stall_settled':
      return 'Stalled'
    case 'running':
      return 'Running'
    default:
      return 'Pending'
  }
}

function statusTone(status: WorkflowRunSummary['status']): string {
  if (status === 'failed' || status === 'stall_settled') return 'danger'
  if (status === 'cancelled' || status === 'skipped') return 'muted'
  if (status === 'running') return 'active'
  return 'ok'
}

function formatWhen(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function decisionGlyph(decision?: 'accept' | 'revise' | 'reject'): string {
  if (decision === 'accept') return '✓'
  if (decision === 'reject') return '✕'
  if (decision === 'revise') return '↻'
  return '·'
}

export function WorkflowRunHistory({ workflowId }: WorkflowRunHistoryProps): React.JSX.Element | null {
  const [summaries, setSummaries] = useState<WorkflowRunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [iterationsById, setIterationsById] = useState<Record<string, IterationRow[]>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setExpandedId(null)
    setIterationsById({})
    void (async () => {
      try {
        const result = await window.api.getWorkflowRunSummaries(workflowId)
        if (cancelled) return
        setSummaries(Array.isArray(result) ? result.slice(0, MAX_RUNS) : [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load run history')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workflowId])

  const toggleExpand = useCallback(
    async (summary: WorkflowRunSummary) => {
      const execId = summary.workflowExecutionId
      if (expandedId === execId) {
        setExpandedId(null)
        return
      }
      setExpandedId(execId)
      // Only loop executions have iterations to drill into; lazy-fetch once.
      if (!summary.iterationCount || iterationsById[execId]) return
      try {
        const events = await window.api.getWorkflowRunEvents({ workflowExecutionId: execId })
        setIterationsById((prev) => ({ ...prev, [execId]: foldIterations(events || []) }))
      } catch {
        setIterationsById((prev) => ({ ...prev, [execId]: [] }))
      }
    },
    [expandedId, iterationsById]
  )

  if (loading) {
    return <div className="sidebar-workflow-history is-muted">Loading run history…</div>
  }
  if (error) {
    return <div className="sidebar-workflow-history is-error">{error}</div>
  }
  if (summaries.length === 0) return null

  return (
    <div className="sidebar-workflow-history" aria-label="Workflow run history">
      <div className="sidebar-workflow-history-title">Run history</div>
      {summaries.map((summary) => {
        const execId = summary.workflowExecutionId
        const expanded = expandedId === execId
        const isLoop = typeof summary.iterationCount === 'number'
        const iterations = iterationsById[execId]
        return (
          <div key={execId} className="sidebar-workflow-history-item">
            <button
              type="button"
              className="sidebar-workflow-history-row"
              onClick={() => void toggleExpand(summary)}
              aria-expanded={expanded}
              title={summary.stopReason ? `Stopped: ${summary.stopReason}` : statusLabel(summary.status)}
            >
              <span className={`sidebar-workflow-history-dot tone-${statusTone(summary.status)}`} />
              <span className="sidebar-workflow-history-when">
                {formatWhen(summary.completedAt || summary.startedAt || summary.plannedFor)}
              </span>
              {isLoop && (
                <span className="sidebar-workflow-history-iters" title={`${summary.iterationCount} iterations`}>
                  {summary.iterationCount}×
                </span>
              )}
              {typeof summary.tokens === 'number' && summary.tokens > 0 && (
                <span className="sidebar-workflow-history-cost">{summary.tokens.toLocaleString()} tok</span>
              )}
              <span className="sidebar-workflow-history-status">
                {summary.stopReason || statusLabel(summary.status)}
              </span>
            </button>
            {expanded && isLoop && (
              <div className="sidebar-workflow-history-detail">
                {iterations === undefined ? (
                  <div className="is-muted">Loading iterations…</div>
                ) : iterations.length === 0 ? (
                  <div className="is-muted">No iteration detail recorded.</div>
                ) : (
                  iterations.map((it) => (
                    <div key={it.iteration} className="sidebar-workflow-history-iter">
                      <span className="sidebar-workflow-history-iter-n">{it.iteration}</span>
                      <span
                        className={`sidebar-workflow-history-verdict decision-${it.decision || 'none'}`}
                        title={it.evidence || it.decision || 'no verdict'}
                      >
                        {decisionGlyph(it.decision)} {it.decision || 'maker only'}
                      </span>
                      {it.evidence && (
                        <span className="sidebar-workflow-history-evidence">{it.evidence}</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
