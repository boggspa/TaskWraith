import {
  Component,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { DiffViewer } from './DiffViewer'
import { TerminalPanel } from './TerminalPanel'
import { BackgroundTasksPanel } from './BackgroundTasksPanel'
import { ReadOnlyToolClassBreakdown } from './ToolClassBreakdown'
import { PillButton } from './PillButton'
import { SegmentedControl } from './SegmentedControl'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import type {
  ChatRecord,
  DiffFileSummary,
  EnsembleParticipant,
  ProviderId,
  ExternalPathGrant,
  GeminiMcpBridgeStatus,
  ProviderCapabilityContract,
  ProviderToolingCapability
} from '../../../main/store/types'
import {
  extractDelegationAuditItems,
  providerDelegationChips,
  summarizeDelegationActivity
} from '../lib/DelegationAudit'
import { buildDelegationTree, type DelegationTimelineNode } from '../lib/DelegationTree'
import { useCopyFeedback } from '../lib/useCopyFeedback'

type InspectorTab =
  | 'diff'
  | 'raw'
  | 'delegation'
  | 'timeline'
  | 'safety'
  | 'capabilities'
  | 'background-tasks'
type CapabilityKind = 'mcp' | 'extensions' | 'skills' | 'agents'
type CapabilityFormat = 'json' | 'raw' | 'error'

interface GeminiCapabilityItem {
  id: string
  name: string
  status?: string
  detail?: string
  raw: string
}

interface GeminiCapabilitySection {
  kind: CapabilityKind
  command: string[]
  format: CapabilityFormat
  items: GeminiCapabilityItem[]
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
  error?: string
  parsingError?: string
  truncated?: boolean
}

interface GeminiCapabilitiesState {
  refreshedAt: string
  workspace?: string
  sections: Record<CapabilityKind, GeminiCapabilitySection>
}

const CAPABILITY_ORDER: CapabilityKind[] = ['mcp', 'extensions', 'skills', 'agents']
const CAPABILITY_LABELS: Record<CapabilityKind, string> = {
  mcp: 'MCP servers',
  extensions: 'Extensions',
  skills: 'Skills',
  agents: 'Agents'
}

function providerLabel(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  return 'Gemini'
}

interface InspectorProps {
  rightTab: InspectorTab
  activeDiff: any
  refreshDiff: () => void
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
  geminiVersion: string
  isOldVersion: boolean
  trustResult: any
  sessionTrust: boolean
  setSessionTrust: (v: boolean) => void
  showTerminal: boolean
  setShowTerminal: (v: boolean) => void
  workspacePath?: string
  provider: ProviderId
  approvalMode: string
  codexStatus?: any
  codexModels?: Array<{
    id: string
    label?: string
    defaultReasoningEffort?: string | null
    additionalSpeedTiers?: string[]
    supportedReasoningEfforts?: Array<{ reasoningEffort: string }>
  }>
  codexMcpStatus?: any
  providerCapabilities?: ProviderCapabilityContract | null
  providerCapabilitiesByProvider?: Partial<Record<ProviderId, ProviderCapabilityContract | null>>
  codexThreads?: any[]
  externalPathGrants?: ExternalPathGrant[]
  geminiMcpBridgeEnabled?: boolean
  geminiMcpBridgeStatus?: GeminiMcpBridgeStatus | null
  onRefreshCodexThreads?: () => void
  onResumeCodexThread?: (threadId: string) => void
  onForkCodexThread?: (threadId: string) => void
  onForkAgentThread?: (provider: ProviderId, threadId?: string) => void
  onRollbackCodexThread?: (threadId: string) => void
  onImportCodexUsageCredential?: () => void
  onClearCodexUsageCredential?: () => void
  onInstallGeminiMcpBridge?: () => void
  onRefreshGeminiMcpBridgeStatus?: () => void
  /** Current chat — used by the Live Invocations tab to list active provider-native invocations. */
  currentChat?: ChatRecord | null
  /** Phase I3.3 — full chat list, used by the Invocation Timeline tab to
   * reconstruct the parent → sub-thread tree for the active chat. */
  chats?: ChatRecord[]
  /** Phase I3.3 — chat ids that currently have an active run, so the
   * timeline can label nodes as "running" vs "completed". */
  runningChatIds?: string[]
  /** Phase I3.3 — navigate to a specific chat when the user clicks a
   * timeline node. */
  onOpenSubThread?: (chatId: string) => void
}

/** Inspector destinations remain available to the right-dock command palette;
 * the Home cards are now the visible navigation surface. */
export const INSPECTOR_TAB_META: { id: InspectorTab; label: string }[] = [
  { id: 'diff', label: 'Diff Studio' },
  { id: 'raw', label: 'Raw Events' },
  { id: 'delegation', label: 'Invocations' },
  { id: 'timeline', label: 'Invocation Timeline' },
  { id: 'safety', label: 'Safety' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'background-tasks', label: 'Live Invocations' }
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
          {props.rightTab === 'raw' && <RawTab {...props} />}
          {props.rightTab === 'delegation' && <DelegationTab {...props} />}
          {props.rightTab === 'timeline' && <DelegationTimelineTab {...props} />}
          {props.rightTab === 'safety' && <SafetyTab {...props} />}
          {props.rightTab === 'capabilities' && <CapabilitiesTab {...props} />}
          {props.rightTab === 'background-tasks' && (
            <BackgroundTasksPanel chat={props.currentChat || undefined} provider={props.provider} />
          )}
        </InspectorTabErrorBoundary>
      </div>
    </div>
  )
}

function useGeminiCapabilities(workspacePath?: string) {
  const [capabilities, setCapabilities] = useState<GeminiCapabilitiesState | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshCapabilities = () => {
    if (!workspacePath) {
      setCapabilities(null)
      setError(null)
      return
    }

    setIsLoading(true)
    setError(null)
    window.api
      .getGeminiCapabilities(workspacePath)
      .then((nextCapabilities) => {
        setCapabilities(nextCapabilities)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setIsLoading(false)
      })
  }

  useEffect(() => {
    if (!workspacePath) {
      let cancelled = false
      queueMicrotask(() => {
        if (cancelled) return
        setCapabilities(null)
        setError(null)
      })
      return () => {
        cancelled = true
      }
    }

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setIsLoading(true)
      setError(null)
      window.api
        .getGeminiCapabilities(workspacePath)
        .then((nextCapabilities) => {
          if (!cancelled) setCapabilities(nextCapabilities)
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false)
        })
    })

    return () => {
      cancelled = true
    }
  }, [workspacePath])
  return { capabilities, isLoading, error, refreshCapabilities }
}

/** Short label for a workspace path (basename), for the TV8 selector. */
function workspaceShortLabel(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const base = cleaned.split(/[\\/]/).pop()
  return base && base.length > 0 ? base : cleaned
}

