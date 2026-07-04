import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { MascotGhost } from './AppChromeSymbols'
import type {
  ChatRecord,
  ProviderId,
  RunQueueJob,
  RunQueueJobStatus
} from '../../../main/store/types'
import { isRunQueueJobVisibleForChat } from '../lib/runningChatVisibility'

type ActiveRunQueueStatus = RunQueueJobStatus | 'promoting' | 'steer_promoting'

const ACTIVE_STATUSES: ActiveRunQueueStatus[] = [
  'queued',
  'starting',
  'active',
  'promoting',
  'steer_promoting'
]

const isActiveQueueStatus = (status: string): status is ActiveRunQueueStatus =>
  (ACTIVE_STATUSES as readonly string[]).includes(status)

/** Right-chevron matching the other sidebar section headers (rotates when
 * expanded). Inlined to avoid a Sidebar ↔ ActiveRunsSection import cycle. */
function ActiveRunsChevron({ isExpanded }: { isExpanded: boolean }): JSX.Element {
  return (
    <span
      className={`sf-symbol-icon sidebar-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}
      aria-hidden
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.2 4.7 10 8.1 6.2 11.5" />
      </svg>
    </span>
  )
}

interface ActiveRunsSectionProps {
  chats: ChatRecord[]
  currentChat: ChatRecord | null
  runningChatIds?: string[]
  onSelectChat: (chat: ChatRecord) => void
  onAddRunQueueJobToWorkspaceBoard?: (job: RunQueueJob) => void
  /** Reserved: a runId-targeted inspector deep-link. Not wired — clicking a
   * row now opens the chat THREAD (transcript), not the Run Inspector. */
  onInspectRun?: (runId: string, chatId: string | undefined) => void
}

export function ActiveRunsSection({
  chats,
  currentChat,
  runningChatIds = [],
  onSelectChat,
  onAddRunQueueJobToWorkspaceBoard
}: ActiveRunsSectionProps): JSX.Element {
  const [jobs, setJobs] = useState<RunQueueJob[]>([])
  const [, setNowTick] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const chatById = useMemo(() => {
    const map = new Map<string, ChatRecord>()
    for (const chat of chats) map.set(chat.appChatId, chat)
    return map
  }, [chats])
  const runningKey = runningChatIds.join('|')

  const refresh = useCallback(async () => {
    if (typeof window.api.getRunQueueJobs !== 'function') return
    try {
      const result = await window.api.getRunQueueJobs({
        statuses: ACTIVE_STATUSES as unknown as RunQueueJobStatus[]
      })
      setJobs(Array.isArray(result) ? result : [])
    } catch {
      setJobs([])
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
    }
  }, [refresh, chats, runningKey])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTick((tick) => tick + 1)
      void refresh()
    }, 1000)
    return () => window.clearInterval(intervalId)
  }, [refresh])

  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const visibleJobs = jobs.filter(
    (job): job is RunQueueJob & { status: ActiveRunQueueStatus } =>
      isActiveQueueStatus(job.status) && isJobBackedByLiveChat(job, chatById.get(job.chatId || ''))
  )

  // 1.0.6 — persistent section: always render (so it permanently occupies the
  // top slot under Search / above Pinned), collapsible like the other
  // sections, with a quiet empty state when nothing is running.
  return (
    <div className="sidebar-active-runs-section">
      <div className="sidebar-section-header">
        <button
          type="button"
          className="sidebar-section-header-toggle"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand Active Runs' : 'Collapse Active Runs'}
        >
          <ActiveRunsChevron isExpanded={!collapsed} />
          <h4 className="sidebar-section-title">Active Runs</h4>
        </button>
        {visibleJobs.length > 0 && (
          <span className="sidebar-active-runs-count">{visibleJobs.length}</span>
        )}
      </div>
      {!collapsed && (
        <div className="sidebar-active-runs-list">
          {visibleJobs.length === 0 && (
            <div className="sidebar-active-runs-empty">
              <MascotGhost size={13} />
              <span>No active runs</span>
            </div>
          )}
          {visibleJobs.map((job) => {
            const chat = job.chatId ? chatById.get(job.chatId) || null : null
            const isCurrent = Boolean(chat && currentChat?.appChatId === chat.appChatId)
            return (
              <div
                key={job.id || job.runId}
                className="sidebar-active-run-entry"
              >
                <button
                  type="button"
                  className={`sidebar-active-run-row provider-${job.provider || 'gemini'} ${isCurrent ? 'active' : ''}`}
                  onClick={() => {
                    // Open the chat THREAD (transcript), not the Run Inspector.
                    if (chat) onSelectChat(chat)
                  }}
                  disabled={!chat}
                  title={chat ? chat.title : job.promptPreview || job.runId}
                >
                  <span
                    className={`sidebar-active-run-provider provider-${job.provider || 'gemini'}`}
                  >
                    {getProviderLabel(job.provider)}
                  </span>
                  <span className="sidebar-active-run-copy">
                    <span className="sidebar-active-run-workspace">
                      {getWorkspaceShortName(job, chat)}
                    </span>
                    <span className="sidebar-active-run-elapsed">{formatElapsed(job)}</span>
                  </span>
                  <span className={`sidebar-run-status tone-${statusTone(job.status)}`}>
                    {statusLabel(job.status)}
                  </span>
                </button>
                {onAddRunQueueJobToWorkspaceBoard && job.workspaceId && (
                  <button
                    type="button"
                    className="sidebar-active-run-board-action"
                    onClick={() => onAddRunQueueJobToWorkspaceBoard(job)}
                    title="Add run to workspace board"
                    aria-label={`Add ${job.promptPreview || job.runId} to workspace board`}
                  >
                    #
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function isJobBackedByLiveChat(job: RunQueueJob, chat: ChatRecord | undefined): boolean {
  return isRunQueueJobVisibleForChat(job, chat)
}

function getWorkspaceShortName(job: RunQueueJob, chat: ChatRecord | null): string {
  if (job.scope === 'global' || chat?.scope === 'global') return 'General'
  const workspacePath = job.workspacePath || chat?.workspacePath || ''
  const basename = workspacePath.split(/[\\/]/).filter(Boolean).pop()
  if (basename) return basename
  return job.workspaceId || chat?.workspaceId || 'Unknown workspace'
}

function formatElapsed(job: RunQueueJob): string {
  const started = Date.parse(job.startedAt || job.enqueuedAt || job.createdAt)
  if (!Number.isFinite(started)) return 'now'
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function statusLabel(status: ActiveRunQueueStatus): string {
  if (status === 'queued') return 'Queued'
  if (status === 'starting') return 'Starting'
  if (status === 'promoting') return 'Promoting'
  if (status === 'steer_promoting') return 'Steering'
  // "Active" reads more naturally than "Running" and pairs with the
  // contrast-aware accent shimmer-sweep CSS hook on `.tone-running`.
  if (status === 'active') return 'Active'
  return status
}

function statusTone(
  status: ActiveRunQueueStatus
): 'success' | 'warning' | 'danger' | 'muted' | 'running' {
  if (
    status === 'active' ||
    status === 'starting' ||
    status === 'promoting' ||
    status === 'steer_promoting'
  )
    return 'running'
  return 'muted'
}

function getProviderLabel(provider?: ProviderId): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  return 'Gemini'
}
