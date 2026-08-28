import {
  Component,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject
} from 'react'
import { DiffViewer } from './DiffViewer'
import { PillButton } from './PillButton'
import { SegmentedControl } from './SegmentedControl'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import type {
  ChatRecord,
  DiffFileSummary,
  EnsembleParticipant,
  ProviderId
} from '../../../main/store/types'
import {
  LIVE_SELECTABLE_PROVIDER_IDS,
  RETIRED_PROVIDER_IDS
} from '../../../shared/retiredProviders'
import { getProviderLabel } from '../lib/providerLabels'
import { useCopyFeedback } from '../lib/useCopyFeedback'
import { rawLogEntryContent } from '../lib/rawLogEntry'
import { liveRunDiffStore } from '../lib/liveRunDiffStore'
import { InspectorPromptTab } from './InspectorPromptTab'
import { CommitsInspector } from './CommitsInspector'

type InspectorTab = 'diff' | 'commits' | 'raw' | 'prompt'
const providerLabel = getProviderLabel
interface InspectorProps {
  rightTab: InspectorTab
  activeDiff: any
  refreshDiff: (workspacePath?: string) => void
  currentWorkspace: any
  diffView: 'this_run' | 'workspace'
  setDiffView: (v: 'this_run' | 'workspace') => void
  runDiff: DiffFileSummary[] | null
  /**
   * 1.0.6-TV8 — per-WRITE-workspace file-change summaries for the run
   * being inspected (from `ChatRun.runDiffByPath`, TV7), keyed by
   * absolute path. When this holds entries the Diff Studio "this run"
   * view gains a Workspaces selector so each WRITE workspace is
   * reviewable independently; with zero/one entry the selector is hidden
   * and the tab renders exactly as before.
   */
  workspaceRunDiffByPath?: Record<string, DiffFileSummary[]>
  diffRefreshStatus: string
  rawLogs: Array<{
    type: 'stdout' | 'stderr' | 'tool' | 'info'
    content: string
    timestamp?: string
    sequence?: number
    hash?: string
    spanId?: string
    toolCallId?: string
    artifactCount?: number
  }>
  rawFilter: 'all' | 'stdout' | 'stderr' | 'tool'
  setRawFilter: (f: 'all' | 'stdout' | 'stderr' | 'tool') => void
  setRawLogs: (logs: any[]) => void
  rawLogsEndRef: RefObject<HTMLDivElement | null>
  workspacePath?: string
  provider: ProviderId
  /** Current chat — used by the Live Invocations tab to list active provider-native invocations. */
  currentChat?: ChatRecord | null
  /** Phase I3.3 — full chat list, used by the Invocation Timeline tab to
   * reconstruct the parent → sub-thread tree for the active chat. */
  chats?: ChatRecord[]
}

/** Inspector destinations remain available to the right-dock command palette;
 * the Home cards are now the visible navigation surface. */
export const INSPECTOR_TAB_META: { id: InspectorTab; label: string }[] = [
  { id: 'diff', label: 'Diff Studio' },
  { id: 'commits', label: 'Commits' },
  { id: 'raw', label: 'Raw Events' },
  { id: 'prompt', label: 'Prompt' }
]

/**
 * Per-tab error boundary (1.0.3 hotfix).
 *
 * Capabilities tab was crashing on Claude/Kimi sessions with a React
 * #31 ("Objects are not valid as a React child") that bubbled all the
 * way up to the transcript surface's top-level boundary — every click
 * on Capabilities took the whole chat down. This boundary catches the
 * render error at the tab level so other tabs (and the transcript)
 * stay healthy. Console-log of the original error stays in dev tools
 * so we can pin the root cause in a follow-up.
 *
 * `resetKey` lets the parent force a remount (e.g. when the user
 * switches to a different tab and back) by changing the key the
 * boundary sees. Without it the user would be stuck on the fallback
 * forever once a tab had failed.
 */
class InspectorTabErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { errored: boolean; message: string }
> {
  state = { errored: false, message: '' }
  static getDerivedStateFromError(err: unknown): { errored: true; message: string } {
    return {
      errored: true,
      message: err instanceof Error ? err.message : String(err ?? 'unknown error')
    }
  }
  componentDidCatch(err: unknown, info: unknown): void {
    console.error('[Inspector] tab render failed', err, info)
  }
  componentDidUpdate(prev: Readonly<{ resetKey: string }>): void {
    if (prev.resetKey !== this.props.resetKey && this.state.errored) {
      this.setState({ errored: false, message: '' })
    }
  }
  render(): ReactNode {
    if (this.state.errored) {
      return (
        <div className="safety-panel">
          <div className="safety-card">
            <h4>Tab failed to render</h4>
            <p
              style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--text-secondary)',
                margin: '0 0 var(--space-sm) 0'
              }}
            >
              This inspector tab hit an error and was contained so the chat surface stays usable.
              Other tabs are unaffected.
            </p>
            <p
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--danger)',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {this.state.message}
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export function Inspector(props: InspectorProps) {
  return (
    <div className="app-inspector">
      <div className="inspector-body">
        {/* Per-tab error boundary. resetKey=`{tab}` so switching tabs
            forces a fresh mount and clears any previous failure state. */}
        <InspectorTabErrorBoundary resetKey={props.rightTab}>
          {props.rightTab === 'diff' && <DiffTab {...props} />}
          {props.rightTab === 'commits' && (
            <CommitsInspector
              workspacePath={props.workspacePath}
              chatId={props.currentChat?.appChatId}
              chats={props.chats}
            />
          )}
          {props.rightTab === 'raw' && <RawTab {...props} />}
          {props.rightTab === 'prompt' && <InspectorPromptTab currentChat={props.currentChat} />}
        </InspectorTabErrorBoundary>
      </div>
    </div>
  )
}
function workspaceShortLabel(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const base = cleaned.split(/[\\/]/).pop()
  return base && base.length > 0 ? base : cleaned
}