function DiffTab(props: InspectorProps) {
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
        props.refreshDiff()
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
        props.refreshDiff()
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
                disabled: !props.runDiff && !hasWorkspaceDiffs
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
          onClick={props.refreshDiff}
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
          onUnstageFile={
            effectiveWorkspacePath ? (path) => void unstageDiffFile(path) : undefined
          }
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
  return `${prefix} ${log.content}`
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

function RawTab(props: InspectorProps) {
  const { rawLogs, rawFilter, setRawFilter, setRawLogs, rawLogsEndRef } = props
  const { copiedId, copy } = useCopyFeedback()
  const ensembleParticipants = getOrderedEnsembleParticipants(props.currentChat)
  const isEnsemble = ensembleParticipants.length > 0
  const filteredLogs = rawLogs.filter((l) => rawFilter === 'all' || l.type === rawFilter)
  const typeCounts = rawLogs.reduce(
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
            disabled={rawLogs.length === 0}
            onClick={() => copy('raw-events', formatRawEventsForClipboard(rawLogs))}
            title={
              copiedId === 'raw-events'
                ? 'Copied'
                : `Copy all ${rawLogs.length} raw event${rawLogs.length === 1 ? '' : 's'} (with metadata) to clipboard`
            }
            aria-label={
              copiedId === 'raw-events'
                ? 'Copied raw events'
                : `Copy all ${rawLogs.length} raw events to clipboard`
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
            Combined event buffer for this Ensemble chat. Participant runs stay tagged in chat/run
            metadata, while this tab keeps the raw stdout, stderr, tool, and host info stream in one
            chronological view.
          </p>
          <div className="safety-row">
            <span>Participants</span>
            <span>{formatParticipantProviderList(ensembleParticipants)}</span>
          </div>
          <div className="safety-row">
            <span>Events</span>
            <span>
              {rawLogs.length} total · {typeCounts.stdout || 0} stdout · {typeCounts.stderr || 0}{' '}
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
            {rawLogs.length === 0
              ? 'No raw events captured yet. Run a task to stream stdout, stderr, and tool events here.'
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
                {log.content}
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

function DelegationTab(props: InspectorProps) {
  const ensembleParticipants = getOrderedEnsembleParticipants(props.currentChat)
  const isEnsemble = ensembleParticipants.length > 0
  const providers = isEnsemble ? uniqueProviders(ensembleParticipants) : [props.provider]
  const activities = isEnsemble
    ? extractEnsembleDelegationAuditItems(props, providers)
    : extractDelegationAuditItems(props.rawLogs, props.provider, props.providerCapabilities)
  const chips = isEnsemble
    ? Array.from(
        new Set(
          providers.flatMap((provider) =>
            providerDelegationChips(provider, contractForProvider(props, provider))
          )
        )
      )
    : providerDelegationChips(props.provider, props.providerCapabilities)
  const openFloatingAudit = () => {
    const auditWindow = window.open('', 'taskwraith-agent-audit', 'width=560,height=760')
    if (!auditWindow) return
    const rows = activities.length
      ? activities
          .map(
            (activity) =>
              `<li><strong>${escapeHtml(activity.name)}</strong><br/><span>${escapeHtml(summarizeDelegationActivity(activity))}</span></li>`
          )
          .join('')
      : '<li>No delegated agent activity detected yet.</li>'
    auditWindow.document.write(`<!doctype html><html><head><title>TaskWraith Agent Audit</title><style>
      body{margin:0;padding:20px;background:#111;color:#eee;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      h1{font-size:18px;margin:0 0 12px}
      .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
      .chip{border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:4px 8px;color:#b8d7ff;background:rgba(255,255,255,.06)}
      li{margin:0 0 14px;padding:12px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.05)}
      span{color:#bbb;line-height:1.45}
    </style></head><body><h1>${isEnsemble ? 'TaskWraith Ensemble Agent Audit' : 'TaskWraith Agent Audit'}</h1><div class="chips">${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div><ol>${rows}</ol></body></html>`)
    auditWindow.document.close()
  }

  return (
    <div className="safety-panel">
      <div className="diff-studio-toolbar">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
            {isEnsemble ? 'Ensemble agent invocation audit' : 'Agent invocation audit'}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
            {activities.length} agent invocation {activities.length === 1 ? 'event' : 'events'}{' '}
            detected from raw/tool events
          </div>
        </div>
        <PillButton variant="ghost" size="compact" onClick={openFloatingAudit}>
          Floating audit
        </PillButton>
      </div>

      <div className="safety-card">
        <h4>
          {isEnsemble
            ? 'Ensemble agent invocation model'
            : `${providerLabel(props.provider)} agent invocation model`}
        </h4>
        {isEnsemble && (
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-sm) 0'
            }}
          >
            Agent invocation activity is audited across the enabled participant providers. Native
            provider events remain provider-owned; TaskWraith displays them beside durable sub-thread
            activity in one inspector language.
          </p>
        )}
        {isEnsemble && (
          <div className="safety-row">
            <span>Participants</span>
            <span>{formatParticipantProviderList(ensembleParticipants)}</span>
          </div>
        )}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-xs)',
            marginTop: 'var(--space-sm)'
          }}
        >
          {chips.map((chip) => (
            <span
              key={chip}
              style={{
                fontSize: 'var(--font-size-xs)',
                color: chip.includes('TaskWraith') ? 'var(--success)' : 'var(--text-secondary)',
                border: '1px solid var(--panel-border)',
                borderRadius: 999,
                padding: '3px 8px',
                background: 'rgba(255,255,255,0.04)'
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      </div>

      {activities.length === 0 ? (
        <div className="safety-card">
          <h4>No agent invocations yet</h4>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}>
            {isEnsemble
              ? 'Ask any Ensemble participant to spawn or delegate an agent invocation. TaskWraith will render native provider events here when they appear in the stream.'
              : `Ask ${providerLabel(props.provider)} to spawn or delegate an agent invocation. TaskWraith will render native provider events here when they appear in the stream.`}
          </p>
        </div>
      ) : (
        activities.map((activity) => (
          <div key={activity.activityId} className="safety-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 'var(--space-sm)',
                alignItems: 'flex-start'
              }}
            >
              <h4 style={{ marginBottom: 0 }}>{activity.name}</h4>
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color:
                    activity.status === 'failed'
                      ? 'var(--danger)'
                      : activity.status === 'success'
                        ? 'var(--success)'
                        : 'var(--warning)',
                  whiteSpace: 'nowrap'
                }}
              >
                {activity.status}
              </span>
            </div>
            <div className="safety-row">
              <span>Kind</span>
              <span>{activity.kind}</span>
            </div>
            <div className="safety-row">
              <span>Provider</span>
              <span>{providerLabel(activity.provider || props.provider)}</span>
            </div>
            {activity.model && (
              <div className="safety-row">
                <span>Model</span>
                <span>{activity.model}</span>
              </div>
            )}
            {activity.providerAgentId && (
              <div className="safety-row">
                <span>Agent id</span>
                <span>{activity.providerAgentId}</span>
              </div>
            )}
            {activity.parentToolCallId && (
              <div className="safety-row">
                <span>Parent tool</span>
                <span>{activity.parentToolCallId}</span>
              </div>
            )}
            {activity.toolPolicy && (
              <div className="safety-row">
                <span>Tool policy</span>
                <span>{activity.toolPolicy}</span>
              </div>
            )}
            {activity.mcpPolicy && (
              <div className="safety-row">
                <span>MCP policy</span>
                <span>{activity.mcpPolicy}</span>
              </div>
            )}
            {(activity.promptPreview || activity.summary) && (
              <p
                style={{
                  fontSize: 'var(--font-size-sm)',
                  color: 'var(--text-secondary)',
                  margin: 'var(--space-sm) 0 0 0',
                  lineHeight: 1.45
                }}
              >
                {activity.summary || activity.promptPreview}
              </p>
            )}
            {(activity.rawEventRefs || []).length > 0 && (
              <div
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--text-tertiary)',
                  marginTop: 'var(--space-sm)'
                }}
              >
                Raw refs{' '}
                {(activity.rawEventRefs || [])
                  .slice(0, 3)
                  .map((ref) =>
                    ref.sequence ? `#${ref.sequence}` : ref.toolCallId || ref.spanId || 'event'
                  )
                  .join(', ')}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

function timelineNodeStatus(
  node: DelegationTimelineNode,
  runningChatIds: Set<string>
): { label: string; tone: 'running' | 'completed' | 'failed' | 'cancelled' | 'idle' } {
  if (runningChatIds.has(node.chat.appChatId)) return { label: 'running', tone: 'running' }
  const lastRun = node.chat.runs?.[node.chat.runs.length - 1]
  if (!lastRun) return { label: 'idle', tone: 'idle' }
  if (lastRun.status === 'success' || lastRun.status === 'success_with_warnings') {
    return { label: 'completed', tone: 'completed' }
  }
  if (lastRun.status === 'failed') return { label: 'failed', tone: 'failed' }
  if (lastRun.status === 'cancelled') return { label: 'cancelled', tone: 'cancelled' }
  if (!lastRun.endedAt) return { label: 'running', tone: 'running' }
  return { label: lastRun.status || 'idle', tone: 'idle' }
}

function formatTimelineElapsed(epochMs?: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return ''
  const elapsed = Math.max(0, Date.now() - epochMs)
  if (elapsed < 60_000) return `started ${Math.floor(elapsed / 1000)}s ago`
  if (elapsed < 3_600_000) return `started ${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `started ${Math.floor(elapsed / 3_600_000)}h ago`
  return new Date(epochMs).toLocaleString()
}

function DelegationTimelineTreeNode({
  node,
  depth,
  runningChatIds,
  onOpenSubThread
}: {
  node: DelegationTimelineNode
  depth: number
  runningChatIds: Set<string>
  onOpenSubThread?: (chatId: string) => void
}) {
  const status = timelineNodeStatus(node, runningChatIds)
  const provider = node.chat.provider || 'gemini'
  const isClickable = Boolean(onOpenSubThread)
  // Deterministic per-sub-thread identity (seeded by the sub-thread chat id —
  // the same seed the Agent-Invocation + result cards use) so the character
  // is identical across every delegation surface.
  const agentIdentity = assignAgentIdentityFromSeed(node.chat.appChatId)
  const lastRun = node.chat.runs?.[node.chat.runs.length - 1]
  const elapsed = formatTimelineElapsed(
    lastRun?.startedAt ? Date.parse(lastRun.startedAt) : node.chat.createdAt
  )
  const resultReturned = Boolean(node.chat.delegationContext?.resultReturnedAt)
  const lastAssistant = resultReturned
    ? [...node.chat.messages].reverse().find((m) => m.role === 'assistant')
    : undefined
  const resultPreview = lastAssistant?.content ? lastAssistant.content.slice(0, 120) : undefined

  return (
    <div
      className="delegation-timeline-node"
      style={
        {
          paddingLeft: depth === 0 ? 0 : `${depth * 18}px`,
          ['--agent-rim']: agentIdentity.accent
        } as CSSProperties
      }
    >
      <button
        type="button"
        className={`delegation-timeline-row provider-${provider} status-${status.tone} ${node.isCurrent ? 'is-current' : ''}`}
        onClick={isClickable ? () => onOpenSubThread?.(node.chat.appChatId) : undefined}
        disabled={!isClickable}
        title={node.chat.title}
      >
        <AgentIdentityIcon
          name={agentIdentity.key}
          color={agentIdentity.accent}
          size={36}
          className="delegation-timeline-identicon"
          title={agentIdentity.name}
        />
        <span className="delegation-timeline-label">
          <strong>{providerLabel(provider)}</strong>
          <span className="delegation-timeline-agent-name">{agentIdentity.name}</span>
          <span className="delegation-timeline-title">{node.chat.title}</span>
        </span>
        <span className="delegation-timeline-meta">
          <span>{elapsed}</span>
          <span className={`delegation-timeline-status status-${status.tone}`}>{status.label}</span>
        </span>
      </button>
      {resultReturned && resultPreview && (
        <div
          className="delegation-timeline-result"
          style={{ paddingLeft: `${(depth + 1) * 18}px` }}
        >
          <span aria-hidden="true">↩</span>
          <span>Result back-propagated · {resultPreview.length} chars preview</span>
        </div>
      )}
      {status.tone === 'running' && node.children.length === 0 && (
        <div className="delegation-timeline-empty" style={{ paddingLeft: `${(depth + 1) * 18}px` }}>
          [waiting for completion]
        </div>
      )}
      {node.children.map((child) => (
        <DelegationTimelineTreeNode
          key={child.chat.appChatId}
          node={child}
          depth={depth + 1}
          runningChatIds={runningChatIds}
          onOpenSubThread={onOpenSubThread}
        />
      ))}
    </div>
  )
}

function DelegationTimelineTab(props: InspectorProps) {
  const chats = props.chats ?? []
  const runningChatIds = new Set(props.runningChatIds ?? [])
  const tree = buildDelegationTree(chats, props.currentChat?.appChatId)

  if (!tree) {
    return (
      <div className="safety-panel">
        <div className="safety-card">
          <h4>No active chat selected</h4>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}>
            Open a chat to see its delegation tree.
          </p>
        </div>
      </div>
    )
  }

  const totalNodes = countTreeNodes(tree)
  const liveNodes = countLiveTreeNodes(tree, runningChatIds)

  return (
    <div className="safety-panel">
      <div className="diff-studio-toolbar">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
            Delegation timeline
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
            {totalNodes} chat{totalNodes === 1 ? '' : 's'} in this tree · {liveNodes} running
          </div>
        </div>
      </div>
      <div className="delegation-timeline-tree">
        <DelegationTimelineTreeNode
          node={tree}
          depth={0}
          runningChatIds={runningChatIds}
          onOpenSubThread={props.onOpenSubThread}
        />
      </div>
    </div>
  )
}

function countTreeNodes(node: DelegationTimelineNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countTreeNodes(child), 0)
}

function countLiveTreeNodes(node: DelegationTimelineNode, running: Set<string>): number {
  const self = running.has(node.chat.appChatId) ? 1 : 0
  return self + node.children.reduce((sum, child) => sum + countLiveTreeNodes(child, running), 0)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatCapabilityTime(value?: string): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function commandStatusLabel(section: GeminiCapabilitySection): string {
  if (section.timedOut) return 'Timed out'
  if (section.error) return 'Error'
  if (section.status === 0) return 'OK'
  if (section.status === null) return 'Unknown'
  return `Exit ${section.status}`
}

function commandStatusColor(section: GeminiCapabilitySection): string {
  if (section.status === 0 && !section.error && !section.timedOut) return 'var(--success)'
  if (section.timedOut || section.error || (section.status !== null && section.status !== 0))
    return 'var(--danger)'
  return 'var(--text-secondary)'
}

function capabilityStatusColor(status?: string): string {
  const normalized = status?.toLowerCase() || ''
  if (/(enabled|active|running|connected|ok|installed|trusted|loaded)/.test(normalized))
    return 'var(--success)'
  if (/(disabled|inactive|disconnected|unavailable)/.test(normalized)) return 'var(--warning)'
  if (/(error|failed|untrusted)/.test(normalized)) return 'var(--danger)'
  return 'var(--text-secondary)'
}

function truncateRawOutput(value: string, maxLength: number = 1800): string {
  if (!value.trim()) return ''
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n[preview truncated]`
}

function toolingStateColor(state: ProviderToolingCapability['state']): string {
  if (state === 'available') return 'var(--success)'
  if (state === 'gated' || state === 'delegated') return 'var(--warning)'
  if (state === 'blocked' || state === 'unavailable') return 'var(--danger)'
  return 'var(--text-secondary)'
}

function toolingEnforcementLabel(tool: ProviderToolingCapability): string {
  if (tool.enforcedByTaskWraith) return 'TaskWraith-enforced'
  if (tool.enforcement === 'provider') return 'provider-managed'
  if (tool.enforcement === 'best_effort') return 'best-effort'
  if (tool.enforcement === 'none') return 'not enforced'
  return tool.source === 'provider' ? 'provider-managed' : 'not enforced'
}

function toolingEnforcementColor(tool: ProviderToolingCapability): string {
  if (tool.enforcedByTaskWraith) return 'var(--success)'
  if (tool.enforcement === 'best_effort') return 'var(--warning)'
  return 'var(--text-secondary)'
}

function ToolingContractCard({ contract }: { contract?: ProviderCapabilityContract | null }) {
  if (!contract) {
    return (
      <div className="safety-card">
        <h4>Tooling contract</h4>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}>
          Provider capability state has not been loaded yet.
        </p>
      </div>
    )
  }

  // The five functional-control rows drive the TaskWraith-enforcement tally. The
  // elicit/delegate rows are DISPLAY-only additions: they render in the strip
  // but are deliberately excluded from `enforcedCount` so promoting
  // subThreadDelegation to a row does not double-count against its existing
  // settings gate or change the "X/5 controls" number.
  const controlTools = [
    contract.tools.shellCommands,
    contract.tools.fileChanges,
    contract.tools.mcpTools,
    contract.tools.creativeApps,
    contract.tools.networkAccess
  ]
  const displayTools = [...controlTools, contract.tools.elicit, contract.tools.delegate]
  const enforcedCount = controlTools.filter((tool) => tool.enforcedByTaskWraith).length
  return (
    <div className="safety-card">
      <h4>{safeText(contract.label, 'Provider')} tooling contract</h4>
      <p
        style={{
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-secondary)',
          margin: '0 0 var(--space-md) 0'
        }}
      >
        Shared TaskWraith view of shell, file, MCP, creative app, approval, and unavailable-tool
        behavior for this provider.
      </p>
      <div className="safety-row">
        <span>Availability</span>
        <span
          style={{ color: contract.availability.available ? 'var(--success)' : 'var(--danger)' }}
        >
          {contract.availability.available ? 'available' : 'unavailable'}
        </span>
      </div>
      <div className="safety-row">
        <span>Version</span>
        <span>{safeText(contract.availability.version, 'unknown')}</span>
      </div>
      <div className="safety-row">
        <span>Approval mode</span>
        <span>{safeText(contract.approvals.providerMode)}</span>
      </div>
      <div className="safety-row">
        <span>In-app approvals</span>
        <span>{contract.approvals.inAppApprovals ? 'yes' : 'provider-managed'}</span>
      </div>
      <div className="safety-row">
        <span>TaskWraith enforcement</span>
        <span style={{ color: enforcedCount > 0 ? 'var(--success)' : 'var(--warning)' }}>
          {enforcedCount}/{controlTools.length} controls
        </span>
      </div>
      <div className="safety-row">
        <span>MCP</span>
        <span style={{ color: toolingStateColor(contract.mcp.state) }}>
          {safeText(contract.mcp.state)}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-sm)',
          marginTop: 'var(--space-md)'
        }}
      >
        {displayTools.map((tool, idx) => (
          <div
            key={safeText(tool.id) || `tool-${idx}`}
            style={{ borderTop: '1px solid var(--panel-border)', paddingTop: 'var(--space-sm)' }}
          >
            <div
              style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-sm)' }}
            >
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)' }}>
                {safeText(tool.label)}
              </span>
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: toolingStateColor(tool.state),
                  whiteSpace: 'nowrap'
                }}
              >
                {safeText(tool.state)}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 'var(--space-sm)',
                marginTop: 2
              }}
            >
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
                Enforcement
              </span>
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: toolingEnforcementColor(tool),
                  whiteSpace: 'nowrap'
                }}
              >
                {safeText(toolingEnforcementLabel(tool))}
              </span>
            </div>
            <div
              style={{
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-tertiary)',
                marginTop: 2
              }}
            >
              {safeText(tool.details) ||
                `${safeText(tool.source)}${tool.policy ? ` · ${safeText(tool.policy)}` : ''}`}
            </div>
            {tool.tools.length > 0 && (
              <div
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--text-secondary)',
                  marginTop: 2,
                  fontFamily: 'var(--font-mono)'
                }}
              >
                {safeText(tool.tools)}
              </div>
            )}
          </div>
        ))}
      </div>
      {contract.warnings.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-xs)',
            marginTop: 'var(--space-md)'
          }}
        >
          {contract.warnings.slice(0, 4).map((item, idx) => (
            <div
              key={safeText(item.id) || `warning-${idx}`}
              style={{
                fontSize: 'var(--font-size-xs)',
                color:
                  item.severity === 'error'
                    ? 'var(--danger)'
                    : item.severity === 'warning'
                      ? 'var(--warning)'
                      : 'var(--text-secondary)'
              }}
            >
              <strong>{safeText(item.title)}</strong>: {safeText(item.message)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Coerce any value to a safe React-renderable string. Defensive net
 * for the 1.0.3 Capabilities tab crash where one of the data fields
 * threaded through as `props.codexStatus.*` / `props.codexModels[].*`
 * / `props.codexMcpStatus.data[].*` was an object instead of the
 * typed string, causing React #31 ("Objects are not valid as a React
 * child") to take down the inspector. Applied at every text-render
 * site in CapabilitiesTab + ToolingContractCard so the surface
 * stays readable while we track the actual source down via the
 * console.dir log below.
 *
 * Primitives pass through unchanged; objects become `[object]`
 * (matches dev-tools rendering convention); null/undefined become
 * empty string (so React's "false-y skip" semantics still work).
 */
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

function uniqueProviders(participants: EnsembleParticipant[]): ProviderId[] {
  return Array.from(
    new Set(participants.filter((participant) => participant.enabled).map((p) => p.provider))
  ) as ProviderId[]
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

function inferProviderFromRawLogContent(content: string): ProviderId | null {
  const parsed = parseJsonLike(content)
  if (parsed) {
    const found = findProviderInValue(parsed)
    if (found) return found
  }
  const textMatch = content.match(
    /\b(provider|ensembleProvider|parentProvider|targetProvider)\s*[:=]\s*["']?(gemini|codex|claude|kimi)\b/i
  )
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
    return normalized === 'gemini' ||
      normalized === 'codex' ||
      normalized === 'claude' ||
      normalized === 'kimi'
      ? (normalized as ProviderId)
      : null
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

function extractEnsembleDelegationAuditItems(props: InspectorProps, providers: ProviderId[]) {
  const inferredProviderCount = props.rawLogs.filter((log) =>
    inferProviderFromRawLogContent(log.content)
  ).length
  const activities = providers.flatMap((provider) => {
    const providerLogs =
      inferredProviderCount > 0
        ? props.rawLogs.filter((log) => inferProviderFromRawLogContent(log.content) === provider)
        : provider === props.provider
          ? props.rawLogs
          : []
    return extractDelegationAuditItems(providerLogs, provider, contractForProvider(props, provider))
  })
  const byKey = new Map<string, (typeof activities)[number]>()
  for (const activity of activities) {
    byKey.set(activity.activityId, activity)
  }
  return Array.from(byKey.values())
}

function permissionPresetLabel(presetId?: string | null): string {
  if (presetId === 'read_only') return 'Read-Only/Recon'
  if (presetId === 'plan') return 'Plan'
  if (presetId === 'workspace_write') return 'Workspace write'
  if (presetId === 'full_access') return 'Trusted Session'
  if (presetId === 'custom') return 'Custom'
  if (presetId === 'default') return 'Default'
  return 'Default'
}

function formatInspectorTokenCount(value: unknown): string {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (numeric >= 1_000_000_000) return `${(numeric / 1_000_000_000).toFixed(2)}B`
  if (numeric >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(numeric >= 10_000_000 ? 0 : 1)}M`
  }
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(numeric >= 10_000 ? 0 : 1)}k`
  return String(Math.round(numeric))
}

function formatEnsembleMode(mode?: string): string {
  return mode === 'continuous' ? 'Continuous' : 'Turn-bound'
}

function participantTokenTotal(participant: EnsembleParticipant): number {
  const totals = participant.tokenTotals || {}
  if (typeof totals.total_tokens === 'number') return totals.total_tokens
  const input = typeof totals.input_tokens === 'number' ? totals.input_tokens : 0
  const output = typeof totals.output_tokens === 'number' ? totals.output_tokens : 0
  return input + output
}

function participantRuntimeLabel(participant: EnsembleParticipant): string {
  const pieces = [participant.model || 'cli-default']
  if (participant.reasoningEffort) pieces.push(`${participant.reasoningEffort} reasoning`)
  if (participant.fastModeEnabled) pieces.push('Fast')
  if (participant.thinkingEnabled) pieces.push('Thinking')
  return pieces.join(' · ')
}

function contractForProvider(
  props: InspectorProps,
  provider: ProviderId
): ProviderCapabilityContract | null | undefined {
  return (
    props.providerCapabilitiesByProvider?.[provider] ||
    (props.provider === provider ? props.providerCapabilities : null)
  )
}

function contractStateLabel(contract?: ProviderCapabilityContract | null): string {
  if (!contract) return 'not loaded'
  if (!contract.availability.available) return 'unavailable'
  if (contract.warnings.some((warning) => warning.severity === 'error')) return 'needs attention'
  if (contract.warnings.some((warning) => warning.severity === 'warning')) return 'warning'
  return 'available'
}

function contractStateColor(contract?: ProviderCapabilityContract | null): string {
  if (!contract) return 'var(--text-secondary)'
  if (!contract.availability.available) return 'var(--danger)'
  if (contract.warnings.some((warning) => warning.severity === 'error')) return 'var(--danger)'
  if (contract.warnings.some((warning) => warning.severity === 'warning')) return 'var(--warning)'
  return 'var(--success)'
}

function contractToolSummary(contract?: ProviderCapabilityContract | null): string {
  if (!contract) return 'Capability contract not loaded yet'
  const tools = [
    contract.tools.shellCommands,
    contract.tools.fileChanges,
    contract.tools.mcpTools,
    contract.tools.networkAccess
  ].filter(Boolean)
  return tools.map((tool) => `${safeText(tool.label)} ${safeText(tool.state)}`).join(' · ')
}

function runStateForParticipant(chat: ChatRecord, participant: EnsembleParticipant): string {
  const activeRound = chat.ensemble?.activeRound
  const state = activeRound?.participants.find((item) => item.participantId === participant.id)
  if (activeRound?.activeParticipantId === participant.id && activeRound.status === 'running') {
    return 'speaking'
  }
  return state?.status || 'idle'
}

function EnsembleCapabilitiesTab(props: InspectorProps) {
  const chat = props.currentChat
  const ensemble = chat?.ensemble
  if (!chat || chat.chatKind !== 'ensemble' || !ensemble) {
    return null
  }

  const participants = [...(ensemble.participants || [])].sort((a, b) => a.order - b.order)
  const enabledParticipants = participants.filter((participant) => participant.enabled)
  const providers = Array.from(
    new Set(enabledParticipants.map((participant) => participant.provider))
  ) as ProviderId[]
  const totalTokens = enabledParticipants.reduce(
    (sum, participant) => sum + participantTokenTotal(participant),
    0
  )
  const contracts = providers
    .map((provider) => contractForProvider(props, provider))
    .filter(Boolean)
  const availableContracts = contracts.filter((contract) => contract?.availability.available).length
  const activeParticipant = participants.find(
    (participant) => participant.id === ensemble.activeRound?.activeParticipantId
  )

  return (
    <div className="safety-panel">
      <div className="safety-card">
        <h4>Ensemble capabilities</h4>
        <p
          style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--text-secondary)',
            margin: '0 0 var(--space-md) 0'
          }}
        >
          Multi-provider view for this Ensemble chat. Each participant keeps its own provider
          session, model, permission preset, and tooling contract while the orchestrator serializes
          turns through the active speaker lock.
        </p>
        <div className="safety-row">
          <span>Participants</span>
          <span>
            {enabledParticipants.length} enabled / {participants.length} configured
          </span>
        </div>
        <div className="safety-row">
          <span>Providers</span>
          <span>{providers.map(providerLabel).join(', ') || 'none enabled'}</span>
        </div>
        <div className="safety-row">
          <span>Mode</span>
          <span>{formatEnsembleMode(ensemble.orchestrationMode)}</span>
        </div>
        <div className="safety-row">
          <span>Active speaker</span>
          <span>
            {activeParticipant
              ? `${safeText(activeParticipant.role, 'Participant')} · ${providerLabel(activeParticipant.provider)}`
              : 'none'}
          </span>
        </div>
        <div className="safety-row">
          <span>Participant tokens</span>
          <span>{formatInspectorTokenCount(totalTokens)}</span>
        </div>
        <div className="safety-row">
          <span>Tooling contracts</span>
          <span>
            {availableContracts} / {providers.length || 0} available
          </span>
        </div>
      </div>

      {participants.map((participant) => {
        const contract = contractForProvider(props, participant.provider)
        const tokenTotals = participant.tokenTotals || {}
        return (
          <div
            key={participant.id}
            className="safety-card"
            style={{ opacity: participant.enabled ? 1 : 0.62 }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-sm)'
              }}
            >
              <h4>
                {safeText(participant.role, 'Participant')} · {providerLabel(participant.provider)}
              </h4>
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: participant.enabled ? 'var(--success)' : 'var(--text-tertiary)',
                  whiteSpace: 'nowrap'
                }}
              >
                {participant.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            <div className="safety-row">
              <span>Order</span>
              <span>#{participant.order}</span>
            </div>
            <div className="safety-row">
              <span>Run state</span>
              <span>{safeText(runStateForParticipant(chat, participant))}</span>
            </div>
            <div className="safety-row">
              <span>Runtime</span>
              <span>{participantRuntimeLabel(participant)}</span>
            </div>
            <div className="safety-row">
              <span>Permissions</span>
              <span>{permissionPresetLabel(participant.permissionPresetId)}</span>
            </div>
            {participant.permissionPresetId === 'read_only' && (
              <div className="safety-row">
                <span>Tool access</span>
                <ReadOnlyToolClassBreakdown />
              </div>
            )}
            <div className="safety-row">
              <span>Tokens</span>
              <span>
                {formatInspectorTokenCount(tokenTotals.input_tokens)} in ·{' '}
                {formatInspectorTokenCount(tokenTotals.output_tokens)} out
              </span>
            </div>
            <div className="safety-row">
              <span>Provider status</span>
              <span style={{ color: contractStateColor(contract) }}>
                {contractStateLabel(contract)}
              </span>
            </div>
            <div className="safety-row">
              <span>Tooling</span>
              <span>{contractToolSummary(contract)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CapabilitiesTab(props: InspectorProps) {
  const { currentWorkspace } = props
  const workspacePath = props.provider === 'gemini' ? currentWorkspace?.path : undefined
  const { capabilities, isLoading, error, refreshCapabilities } =
    useGeminiCapabilities(workspacePath)
  if (props.currentChat?.chatKind === 'ensemble' && props.currentChat.ensemble) {
    return <EnsembleCapabilitiesTab {...props} />
  }

  if (props.provider === 'codex') {
    return (
      <div className="safety-panel">
        <ToolingContractCard contract={props.providerCapabilities} />
        <div className="safety-card">
          <h4>Codex capabilities</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-md) 0'
            }}
          >
            Codex capability discovery is provider-owned through app-server. Model list is
            available; richer MCP/plugin/app status can be layered onto this panel as the app-server
            status APIs are expanded.
          </p>
          <div className="safety-row">
            <span>CLI</span>
            <span>{safeText(props.codexStatus?.version, 'unknown')}</span>
          </div>
          <div className="safety-row">
            <span>App-server</span>
            <span>{safeText(props.codexStatus?.appServer, 'lazy')}</span>
          </div>
          <div className="safety-row">
            <span>Models</span>
            <span>{props.codexModels?.length || 0}</span>
          </div>
          <div className="safety-row">
            <span>MCP servers</span>
            <span>{props.codexMcpStatus?.data?.length || 0}</span>
          </div>
        </div>
        {(props.codexModels || []).slice(0, 10).map((model, index) => (
          <div key={safeText(model.id) || `codex-model-${index}`} className="safety-card">
            <h4>{safeText(model.label) || safeText(model.id, 'Model')}</h4>
            <div className="safety-row">
              <span>Model id</span>
              <span>{safeText(model.id)}</span>
            </div>
            <div className="safety-row">
              <span>Default effort</span>
              <span>{safeText(model.defaultReasoningEffort, 'default')}</span>
            </div>
            <div className="safety-row">
              <span>Speed tiers</span>
              <span>{safeText(model.additionalSpeedTiers, 'standard')}</span>
            </div>
          </div>
        ))}
        {(props.codexMcpStatus?.data || []).slice(0, 8).map((server: any, idx: number) => (
          <div key={safeText(server?.name) || `server-${idx}`} className="safety-card">
            <h4>{safeText(server?.name, 'Server')}</h4>
            <div className="safety-row">
              <span>Auth</span>
              <span>{safeText(server?.authStatus, 'unknown')}</span>
            </div>
            <div className="safety-row">
              <span>Tools</span>
              <span>{server?.tools ? Object.keys(server.tools).length : 0}</span>
            </div>
          </div>
        ))}
        <div className="safety-card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 'var(--space-sm)'
            }}
          >
            <h4>Codex threads</h4>
            <PillButton
              variant="ghost"
              size="compact"
              onClick={props.onRefreshCodexThreads}
              disabled={!props.onRefreshCodexThreads}
            >
              Refresh
            </PillButton>
          </div>
          {(props.codexThreads || []).length === 0 ? (
            <p
              style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}
            >
              No persisted Codex threads found for this workspace yet.
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-sm)',
                marginTop: 'var(--space-sm)'
              }}
            >
              {(props.codexThreads || []).slice(0, 8).map((thread: any, idx: number) => (
                <div
                  key={safeText(thread?.id) || `thread-${idx}`}
                  style={{
                    borderTop: '1px solid var(--panel-border)',
                    paddingTop: 'var(--space-sm)'
                  }}
                >
                  <div
                    style={{
                      fontSize: 'var(--font-size-sm)',
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {safeText(thread?.name) ||
                      safeText(thread?.preview) ||
                      safeText(thread?.id, 'Thread')}
                  </div>
                  <div
                    style={{
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--text-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {safeText(thread?.status, 'unknown')} ·{' '}
                    {safeText(thread?.modelProvider, 'openai')} · {safeText(thread?.id)}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--space-sm)',
                      marginTop: 'var(--space-sm)'
                    }}
                  >
                    <PillButton
                      variant="primary"
                      size="compact"
                      onClick={() => props.onResumeCodexThread?.(thread.id)}
                    >
                      Resume
                    </PillButton>
                    <PillButton
                      variant="ghost"
                      size="compact"
                      onClick={() => props.onForkCodexThread?.(thread.id)}
                      title="Native Codex thread/fork"
                    >
                      Fork (native)
                    </PillButton>
                    <PillButton
                      variant="ghost"
                      size="compact"
                      onClick={() => props.onRollbackCodexThread?.(thread.id)}
                      title="Rollback Codex thread history only. This does not revert workspace files."
                    >
                      Rollback thread
                    </PillButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (props.provider === 'claude' || props.provider === 'kimi') {
    const label = providerLabel(props.provider)
    return (
      <div className="safety-panel">
        <ToolingContractCard contract={props.providerCapabilities} />
        <div className="safety-card">
          <h4>{label} capabilities</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-md) 0'
            }}
          >
            {label} is registered as a first-class provider. Structured quota, thread browser, and
            MCP status are shown only when the provider exposes safe machine-readable APIs.
          </p>
          <div className="safety-row">
            <span>Binary</span>
            <span>{safeText(props.codexStatus?.binaryPath, 'not found')}</span>
          </div>
          <div className="safety-row">
            <span>Version</span>
            <span>{safeText(props.codexStatus?.version, 'unknown')}</span>
          </div>
          <div className="safety-row">
            <span>Models</span>
            <span>{props.codexModels?.length || 0}</span>
          </div>
          <div className="safety-row">
            <span>Quota</span>
            <span>unavailable</span>
          </div>
          <div className="safety-row">
            <span>MCP status</span>
            <span>{props.codexMcpStatus?.available ? 'available' : 'unavailable'}</span>
          </div>
        </div>
        {(props.codexModels || []).map((model, idx) => (
          <div key={safeText(model.id) || `claude-model-${idx}`} className="safety-card">
            <h4>{safeText(model.label) || safeText(model.id, 'Model')}</h4>
            <div className="safety-row">
              <span>Model id</span>
              <span>{safeText(model.id)}</span>
            </div>
          </div>
        ))}
        <div className="safety-card">
          <h4>Sessions and review</h4>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: '0 0 var(--space-sm) 0' }}>
            Native provider forks are unavailable on {label}. TaskWraith can still create an
            emulated fork that duplicates this chat transcript into an isolated sibling chat.
            Rollback stays disabled until {label} exposes stable structured session IDs. Diff
            Studio remains shared for file changes.
          </p>
          <PillButton
            variant="primary"
            size="compact"
            onClick={() => props.onForkAgentThread?.(props.provider)}
            disabled={!props.onForkAgentThread}
          >
            Fork (emulated)
          </PillButton>
        </div>
      </div>
    )
  }

  return (
    <div className="safety-panel">
      <div className="diff-studio-toolbar">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
            Gemini capability state
          </div>
          <div
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {workspacePath || 'No workspace selected'}
          </div>
        </div>
        <PillButton
          variant="ghost"
          size="compact"
          onClick={refreshCapabilities}
          disabled={!workspacePath || isLoading}
          loading={isLoading}
        >
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </PillButton>
      </div>

      <ToolingContractCard contract={props.providerCapabilities} />

      <div className="safety-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 'var(--space-sm)',
            alignItems: 'center'
          }}
        >
          <h4>TaskWraith MCP bridge</h4>
          <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
            <PillButton
              variant="ghost"
              size="compact"
              onClick={props.onRefreshGeminiMcpBridgeStatus}
              disabled={!props.onRefreshGeminiMcpBridgeStatus}
            >
              Test
            </PillButton>
            <PillButton
              variant="primary"
              size="compact"
              onClick={props.onInstallGeminiMcpBridge}
              disabled={!props.onInstallGeminiMcpBridge}
            >
              Install / repair
            </PillButton>
          </div>
        </div>
        <div className="safety-row">
          <span>App setting</span>
          <span>{props.geminiMcpBridgeEnabled ? 'enabled' : 'disabled'}</span>
        </div>
        <div className="safety-row">
          <span>Gemini config</span>
          <span>{props.geminiMcpBridgeStatus?.installed ? 'installed' : 'not installed'}</span>
        </div>
        <div className="safety-row">
          <span>Status</span>
          <span
            style={{
              color: props.geminiMcpBridgeStatus?.available ? 'var(--success)' : 'var(--warning)'
            }}
          >
            {props.geminiMcpBridgeStatus?.available ? 'available' : 'unavailable'}
          </span>
        </div>
        <p
          style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--text-secondary)',
            margin: 'var(--space-sm) 0 0 0'
          }}
        >
          {props.geminiMcpBridgeStatus?.message ||
            'Use Install / repair only when you want TaskWraith to update your Gemini MCP configuration.'}
        </p>
      </div>

      {!workspacePath && (
        <div className="safety-card">
          <h4>Workspace required</h4>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}>
            Select a workspace to inspect MCP servers, extensions, skills, and agents in that Gemini
            CLI context.
          </p>
        </div>
      )}

      {workspacePath && isLoading && !capabilities && (
        <div className="safety-card">
          <h4>Loading capabilities...</h4>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}>
            Running read-only Gemini CLI list commands.
          </p>
        </div>
      )}

      {error && (
        <div className="safety-card">
          <h4>Capability scan failed</h4>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        </div>
      )}

      {capabilities && (
        <>
          <div
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-tertiary)',
              padding: '0 var(--space-xs)'
            }}
          >
            Last refreshed {formatCapabilityTime(capabilities.refreshedAt)}
          </div>
          {CAPABILITY_ORDER.map((kind) => (
            <CapabilityCard key={kind} section={capabilities.sections[kind]} />
          ))}
        </>
      )}
    </div>
  )
}

