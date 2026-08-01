import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import { MascotGhost } from './AppChromeSymbols'
import type {
  ChatRecord,
  ProviderId,
  RunQueueJob,
  RunQueueJobStatus
} from '../../../main/store/types'
import {
  resolveOllamaDisplayBrand,
  resolveProviderHueClass
} from '../lib/ollamaDisplayBrand'
import { getProviderLabel } from '../lib/providerLabels'
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

type ActiveRunProviderStyle = CSSProperties & {
  '--active-run-provider-color'?: string
  '--chat-provider-accent'?: string
}

interface ActiveRunProviderDisplay {
  provider: ProviderId | null
  label: string
  providerClass: string
  style: ActiveRunProviderStyle
}

export type ActiveRunsSurface = 'chat' | 'code' | 'work'

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
  surface?: ActiveRunsSurface
  workChatIds?: readonly string[]
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
  surface,
  workChatIds = [],
  onSelectChat,
  onAddRunQueueJobToWorkspaceBoard
}: ActiveRunsSectionProps): JSX.Element {
  const [jobs, setJobs] = useState<RunQueueJob[]>([])
  const [, setNowTick] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const workChatIdSet = useMemo(() => new Set(workChatIds), [workChatIds])
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

  const visibleJobs = jobs
    .map((job) => ({ job, chat: resolveActiveRunChat(job, chats) }))
    .filter(
      (
        entry
      ): entry is {
        job: RunQueueJob & { status: ActiveRunQueueStatus }
        chat: ChatRecord | null
      } =>
        isActiveQueueStatus(entry.job.status) &&
        (!surface || isActiveRunVisibleOnSurface(entry.job, entry.chat, surface, workChatIdSet)) &&
        isJobBackedByLiveChat(entry.job, entry.chat || undefined)
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
          {visibleJobs.map(({ job, chat }) => {
            const isCurrent = Boolean(chat && currentChat?.appChatId === chat.appChatId)
            const providerDisplay = resolveActiveRunProviderDisplay(job, chat)
            return (
              <div
                key={job.id || job.runId}
                className="sidebar-active-run-entry"
              >
                <button
                  type="button"
                  className={`sidebar-active-run-row provider-${providerDisplay.providerClass} ${isCurrent ? 'active' : ''}`}
                  style={providerDisplay.style}
                  onClick={() => {
                    // Open the chat THREAD (transcript), not the Run Inspector.
                    if (chat) onSelectChat(chat)
                  }}
                  disabled={!chat}
                  title={
                    chat
                      ? `${getActiveRunChatLabel(job, chat)} — ${getWorkspaceShortName(job, chat)}`
                      : job.promptPreview || job.runId
                  }
                >
                  <span
                    className={`sidebar-active-run-provider provider-${providerDisplay.providerClass}`}
                  >
                    {providerDisplay.label}
                  </span>
                  <span className="sidebar-active-run-copy">
                    <span className="sidebar-active-run-title">
                      {getActiveRunChatLabel(job, chat)}
                    </span>
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

export function resolveActiveRunChat(
  job: Pick<RunQueueJob, 'chatId' | 'runId' | 'id'>,
  chats: readonly ChatRecord[]
): ChatRecord | null {
  if (job.chatId) {
    const exact = chats.find((chat) => chat.appChatId === job.chatId)
    if (exact) return exact
  }

  return (
    chats.find((chat) =>
      (chat.runs || []).some((run) => run.runId === job.runId || run.runId === job.id)
    ) || null
  )
}

export function isActiveRunVisibleOnSurface(
  job: Pick<RunQueueJob, 'scope' | 'workspaceId' | 'workspacePath'>,
  chat: Pick<ChatRecord, 'appChatId' | 'scope'> | null,
  surface: ActiveRunsSurface,
  workChatIds: ReadonlySet<string> = new Set()
): boolean {
  if (surface === 'work') return Boolean(chat && workChatIds.has(chat.appChatId))

  const isGlobal = chat
    ? chat.scope === 'global'
    : job.scope === 'global'
      ? true
      : job.scope === 'workspace' || Boolean(job.workspaceId || job.workspacePath)
        ? false
        : true
  return surface === (isGlobal ? 'chat' : 'code')
}

function getWorkspaceShortName(job: RunQueueJob, chat: ChatRecord | null): string {
  if (job.scope === 'global' || chat?.scope === 'global') return 'General'
  const workspacePath = job.workspacePath || chat?.workspacePath || ''
  const basename = workspacePath.split(/[\\/]/).filter(Boolean).pop()
  if (basename) return basename
  return job.workspaceId || chat?.workspaceId || 'Unknown workspace'
}

/** Primary Active Runs label: chat title (fallback: prompt preview / Untitled). */
export function getActiveRunChatLabel(job: RunQueueJob, chat: ChatRecord | null): string {
  const title = chat?.title?.trim()
  if (title) return title
  const preview = job.promptPreview?.trim()
  if (preview) return preview
  return 'Untitled chat'
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

export function resolveActiveRunProviderDisplay(
  job: Pick<RunQueueJob, 'provider' | 'request' | 'runId' | 'id'>,
  chat: ChatRecord | null
): ActiveRunProviderDisplay {
  const provider = resolveActiveRunProvider(job.provider, chat?.provider)
  const modelId = resolveActiveRunModelId(job, chat)
  const brand = provider === 'ollama' ? resolveOllamaDisplayBrand(modelId) : null
  const providerClass = provider
    ? resolveProviderHueClass(provider, modelId)
    : 'unknown'
  const providerColor = provider
    ? `var(--provider-${providerClass}-color, var(--provider-${provider}-color, var(--accent)))`
    : 'var(--accent)'

  return {
    provider,
    label: brand?.providerLabel || (provider ? getProviderLabel(provider) : 'Run'),
    providerClass,
    style: {
      '--active-run-provider-color': providerColor,
      '--chat-provider-accent': providerColor
    }
  }
}

function resolveActiveRunProvider(
  jobProvider: ProviderId | undefined,
  chatProvider: ProviderId | undefined
): ProviderId | null {
  if (jobProvider && jobProvider !== 'gemini') return jobProvider
  if (chatProvider && chatProvider !== jobProvider) return chatProvider
  return jobProvider || chatProvider || null
}

function resolveActiveRunModelId(
  job: Pick<RunQueueJob, 'request' | 'runId' | 'id'>,
  chat: ChatRecord | null
): string {
  const matchingRun = (chat?.runs || []).find(
    (run) => run.runId === job.runId || run.runId === job.id
  )
  const runModel = matchingRun?.actualModel || matchingRun?.requestedModel
  if (runModel) return runModel
  const request = job.request
  if (!request) return ''
  if (request.selectedModelType === 'custom') return request.customModel || ''
  return request.selectedModelType || request.customModel || ''
}