function DiffTab(props: InspectorProps) {
  const liveRunDiff = useSyncExternalStore(
    (listener) => liveRunDiffStore.subscribe(props.currentChat?.appChatId, listener),
    () => liveRunDiffStore.getSnapshot(props.currentChat?.appChatId),
    () => null
  )
  const primaryRunDiff = props.runDiff ?? liveRunDiff
  // 1.0.6-TV8 — additional WRITE workspaces that recorded changes this
  // run. The selector + secondary-workspace rendering only engage when
  // there is at least one; otherwise the tab is byte-for-byte as before.
  const workspacePaths = Object.keys(props.workspaceRunDiffByPath || {})
  const hasWorkspaceDiffs = workspacePaths.length > 0
  // 'primary' = the existing run/workspace diff; any other value is an
  // absolute WRITE path keyed in `workspaceRunDiffByPath`.
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('primary')
  // Selection is only meaningful in the "this run" view; the Workspace
  // view always shows the primary workspace's live git diff.
  const showingSecondary =
    props.diffView === 'this_run' &&
    selectedWorkspace !== 'primary' &&
    Boolean(props.workspaceRunDiffByPath?.[selectedWorkspace])
  const effectiveDiff = showingSecondary
    ? { type: 'changes', summaries: props.workspaceRunDiffByPath![selectedWorkspace] }
    : props.diffView === 'this_run' && primaryRunDiff
      ? { type: 'changes', summaries: primaryRunDiff }
      : props.activeDiff
  const effectiveWorkspacePath = showingSecondary ? selectedWorkspace : props.workspacePath
  const [gitSnapshot, setGitSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [busyPath, setBusyPath] = useState('')
  const [actionStatus, setActionStatus] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!effectiveWorkspacePath) {
      setGitSnapshot(null)
      setActionStatus('')
      return () => {
        cancelled = true
      }
    }
    window.api
      .gitSnapshot({ workspacePath: effectiveWorkspacePath })
      .then((result) => {
        if (cancelled) return
        setGitSnapshot(result.ok ? result.data : null)
        if (result.ok) setActionStatus('')
        if (!result.ok) setActionStatus(result.error)
      })
      .catch((error) => {
        if (cancelled) return
        setGitSnapshot(null)
        setActionStatus(error instanceof Error ? error.message : 'Could not read git status')
      })
    return () => {
      cancelled = true
    }
  }, [effectiveWorkspacePath])

  const openDiffFileInEditor = async (path: string): Promise<void> => {
    if (!effectiveWorkspacePath) return
    setActionStatus(`Opening ${path}`)
    try {
      await window.api.openWorkspacePopout({
        kind: 'file-editor',
        workspacePath: effectiveWorkspacePath,
        targetPath: path,
        targetView: 'editor'
      })
      setActionStatus(`Opened ${path}`)
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : 'Could not open file editor')
    }
  }

  const stageDiffFile = async (path: string): Promise<void> => {
    if (!effectiveWorkspacePath) return
    setBusyPath(path)
    setActionStatus(`Staging ${path}`)
    try {
      const result = await window.api.gitStage({
        workspacePath: effectiveWorkspacePath,
        paths: [path]
      })
      if (result.ok) {
        setGitSnapshot(result.data)
        setActionStatus(`Staged ${path}`)
        props.refreshDiff(effectiveWorkspacePath)
      } else {
        setActionStatus(result.error)
      }
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : 'Could not stage file')
    } finally {
      setBusyPath('')
    }
  }

  const unstageDiffFile = async (path: string): Promise<void> => {
    if (!effectiveWorkspacePath) return
    setBusyPath(path)
    setActionStatus(`Unstaging ${path}`)
    try {
      const result = await window.api.gitUnstage({
        workspacePath: effectiveWorkspacePath,
        paths: [path]
      })
      if (result.ok) {
        setGitSnapshot(result.data)
        setActionStatus(`Unstaged ${path}`)
        props.refreshDiff(effectiveWorkspacePath)
      } else {
        setActionStatus(result.error)
      }
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : 'Could not unstage file')
    } finally {
      setBusyPath('')
    }
  }

  return (
    <div className="diff-studio">
      <div className="diff-studio-toolbar">
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <SegmentedControl
            ariaLabel="Diff view"
            value={props.diffView}
            options={[
              {
                value: 'this_run',
                label: 'This run',
                disabled: !primaryRunDiff && !hasWorkspaceDiffs
              },
              { value: 'workspace', label: 'Workspace' }
            ]}
            onValueChange={props.setDiffView}
            size="compact"
          />
          {props.diffView === 'this_run' && hasWorkspaceDiffs && (
            <select
              className="diff-workspace-select"
              aria-label="Workspace to review"
              value={selectedWorkspace}
              onChange={(e) => setSelectedWorkspace(e.target.value)}
              title="Review changes per WRITE workspace"
            >
              <option value="primary">Primary workspace</option>
              {workspacePaths.map((path) => (
                <option key={path} value={path} title={path}>
                  {workspaceShortLabel(path)}
                </option>
              ))}
            </select>
          )}
          {props.diffRefreshStatus && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--success)' }}>
              {props.diffRefreshStatus}
            </span>
          )}
          {actionStatus && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
              {actionStatus}
            </span>
          )}
        </div>
        <PillButton
          variant="ghost"
          size="compact"
          onClick={() => props.refreshDiff(effectiveWorkspacePath)}
          disabled={!props.currentWorkspace}
        >
          Refresh
        </PillButton>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <DiffViewer
          diff={effectiveDiff}
          workspacePath={effectiveWorkspacePath}
          gitSnapshot={gitSnapshot}
          busyPath={busyPath}
          onOpenFile={
            effectiveWorkspacePath ? (path) => void openDiffFileInEditor(path) : undefined
          }
          onStageFile={effectiveWorkspacePath ? (path) => void stageDiffFile(path) : undefined}
          onUnstageFile={effectiveWorkspacePath ? (path) => void unstageDiffFile(path) : undefined}
        />
      </div>
    </div>
  )
}

/**
 * Faithful clipboard serialisation of the raw-event buffer (1.4.1).
 *
 * The on-screen rows carry metadata (`#sequence`, content hash,
 * `tool:`/`span:` ids, artifact counts) that is exactly what you need
 * when debugging "undefined" raw output or events that don't present
 * cleanly in the transcript. The previous Copy dropped all of it, so a
 * pasted bug report lost the very fields that made it diagnosable. This
 * preserves the type tag + metadata per line and prepends a one-line
 * header with the type breakdown. Hashes are emitted in full (not the
 * 10-char on-screen preview) so they remain verifiable.
 */