function CapabilityCard({ section }: { section: GeminiCapabilitySection }) {
  const previewStdout = truncateRawOutput(section.stdout)
  const previewStderr = truncateRawOutput(section.stderr)

  return (
    <div className="safety-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-sm)'
        }}
      >
        <h4>{CAPABILITY_LABELS[section.kind]}</h4>
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            color: commandStatusColor(section),
            whiteSpace: 'nowrap'
          }}
        >
          {commandStatusLabel(section)}
        </span>
      </div>

      <div className="safety-row">
        <span>Command</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
          {section.command.join(' ')}
        </span>
      </div>
      <div className="safety-row">
        <span>Format</span>
        <span>{section.format}</span>
      </div>
      <div className="safety-row">
        <span>Entries</span>
        <span>{section.items.length}</span>
      </div>

      {section.parsingError && (
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--warning)',
            marginTop: 'var(--space-sm)'
          }}
        >
          JSON parse failed, using raw list output.
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-sm)',
          marginTop: 'var(--space-md)'
        }}
      >
        {section.items.length === 0 ? (
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            {section.status === 0
              ? 'No entries parsed from command output.'
              : 'Command did not complete successfully.'}
          </div>
        ) : (
          section.items.slice(0, 8).map((item) => (
            <div
              key={`${section.kind}-${item.id}-${item.name}`}
              style={{ borderTop: '1px solid var(--panel-border)', paddingTop: 'var(--space-sm)' }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-sm)' }}
              >
                <span
                  style={{
                    fontSize: 'var(--font-size-sm)',
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {item.name}
                </span>
                {item.status && (
                  <span
                    style={{
                      fontSize: 'var(--font-size-xs)',
                      color: capabilityStatusColor(item.status),
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {item.status}
                  </span>
                )}
              </div>
              {item.detail && (
                <div
                  style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {item.detail}
                </div>
              )}
            </div>
          ))
        )}
        {section.items.length > 8 && (
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
            +{section.items.length - 8} more entries in raw output
          </div>
        )}
      </div>

      <details style={{ marginTop: 'var(--space-md)' }}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-secondary)'
          }}
        >
          Raw stdout/stderr
        </summary>
        <pre
          style={{
            margin: 'var(--space-sm) 0 0 0',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-secondary)'
          }}
        >
          {previewStdout || previewStderr
            ? `${previewStdout}${previewStdout && previewStderr ? '\n\n[stderr]\n' : ''}${previewStderr}`
            : 'No output'}
        </pre>
      </details>
    </div>
  )
}

