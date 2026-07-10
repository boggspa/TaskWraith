import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RunEventReplay } from '../../../main/store/types'
import { classifyEventsForInspector, type InspectorRow } from '../lib/RunEventClassifier'
import { PillButton } from './PillButton'

/**
 * RunInspector — Phase K1 Slice 1B.
 *
 * Dense, keyboard-navigable timeline view of a single run. Consumes
 * `window.api.getRunEventReplay(runId)` (an already-existing IPC) and
 * renders one row per classified event.
 *
 * Component scope (mounted by App.tsx when the chat panel is in
 * "Run mode" — that integration is a separate commit waiting for
 * Codex's Slice 1A to land):
 *   - Fetches replay on mount + on runId change.
 *   - Renders header (run id, provider, basic counts, close button).
 *   - Renders rows for each event using `InspectorRow` discriminator.
 *   - Keyboard nav: ↑/↓ move selection, Home/End jump, Esc → onClose,
 *     Enter triggers an optional onJump callback for actionable rows.
 *   - No mutation: read-only inspector. Restoring / re-running /
 *     editing all live in future phases.
 *
 * Out of scope (deliberate, deferred to later slices/phases):
 *   - Restore-to-checkpoint affordances (Phase 3).
 *   - Inline diff rendering (Phase 2).
 *   - Sub-thread navigation handlers (parent wires via `onJump`).
 *   - Filtering / search inside a single run (low value at this scale;
 *     can revisit if runs grow into hundreds of events).
 */

export interface RunInspectorProps {
  /** Run to inspect. The component refetches when this changes. */
  runId: string
  /** Optional close handler (rendered as a × in the header). */
  onClose?: () => void
  /** Optional callback when the user presses Enter on a sub-thread row
   * or clicks a sub-thread link — parent navigates the chat list. */
  onJumpToSubThread?: (subThreadId: string) => void
  /** Optional callback for file-path rows — parent could open the file
   * or jump to a diff view. */
  onJumpToFile?: (path: string) => void
}