/**
 * Single raw-event row serialised faithfully (type tag + full metadata +
 * content). Shared by the buffer-wide Copy and the per-row Copy
 * affordance so both paste identically.
 */
function formatRawEventLine(log: InspectorProps['rawLogs'][number]): string {
  const meta: string[] = []
  if (log.sequence) meta.push(`#${log.sequence}`)
  if (log.hash) meta.push(log.hash)
  if (log.toolCallId) meta.push(`tool:${log.toolCallId}`)
  else if (log.spanId) meta.push(`span:${log.spanId}`)
  if (log.artifactCount) meta.push(`artifacts:${log.artifactCount}`)
  const prefix = `[${log.type.toUpperCase()}]${meta.length ? ` ${meta.join(' ')}` : ''}`
  return `${prefix} ${rawLogEntryContent(log)}`
}

function formatRawEventsForClipboard(logs: InspectorProps['rawLogs']): string {
  if (logs.length === 0) return ''
  const counts = logs.reduce(
    (acc, log) => {
      acc[log.type] = (acc[log.type] || 0) + 1
      return acc
    },
    {} as Partial<Record<(typeof logs)[number]['type'], number>>
  )
  const header = `TaskWraith raw events — ${logs.length} total (${counts.stdout || 0} stdout · ${counts.stderr || 0} stderr · ${counts.tool || 0} tool · ${counts.info || 0} info)`
  const lines = logs.map((log) => formatRawEventLine(log))
  return `${header}\n${'-'.repeat(header.length)}\n${lines.join('\n')}\n`
}

export function scopeRawLogsToRound(
  logs: InspectorProps['rawLogs'],
  roundStartedAt: string | undefined,
  scope: 'round' | 'all'
): InspectorProps['rawLogs'] {
  if (scope === 'all' || !roundStartedAt) return logs
  return logs.filter((log) => Boolean(log.timestamp && log.timestamp >= roundStartedAt))
}