function EnsembleSafetyTab(props: InspectorProps) {
  const chat = props.currentChat
  const ensemble = chat?.ensemble
  const participants = getOrderedEnsembleParticipants(chat)
  const enabledParticipants = participants.filter((participant) => participant.enabled)
  const providers = uniqueProviders(participants)
  const externalPathGrants = props.externalPathGrants || []
  const activeParticipant = participants.find(
    (participant) => participant.id === ensemble?.activeRound?.activeParticipantId
  )
  const writeParticipants = enabledParticipants.filter(
    (participant) =>
      participant.permissionPresetId === 'workspace_write' ||
      participant.permissionPresetId === 'full_access' ||
      participant.permissionPresetId === 'custom'
  )

  return (
    <div className="safety-panel">
      <div className="safety-card">
        <h4>Ensemble safety</h4>
        <p
          style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--text-secondary)',
            margin: '0 0 var(--space-md) 0'
          }}
        >
          Ensemble runs use a serial active-speaker lock. Multiple participants can be configured
          with write permissions, but only the current speaker can run tools or request approvals at
          a given moment.
        </p>
        <div className="safety-row">
          <span>Mode</span>
          <span>{formatEnsembleMode(ensemble?.orchestrationMode)}</span>
        </div>
        <div className="safety-row">
          <span>Speaker lock</span>
          <span style={{ color: 'var(--success)' }}>serial</span>
        </div>
        <div className="safety-row">
          <span>Active speaker</span>
          <span>
            {activeParticipant
              ? `${safeText(activeParticipant.role, 'Participant')} · ${providerLabel(activeParticipant.provider)}`
              : 'none'}
          </span>
        </div>
        <div className="safety-row">
          <span>Participants</span>
          <span>
            {enabledParticipants.length} enabled / {participants.length} configured
          </span>
        </div>
        <div className="safety-row">
          <span>Write-capable</span>
          <span>{writeParticipants.length}</span>
        </div>
        <div className="safety-row">
          <span>External grants</span>
          <span>{externalPathGrants.length}</span>
        </div>
      </div>

      {participants.map((participant) => {
        const contract = contractForProvider(props, participant.provider)
        const grants = externalPathGrants.filter((grant) => grant.provider === participant.provider)
        return (
          <div
            key={participant.id}
            className="safety-card"
            style={{ opacity: participant.enabled ? 1 : 0.62 }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-sm)'
              }}
            >
              <h4>
                {safeText(participant.role, 'Participant')} · {providerLabel(participant.provider)}
              </h4>
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: participant.enabled ? 'var(--success)' : 'var(--text-tertiary)',
                  whiteSpace: 'nowrap'
                }}
              >
                {participant.enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            <div className="safety-row">
              <span>Permission preset</span>
              <span>{permissionPresetLabel(participant.permissionPresetId)}</span>
            </div>
            <div className="safety-row">
              <span>Run state</span>
              <span>{safeText(runStateForParticipant(chat!, participant))}</span>
            </div>
            <div className="safety-row">
              <span>Provider contract</span>
              <span style={{ color: contractStateColor(contract) }}>
                {contractStateLabel(contract)}
              </span>
            </div>
            <div className="safety-row">
              <span>Approvals</span>
              <span>{safeText(contract?.approvals.providerMode, 'participant preset')}</span>
            </div>
            <div className="safety-row">
              <span>External grants</span>
              <span>{grants.length}</span>
            </div>
          </div>
        )
      })}

      <div className="safety-card">
        <h4>Provider setup</h4>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}>
          Provider login/setup remains provider-owned. Use Settings → Providers for Codex, Claude,
          Gemini, and Kimi auth state; Ensemble chats never scrape credentials from another
          provider.
        </p>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-xs)',
            marginTop: 'var(--space-sm)'
          }}
        >
          {providers.map((provider) => {
            const contract = contractForProvider(props, provider)
            return (
              <div className="safety-row" key={provider}>
                <span>{providerLabel(provider)}</span>
                <span style={{ color: contractStateColor(contract) }}>
                  {contractStateLabel(contract)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SafetyTab(props: InspectorProps) {
  const {
    provider,
    approvalMode,
    codexStatus,
    geminiVersion,
    isOldVersion,
    trustResult,
    showTerminal,
    setShowTerminal,
    currentWorkspace,
    onImportCodexUsageCredential,
    onClearCodexUsageCredential,
    externalPathGrants = []
  } = props
  const { copiedId, copy } = useCopyFeedback()
  if (props.currentChat?.chatKind === 'ensemble' && props.currentChat.ensemble) {
    return <EnsembleSafetyTab {...props} />
  }

  if (provider === 'codex') {
    const sandbox = approvalMode === 'plan' ? 'read-only' : 'workspace-write'
    const approvalPolicy =
      approvalMode === 'auto_edit' || approvalMode === 'plan' ? 'never' : 'on-request'
    return (
      <div className="safety-panel">
        <div className="safety-card">
          <h4>Codex safety</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-md) 0'
            }}
          >
            Codex runs through an app-owned app-server thread. Command and file approvals are routed
            back into this UI when the selected mode prompts.
          </p>
          <div className="safety-row">
            <span>Sandbox</span>
            <span>{sandbox}</span>
          </div>
          <div className="safety-row">
            <span>Approval policy</span>
            <span>{approvalPolicy}</span>
          </div>
          <div className="safety-row">
            <span>Auth state</span>
            <span>{codexStatus?.authState || 'unknown'}</span>
          </div>
          <div className="safety-row">
            <span>Plan</span>
            <span>{codexStatus?.planType || 'unknown'}</span>
          </div>
          <div className="safety-row">
            <span>Usage source</span>
            <span>
              {codexStatus?.codexUsage?.windows?.length
                ? 'ChatGPT usage endpoint'
                : 'local fallback'}
            </span>
          </div>
          <div className="safety-row">
            <span>Usage account</span>
            <span>{codexStatus?.codexUsage?.accountId || 'not imported'}</span>
          </div>
          <div className="safety-row">
            <span>External grants</span>
            <span>{externalPathGrants.length}</span>
          </div>
          <div className="safety-row">
            <span>CLI</span>
            <span>{codexStatus?.version || 'unknown'}</span>
          </div>
          {codexStatus?.rateLimits && (
            <>
              <div className="safety-row">
                <span>Primary usage</span>
                <span>{Math.round(codexStatus.rateLimits.primary?.usedPercent || 0)}%</span>
              </div>
              <div className="safety-row">
                <span>Window</span>
                <span>
                  {codexStatus.rateLimits.primary?.windowDurationMins
                    ? `${codexStatus.rateLimits.primary.windowDurationMins}m`
                    : 'unknown'}
                </span>
              </div>
            </>
          )}
        </div>
        {externalPathGrants.length > 0 && (
          <div className="safety-card">
            <h4>External path grants</h4>
            <p
              style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--text-secondary)',
                margin: '0 0 var(--space-md) 0'
              }}
            >
              These selected files or folders are passed as scoped sandbox roots for provider runs
              in this chat. Revoke them from the composer chip before the next run.
            </p>
            {externalPathGrants.map((grant) => (
              <div className="safety-row" key={grant.id}>
                <span>
                  {grant.access === 'write' ? 'Edit' : 'Read'} {grant.kind}
                </span>
                <span title={grant.path}>{grant.path}</span>
              </div>
            ))}
          </div>
        )}
        <div className="safety-card">
          <h4>Codex usage import</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-md) 0'
            }}
          >
            For accurate 5h, weekly, and Spark meters, explicitly import your Codex session from{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>~/.codex/auth.json</span>. The token is
            encrypted with Electron safeStorage when available and is only used to call ChatGPT
            usage limits.
          </p>
          {codexStatus?.codexUsage?.error && (
            <p
              style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--warning)',
                margin: '0 0 var(--space-md) 0'
              }}
            >
              {codexStatus.codexUsage.error}
            </p>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-md)' }}>
            <PillButton
              variant="primary"
              style={{ flex: 1 }}
              onClick={onImportCodexUsageCredential}
              disabled={!onImportCodexUsageCredential}
            >
              Import Codex usage session
            </PillButton>
            <PillButton
              variant="ghost"
              onClick={onClearCodexUsageCredential}
              disabled={!onClearCodexUsageCredential}
            >
              Clear
            </PillButton>
          </div>
        </div>
        <div className="safety-card">
          <h4>Codex login</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-md) 0'
            }}
          >
            If Codex reports missing auth in Raw Events, use this scoped terminal and run{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>codex login</span>. Credentials are
            handled by the Codex CLI.
          </p>
          {currentWorkspace && !showTerminal && (
            <PillButton
              variant="primary"
              style={{ width: '100%' }}
              onClick={() => setShowTerminal(true)}
            >
              Open Codex login terminal...
            </PillButton>
          )}
          {currentWorkspace && showTerminal && (
            <div className="trust-assistant-panel">
              <div className="trust-assistant-copy">
                <strong>Codex login terminal</strong>
                <span>Run codex login here if the app-server reports missing authentication.</span>
              </div>
              <TerminalPanel
                workspacePath={currentWorkspace.path}
                onClose={() => setShowTerminal(false)}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  if (provider === 'claude' || provider === 'kimi') {
    const label = providerLabel(provider)
    const setupCommand = provider === 'claude' ? 'claude auth login' : 'kimi login'
    const permissionText =
      provider === 'claude'
        ? approvalMode === 'plan'
          ? 'Claude plan mode'
          : approvalMode === 'auto_edit'
            ? 'Claude acceptEdits'
            : 'Claude default permissions'
        : approvalMode === 'plan'
          ? 'Kimi plan/read-only intent'
          : approvalMode === 'auto_edit'
            ? 'Kimi provider approvals; YOLO not enabled'
            : 'Kimi provider approvals'
    return (
      <div className="safety-panel">
        <div className="safety-card">
          <h4>{label} safety</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-md) 0'
            }}
          >
            {label} runs through the provider adapter. Credential files are not read by this app;
            setup stays delegated to the provider CLI.
          </p>
          <div className="safety-row">
            <span>Binary</span>
            <span>{codexStatus?.available ? 'available' : 'missing'}</span>
          </div>
          <div className="safety-row">
            <span>Path</span>
            <span>{codexStatus?.binaryPath || 'auto-detect failed'}</span>
          </div>
          <div className="safety-row">
            <span>Version</span>
            <span>{codexStatus?.version || 'unknown'}</span>
          </div>
          <div className="safety-row">
            <span>Auth state</span>
            <span>{codexStatus?.authState || 'unknown'}</span>
          </div>
          <div className="safety-row">
            <span>Permissions</span>
            <span>{permissionText}</span>
          </div>
          {codexStatus?.error && (
            <p
              style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--warning)',
                margin: 'var(--space-sm) 0 0 0'
              }}
            >
              {codexStatus.error}
            </p>
          )}
        </div>
        <div className="safety-card">
          <h4>{label} setup</h4>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-secondary)',
              margin: '0 0 var(--space-md) 0'
            }}
          >
            Use a scoped terminal for provider login/setup. For binary overrides, open Settings.
          </p>
          {currentWorkspace && !showTerminal && (
            <PillButton
              variant="primary"
              style={{ width: '100%' }}
              onClick={() => setShowTerminal(true)}
            >
              Open {label} setup terminal...
            </PillButton>
          )}
          {currentWorkspace && showTerminal && (
            <div className="trust-assistant-panel">
              <div className="trust-assistant-copy">
                <strong>{label} setup terminal</strong>
                <span>
                  Run {setupCommand} if this provider needs authentication or first-time setup.
                </span>
              </div>
              <TerminalPanel
                workspacePath={currentWorkspace.path}
                onClose={() => setShowTerminal(false)}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="safety-panel">
      <div className="safety-card">
        <h4>Workspace Trust</h4>
        <p
          style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--text-secondary)',
            margin: '0 0 var(--space-md) 0'
          }}
        >
          Gemini CLI enforces interactive workspace trust checks to prevent accidental execution in
          untrusted folders.
        </p>
        {currentWorkspace &&
          trustResult?.status !== 'trusted' &&
          trustResult?.status !== 'inherited' && (
            <div style={{ marginBottom: 'var(--space-md)' }}>
              {!showTerminal ? (
                <PillButton
                  variant="primary"
                  style={{ width: '100%', marginBottom: 'var(--space-sm)' }}
                  onClick={() => setShowTerminal(true)}
                >
                  Open Trust Assistant...
                </PillButton>
              ) : (
                <div className="trust-assistant-panel">
                  <div className="trust-assistant-copy">
                    <strong>Trust Assistant</strong>
                    <span>Use this scoped terminal only for Gemini workspace trust prompts.</span>
                  </div>
                  <TerminalPanel
                    workspacePath={currentWorkspace.path}
                    onClose={() => {
                      setShowTerminal(false)
                      window.api.checkTrust(currentWorkspace.path).then(() => {})
                    }}
                  />
                </div>
              )}
            </div>
          )}
        <PillButton
          variant="ghost"
          size="compact"
          style={{ width: '100%' }}
          onClick={() => copy('permissions-trust', '/permissions trust')}
        >
          {copiedId === 'permissions-trust' ? 'Copied' : 'Copy /permissions trust'}
        </PillButton>
      </div>

      <div className="safety-card">
        <h4>CLI Details</h4>
        <div className="safety-row">
          <span>Version</span>
          <span>{geminiVersion}</span>
        </div>
        <div className="safety-row">
          <span>Sandbox</span>
          <span style={{ color: 'var(--success)' }}>On</span>
        </div>
        <div className="safety-row">
          <span>Yolo mode</span>
          <span style={{ color: 'var(--danger)' }}>Blocked</span>
        </div>
        <div className="safety-row">
          <span>Trust status</span>
          <span
            style={{
              color:
                trustResult?.status === 'trusted' || trustResult?.status === 'inherited'
                  ? 'var(--success)'
                  : trustResult?.status === 'untrusted'
                    ? 'var(--danger)'
                    : 'var(--text-secondary)'
            }}
          >
            {trustResult?.status || 'Unknown'}
          </span>
        </div>
        {isOldVersion && (
          <div
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--warning)',
              marginTop: 'var(--space-sm)'
            }}
          >
            Upgrade to &gt;= 0.39.1 recommended for secure headless trust.
          </div>
        )}
      </div>
    </div>
  )
}