export function RunInspector({
  runId,
  onClose,
  onJumpToSubThread,
  onJumpToFile
}: RunInspectorProps): React.JSX.Element {
  const [replay, setReplay] = useState<RunEventReplay | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    if (!runId) return
    try {
      setLoading(true)
      setError(null)
      const result = (await window.api.getRunEventReplay(runId)) as RunEventReplay
      setReplay(result ?? null)
      setSelectedIndex(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setReplay(null)
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

  const rows: InspectorRow[] = useMemo(() => {
    if (!replay?.events) return []
    return classifyEventsForInspector(replay.events)
  }, [replay])

  // Keyboard navigation. Attaches at the container level; consumers are
  // responsible for ensuring the container has focus (we autofocus on
  // mount via the listRef).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((i) => Math.min(i + 1, rows.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((i) => Math.max(i - 1, 0))
          break
        case 'Home':
          e.preventDefault()
          setSelectedIndex(0)
          break
        case 'End':
          e.preventDefault()
          setSelectedIndex(rows.length - 1)
          break
        case 'Escape':
          if (onClose) {
            e.preventDefault()
            onClose()
          }
          break
        case 'Enter': {
          const row = rows[selectedIndex]
          if (!row) return
          if (row.kind === 'subthread_spawn' && row.subThreadId && onJumpToSubThread) {
            e.preventDefault()
            onJumpToSubThread(row.subThreadId)
          } else if (
            row.kind === 'approval_request' &&
            row.paths &&
            row.paths.length > 0 &&
            onJumpToFile
          ) {
            e.preventDefault()
            onJumpToFile(row.paths[0])
          } else if (row.kind === 'diff' && row.paths && row.paths.length > 0 && onJumpToFile) {
            e.preventDefault()
            onJumpToFile(row.paths[0])
          }
          break
        }
        default:
          break
      }
    },
    [rows, selectedIndex, onClose, onJumpToSubThread, onJumpToFile]
  )

  // Autofocus on mount so keyboard nav works without a click.
  useEffect(() => {
    listRef.current?.focus()
  }, [runId])

  // Scroll the selected row into view as the user moves through the list.
  useEffect(() => {
    if (!listRef.current) return
    const selected = listRef.current.querySelector<HTMLElement>(
      `[data-row-index="${selectedIndex}"]`
    )
    selected?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [selectedIndex])

  return (
    <div className="run-inspector" tabIndex={-1} onKeyDown={onKeyDown} ref={listRef}>
      <RunInspectorHeader
        runId={runId}
        replay={replay}
        loading={loading}
        onRefresh={() => void refresh()}
        onClose={onClose}
      />

      {error && <div className="settings-error run-inspector__error">{error}</div>}

      {!loading && !error && rows.length === 0 && (
        <div className="settings-hint run-inspector__empty">
          No events recorded for this run yet.
        </div>
      )}

      <div className="run-inspector__rows" role="list">
        {rows.map((row, idx) => (
          <RunInspectorRowView
            key={row.raw.id ?? `${row.raw.sequence}-${idx}`}
            row={row}
            selected={idx === selectedIndex}
            index={idx}
            onSelect={() => setSelectedIndex(idx)}
            onJumpToSubThread={onJumpToSubThread}
            onJumpToFile={onJumpToFile}
          />
        ))}
      </div>

      {rows.length > 0 && (
        <footer className="run-inspector__keyboard-hints" aria-label="Keyboard shortcuts">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>navigate</span>
          <span className="run-inspector__keyboard-hints-sep">·</span>
          <kbd>Home</kbd>
          <kbd>End</kbd>
          <span>jump</span>
          <span className="run-inspector__keyboard-hints-sep">·</span>
          <kbd>↵</kbd>
          <span>open</span>
          <span className="run-inspector__keyboard-hints-sep">·</span>
          <kbd>Esc</kbd>
          <span>close</span>
        </footer>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────

function RunInspectorHeader({
  runId,
  replay,
  loading,
  onRefresh,
  onClose
}: {
  runId: string
  replay: RunEventReplay | null
  loading: boolean
  onRefresh: () => void
  onClose?: () => void
}): React.JSX.Element {
  const shortRunId = useMemo(() => runId.slice(0, 8), [runId])
  const counts = replay?.countsByKind ?? {}
  const approvals = (counts.approval_request ?? 0) as number
  const subthreads = (counts.subthread_spawned ?? 0) as number
  const errors = (counts.provider_error ?? 0) as number
  const startedAt = replay?.startedAt
  const endedAt = replay?.endedAt
  const duration =
    startedAt && endedAt
      ? formatDuration(new Date(endedAt).getTime() - new Date(startedAt).getTime())
      : undefined

  return (
    <header className="run-inspector__header">
      <div className="run-inspector__header-titles">
        <span className="run-inspector__title">Run</span>
        <code className="run-inspector__run-id" title={runId}>
          {shortRunId}
        </code>
        {duration && <span className="run-inspector__duration">{duration}</span>}
      </div>
      <div className="run-inspector__header-stats">
        {approvals > 0 && (
          <Pill kind="info">
            {approvals} approval{approvals === 1 ? '' : 's'}
          </Pill>
        )}
        {subthreads > 0 && (
          <Pill kind="info">
            {subthreads} sub-thread{subthreads === 1 ? '' : 's'}
          </Pill>
        )}
        {errors > 0 && (
          <Pill kind="warn">
            {errors} error{errors === 1 ? '' : 's'}
          </Pill>
        )}
        <Pill kind="idle">{replay?.count ?? 0} events</Pill>
      </div>
      <div className="run-inspector__header-actions">
        <PillButton
          size="compact"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh replay"
        >
          {loading ? '…' : '↻'}
        </PillButton>
        {onClose && (
          <PillButton
            size="compact"
            onClick={onClose}
            title="Close inspector (Esc)"
            aria-label="Close inspector"
          >
            ×
          </PillButton>
        )}
      </div>
    </header>
  )
}

// ──────────────────────────────────────────────────────────────────────────────

function RunInspectorRowView({
  row,
  selected,
  index,
  onSelect,
  onJumpToSubThread,
  onJumpToFile
}: {
  row: InspectorRow
  selected: boolean
  index: number
  onSelect: () => void
  onJumpToSubThread?: (subThreadId: string) => void
  onJumpToFile?: (path: string) => void
}): React.JSX.Element {
  const time = useMemo(() => formatTime(row.raw.timestamp), [row.raw.timestamp])
  const meta = describeRow(row)

  return (
    <div
      className={`run-inspector__row run-inspector__row--${row.kind}${selected ? ' is-selected' : ''}`}
      data-row-index={index}
      role="listitem"
      onClick={onSelect}
    >
      <span className="run-inspector__row-glyph" aria-hidden>
        {meta.glyph}
      </span>
      <span className="run-inspector__row-time">{time}</span>
      <span className="run-inspector__row-kind">{meta.label}</span>
      <span className="run-inspector__row-summary">{meta.summary}</span>
      <RowChips row={row} onJumpToSubThread={onJumpToSubThread} onJumpToFile={onJumpToFile} />
    </div>
  )
}

function RowChips({
  row,
  onJumpToSubThread,
  onJumpToFile
}: {
  row: InspectorRow
  onJumpToSubThread?: (subThreadId: string) => void
  onJumpToFile?: (path: string) => void
}): React.JSX.Element | null {
  if (row.kind === 'subthread_spawn' && row.subThreadId) {
    return (
      <div className="run-inspector__row-chips">
        {row.provider && <span className="run-inspector__chip">{row.provider}</span>}
        {onJumpToSubThread && (
          <button
            type="button"
            className="run-inspector__chip run-inspector__chip--link"
            onClick={(e) => {
              e.stopPropagation()
              if (row.subThreadId) onJumpToSubThread(row.subThreadId)
            }}
          >
            view →
          </button>
        )}
      </div>
    )
  }

  if (
    (row.kind === 'approval_request' || row.kind === 'diff') &&
    row.paths &&
    row.paths.length > 0
  ) {
    return (
      <div className="run-inspector__row-chips">
        {row.paths.slice(0, 3).map((p) => (
          <button
            key={p}
            type="button"
            className="run-inspector__chip run-inspector__chip--link"
            onClick={(e) => {
              e.stopPropagation()
              onJumpToFile?.(p)
            }}
            title={p}
          >
            {shortPath(p)}
          </button>
        ))}
        {row.paths.length > 3 && (
          <span className="run-inspector__chip run-inspector__chip--more">
            +{row.paths.length - 3}
          </span>
        )}
      </div>
    )
  }

  return null
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-row visual metadata. Keeping this co-located with the component
// for now; extract if it grows or if other consumers want it.

function describeRow(row: InspectorRow): { glyph: string; label: string; summary: string } {
  switch (row.kind) {
    case 'approval_request': {
      // approval_request is overloaded — it covers permission prompts,
      // tool-call gates, diff approvals, and edit/write gates. Specialise
      // the glyph + label by `approvalKind` so the timeline reads
      // accurately even though the upstream event-kind doesn't change.
      const sub = row.approvalKind?.toLowerCase()
      let glyph = '⏸'
      let label = 'Approval'
      let summary = row.title
      if (sub === 'tool') {
        glyph = '🔧'
        label = 'Tool'
        // Tool name takes the primary slot when known; the surrounding
        // "Approve <Provider> tool call" prefix is redundant in this lane.
        summary = row.toolName ? row.toolName : row.title
      } else if (sub === 'edit' || sub === 'write') {
        glyph = '📝'
        label = sub === 'write' ? 'Write' : 'Edit'
        summary = row.title
      } else if (sub === 'diff') {
        glyph = '🪄'
        label = 'Diff'
        summary = row.title
      } else if (sub === 'permission') {
        glyph = '🔐'
        label = 'Permission'
        summary = row.title
      } else if (row.toolName) {
        // Unknown sub-kind but we have a tool name — surface it.
        summary = `${row.title} (${row.toolName})`
      }
      return { glyph, label, summary }
    }
    case 'approval_response':
      return {
        glyph:
          row.decision === 'accept' ||
          row.decision === 'acceptForSession' ||
          row.decision === 'acceptForWorkspace'
            ? '✓'
            : row.decision === 'decline'
              ? '✗'
              : '·',
        label: 'Decision',
        summary: humanDecision(row.decision)
      }
    case 'approval_timer':
      return {
        glyph: row.phase === 'timeout' ? '⏰' : '·',
        label: 'Approval timer',
        summary: row.phase === 'timeout' ? 'timer expired' : 'armed'
      }
    case 'tool_call':
      return {
        glyph: '🔧',
        label: 'Tool',
        summary: row.toolName ?? row.raw.summary ?? 'tool call'
      }
    case 'file_edit':
      return {
        glyph: '📝',
        label: 'Edit',
        summary: row.paths.join(', ')
      }
    case 'diff':
      return {
        glyph: '🪄',
        label: 'Diff',
        summary: row.paths?.join(', ') ?? row.raw.summary ?? 'diff'
      }
    case 'subthread_spawn':
      return {
        glyph: '↘',
        label: 'Sub-thread',
        summary:
          (row.provider ? `→ ${row.provider}` : 'delegated') +
          (row.delegationPrompt ? `: ${truncate(row.delegationPrompt, 80)}` : '')
      }
    case 'subthread_return':
      return {
        glyph: '↩',
        label: 'Returned',
        summary: row.summaryText ?? 'sub-thread completed'
      }
    case 'subthread_dispatch_failed':
      return {
        glyph: '⚠',
        label: 'Delegation failed',
        summary: row.reason ?? 'dispatch error'
      }
    case 'subthread_autoresume':
      return {
        glyph: '↻',
        label: 'Auto-resume',
        summary: row.raw.summary ?? 'parent agent continued after sub-thread completion'
      }
    case 'delegation':
      return { glyph: '↦', label: 'Delegation', summary: row.raw.summary ?? '' }
    case 'reply':
      return {
        glyph: '💬',
        label: 'Reply',
        summary:
          row.length !== undefined
            ? `${row.length.toLocaleString()} chars`
            : (row.raw.summary ?? '')
      }
    case 'lifecycle':
      return { glyph: '·', label: 'Lifecycle', summary: row.raw.summary ?? row.raw.phase }
    case 'timeline':
      return { glyph: '·', label: 'Timeline', summary: row.raw.summary ?? '' }
    case 'provider_raw':
      return { glyph: '·', label: 'Provider', summary: row.raw.summary ?? 'raw output' }
    case 'provider_error':
      return { glyph: '✗', label: 'Error', summary: row.message ?? '' }
    case 'provider_exit':
      return {
        glyph: '◼',
        label: 'Exit',
        summary: row.code !== null && row.code !== undefined ? `code ${row.code}` : 'no code'
      }
    case 'raw':
      return { glyph: '·', label: row.raw.kind, summary: row.raw.summary ?? '' }
  }
}

function humanDecision(d: string): string {
  switch (d) {
    case 'accept':
      return 'accepted'
    case 'acceptForSession':
      return 'accepted (session)'
    case 'acceptForWorkspace':
      return 'accepted (workspace)'
    case 'decline':
      return 'declined'
    case 'cancel':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function shortPath(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return iso
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remSeconds = Math.floor(seconds % 60)
  return `${minutes}m ${remSeconds}s`
}

// ──────────────────────────────────────────────────────────────────────────────

function Pill({
  kind,
  children
}: {
  kind: 'ok' | 'warn' | 'idle' | 'info'
  children: React.ReactNode
}): React.JSX.Element {
  return <span className={`run-inspector__pill run-inspector__pill--${kind}`}>{children}</span>
}