function RawTab(props: InspectorProps) {
  const { rawLogs, rawFilter, setRawFilter, setRawLogs, rawLogsEndRef } = props
  const { copiedId, copy } = useCopyFeedback()
  const ensembleParticipants = getOrderedEnsembleParticipants(props.currentChat)
  const isEnsemble = ensembleParticipants.length > 0
  const activeRound = props.currentChat?.ensemble?.activeRound
  const [roundScope, setRoundScope] = useState<'round' | 'all'>('round')
  useEffect(() => setRoundScope('round'), [activeRound?.roundId])
  const scopedLogs = scopeRawLogsToRound(rawLogs, activeRound?.startedAt, roundScope)
  const filteredLogs = scopedLogs.filter((l) => rawFilter === 'all' || l.type === rawFilter)
  const typeCounts = scopedLogs.reduce(
    (acc, log) => {
      acc[log.type] = (acc[log.type] || 0) + 1
      return acc
    },
    {} as Partial<Record<(typeof rawLogs)[number]['type'], number>>
  )
  return (
    <div className="diff-studio raw-events-panel">
      <div className="diff-studio-toolbar">
        <div style={{ display: 'flex', gap: '4px' }}>
          <SegmentedControl
            ariaLabel="Raw event filter"
            value={rawFilter}
            options={(['all', 'stdout', 'stderr', 'tool'] as const).map((filter) => ({
              value: filter,
              label: filter
            }))}
            onValueChange={setRawFilter}
            size="compact"
          />
        </div>
        {/* 1.4.1 — Copy/Clear pill, mirroring the transcript message
            actions chip. Copy serialises the WHOLE buffer (with the
            metadata the on-screen rows show) so a bug report pastes
            faithfully; Clear confirms before dropping the local buffer. */}
        <div className="raw-events-actions-chip" role="group" aria-label="Raw event actions">
          <button
            type="button"
            className={`message-actions-chip-button message-actions-chip-button--copy${
              copiedId === 'raw-events' ? ' is-copied' : ''
            }`}
            disabled={scopedLogs.length === 0}
            onClick={() => copy('raw-events', formatRawEventsForClipboard(scopedLogs))}
            title={
              copiedId === 'raw-events'
                ? 'Copied'
                : `Copy ${scopedLogs.length} visible raw event${scopedLogs.length === 1 ? '' : 's'} (with metadata) to clipboard`
            }
            aria-label={
              copiedId === 'raw-events'
                ? 'Copied raw events'
                : `Copy ${scopedLogs.length} visible raw events to clipboard`
            }
          >
            {copiedId === 'raw-events' ? (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M13.5 4.5 6 12 2.5 8.5" />
              </svg>
            ) : (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <rect x="5" y="5" width="9" height="9" rx="1.5" />
                <path d="M3 11V3.5C3 2.67 3.67 2 4.5 2H11" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="message-actions-chip-button message-actions-chip-button--delete"
            disabled={rawLogs.length === 0}
            onClick={() => {
              if (rawLogs.length === 0) return
              const ok = window.confirm(
                `Clear all ${rawLogs.length} raw event${rawLogs.length === 1 ? '' : 's'} from this inspector view? This only clears the local buffer, not the run history.`
              )
              if (ok) setRawLogs([])
            }}
            title="Clear the raw event buffer for this inspector"
            aria-label="Clear raw events"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 4h10" />
              <path d="M5.5 4V2.5C5.5 2.22 5.72 2 6 2h4c.28 0 .5.22.5.5V4" />
              <path d="M4.5 4l.5 9c.04.55.5 1 1 1h4c.5 0 .96-.45 1-1l.5-9" />
              <path d="M7 7v5" />
              <path d="M9 7v5" />
            </svg>
          </button>
        </div>
      </div>
      {isEnsemble && (
        <div
          className="safety-card"
          style={{
            margin: '0 var(--space-sm) var(--space-sm)',
            flex: '0 0 auto'
          }}
        >
          <h4>Ensemble raw event stream</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-sm) 0'
            }}
          >
            Defaults to the current round so an earlier participant failure cannot masquerade as a
            new-round event. “All rounds” restores the full chat-wide stdout, stderr, tool, and host
            info history.
          </p>
          {activeRound?.startedAt && (
            <div className="safety-row">
              <span>Scope</span>
              <SegmentedControl
                ariaLabel="Raw event round scope"
                value={roundScope}
                options={[
                  { value: 'round' as const, label: 'Current round' },
                  { value: 'all' as const, label: 'All rounds' }
                ]}
                onValueChange={setRoundScope}
                size="compact"
              />
            </div>
          )}
          <div className="safety-row">
            <span>Participants</span>
            <span>{formatParticipantProviderList(ensembleParticipants)}</span>
          </div>
          <div className="safety-row">
            <span>Events</span>
            <span>
              {scopedLogs.length} shown · {typeCounts.stdout || 0} stdout · {typeCounts.stderr || 0}{' '}
              stderr · {typeCounts.tool || 0} tool · {typeCounts.info || 0} info
            </span>
          </div>
        </div>
      )}
      <div className="raw-events-body">
        {filteredLogs.length === 0 ? (
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-muted)',
              padding: 'var(--space-md)',
              margin: 0
            }}
          >
            {scopedLogs.length === 0
              ? roundScope === 'round' && activeRound?.startedAt
                ? 'No raw events captured for the current round. Switch to “All rounds” for earlier events.'
                : 'No raw events captured yet. Run a task to stream stdout, stderr, and tool events here.'
              : `No ${rawFilter} events to show. Switch the filter to "all" to see other event types.`}
          </p>
        ) : (
          filteredLogs.map((log, i) => {
            // 1.4.1 — per-row Copy affordance for targeted troubleshooting.
            // Hover-revealed (CSS) so the stream stays clean; copies this
            // single event faithfully (same serialisation as the bulk Copy).
            const lineCopyId = `raw-line-${i}`
            return (
              <div
                key={i}
                className="raw-log-line"
                style={{
                  color:
                    log.type === 'stderr'
                      ? 'var(--danger)'
                      : log.type === 'tool'
                        ? 'var(--success)'
                        : log.type === 'info'
                          ? 'var(--accent)'
                          : 'var(--text-secondary)'
                }}
              >
                {(log.sequence ||
                  log.hash ||
                  log.spanId ||
                  log.toolCallId ||
                  log.artifactCount) && (
                  <span className="raw-log-meta">
                    {log.sequence ? `#${log.sequence}` : ''}
                    {log.hash ? ` ${log.hash.slice(0, 10)}` : ''}
                    {log.toolCallId
                      ? ` tool:${log.toolCallId}`
                      : log.spanId
                        ? ` span:${log.spanId}`
                        : ''}
                    {log.artifactCount ? ` artifacts:${log.artifactCount}` : ''}
                  </span>
                )}
                {rawLogEntryContent(log)}
                <button
                  type="button"
                  className={`message-actions-chip-button message-actions-chip-button--copy raw-log-line-copy${
                    copiedId === lineCopyId ? ' is-copied' : ''
                  }`}
                  onClick={() => copy(lineCopyId, formatRawEventLine(log))}
                  title={copiedId === lineCopyId ? 'Copied' : 'Copy this event (with metadata)'}
                  aria-label={copiedId === lineCopyId ? 'Copied event' : 'Copy this raw event'}
                >
                  {copiedId === lineCopyId ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M13.5 4.5 6 12 2.5 8.5" />
                    </svg>
                  ) : (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <rect x="5" y="5" width="9" height="9" rx="1.5" />
                      <path d="M3 11V3.5C3 2.67 3.67 2 4.5 2H11" />
                    </svg>
                  )}
                </button>
              </div>
            )
          })
        )}
        <div ref={rawLogsEndRef} />
      </div>
    </div>
  )
}
function safeText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (Array.isArray(value)) return value.map((item) => safeText(item, '')).join(', ')
  try {
    return JSON.stringify(value)
  } catch {
    return '[unrenderable]'
  }
}

function getOrderedEnsembleParticipants(chat?: ChatRecord | null): EnsembleParticipant[] {
  if (chat?.chatKind !== 'ensemble' || !chat.ensemble) return []
  return [...(chat.ensemble.participants || [])].sort((a, b) => a.order - b.order)
}
function formatParticipantProviderList(participants: EnsembleParticipant[]): string {
  const enabled = participants.filter((participant) => participant.enabled)
  if (enabled.length === 0) return 'none enabled'
  return enabled
    .map(
      (participant) =>
        `${safeText(participant.role, 'Participant')} / ${providerLabel(participant.provider)}`
    )
    .join(', ')
}

// Provider ids the delegation audit can attribute raw logs to: the canonical
// live set plus retired ids (historical Gemini logs must keep attributing).
// Derived from the shared registry so a newly admitted provider is counted
// without another edit here.
const INFERRABLE_PROVIDER_IDS: ReadonlySet<string> = new Set<string>([
  ...LIVE_SELECTABLE_PROVIDER_IDS,
  ...RETIRED_PROVIDER_IDS,
  // Dynamically-admitted providers (not in the static live set) whose raw
  // logs must still attribute correctly.
  'antigravity'
])

const RAW_LOG_PROVIDER_PATTERN = new RegExp(
  `\\b(provider|ensembleProvider|parentProvider|targetProvider)\\s*[:=]\\s*["']?(${Array.from(
    INFERRABLE_PROVIDER_IDS
  ).join('|')})\\b`,
  'i'
)

export function inferProviderFromRawLogContent(content: string): ProviderId | null {
  const parsed = parseJsonLike(content)
  if (parsed) {
    const found = findProviderInValue(parsed)
    if (found) return found
  }
  const textMatch = content.match(RAW_LOG_PROVIDER_PATTERN)
  if (textMatch) return textMatch[2].toLowerCase() as ProviderId
  return null
}

function parseJsonLike(content: string): unknown | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function findProviderInValue(value: unknown, depth = 0): ProviderId | null {
  if (depth > 4 || value === null || value === undefined) return null
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    return INFERRABLE_PROVIDER_IDS.has(normalized) ? (normalized as ProviderId) : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProviderInValue(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const preferredKeys = [
    'ensembleProvider',
    'provider',
    'providerId',
    'parentProvider',
    'targetProvider',
    'modelProvider'
  ]
  for (const key of preferredKeys) {
    const found = findProviderInValue(record[key], depth + 1)
    if (found) return found
  }
  for (const nestedKey of ['metadata', 'payload', 'params', 'item', 'run', 'ensembleRun']) {
    const found = findProviderInValue(record[nestedKey], depth + 1)
    if (found) return found
  }
  return null
}
