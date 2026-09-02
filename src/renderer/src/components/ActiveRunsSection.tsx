import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX
} from 'react'
import { MascotGhost, SidebarRunningGhost } from './AppChromeSymbols'
import type {
  ChatRecord,
  ProviderId,
  RunQueueJob,
  RunQueueJobStatus
} from '../../../main/store/types'
import { isEnsembleRoundPresentationLive } from '../../../shared/ensembleRoundLifecycle'
import { getProviderLabel } from '../lib/providerLabels'
import { isRunQueueJobVisibleForChat } from '../lib/runningChatVisibility'
import { useSharedNowTick } from '../hooks/useSharedNowTick'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { SidebarOverflowMenu } from './SidebarOverflowMenu'
import {
  createSidebarChatPopoutActions,
  type SidebarChatPopoutHandler
} from '../lib/sidebarChatPopoutAction'

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

type ActiveRunThreadStyle = CSSProperties & {
  '--chat-provider-accent'?: string
}

interface ActiveRunEntry {
  job: RunQueueJob
  chat: ChatRecord
  isTransitionFallback: boolean
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
  chats: readonly ChatRecord[]
  currentChat: ChatRecord | null
  runningChatIds?: string[]
  surface?: ActiveRunsSurface
  workChatIds?: readonly string[]
  onSelectChat: (chat: ChatRecord) => void
  onOpenChatPopout?: SidebarChatPopoutHandler
  onAddRunQueueJobToWorkspaceBoard?: (job: RunQueueJob) => void
  collapsed?: boolean
  onToggleCollapsed?: () => void
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
  onOpenChatPopout,
  onAddRunQueueJobToWorkspaceBoard,
  collapsed: controlledCollapsed,
  onToggleCollapsed
}: ActiveRunsSectionProps): JSX.Element {
  const [jobs, setJobs] = useState<RunQueueJob[]>([])
  const [localCollapsed, setLocalCollapsed] = useState(false)
  const collapsed = controlledCollapsed ?? localCollapsed
  const nowTick = useSharedNowTick()
  const hasObservedTick = useRef(false)
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
    if (!hasObservedTick.current) {
      hasObservedTick.current = true
      return
    }
    void refresh()
  }, [nowTick, refresh])

  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const visibleJobs = useMemo(
    () =>
      deriveVisibleActiveRunEntries({
        jobs,
        chats,
        surface,
        workChatIds: workChatIdSet
      }),
    [chats, jobs, nowTick, surface, workChatIdSet]
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
          onClick={() => {
            if (onToggleCollapsed) {
              onToggleCollapsed()
            } else {
              setLocalCollapsed((current) => !current)
            }
          }}
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
          {visibleJobs.map(({ job, chat, isTransitionFallback }) => {
            const isCurrent = currentChat?.appChatId === chat.appChatId
            const isRunning = isTransitionFallback || job.status !== 'queued'
            const provider = getActiveRunThreadProvider(chat)
            const title = getActiveRunChatLabel(job, chat)
            return (
              <div key={job.id || job.runId} className="sidebar-active-run-entry">
                <button
                  type="button"
                  className={`sidebar-active-run-row sidebar-active-run-thread provider-${provider} ${isCurrent ? 'active' : ''}`}
                  style={getActiveRunThreadStyle(provider)}
                  onClick={() => onSelectChat(chat)}
                  title={`${title} — ${getWorkspaceShortName(job, chat)}`}
                  aria-busy={isRunning || undefined}
                  aria-label={`${title}, ${isRunning ? 'running' : 'queued'}`}
                >
                  <span className="sidebar-chat-copy">
                    <span className="sidebar-chat-title-line">
                      <ActiveRunThreadProviderLabel provider={provider} />
                      <span className="sidebar-chat-title">{title}</span>
                    </span>
                    <span className="sidebar-chat-subline">
                      <span className="sidebar-active-run-workspace">
                        {getWorkspaceShortName(job, chat)}
                      </span>
                    </span>
                  </span>
                  {isRunning ? (
                    <SidebarRunningGhost />
                  ) : (
                    <span className="sidebar-run-status tone-muted">Queued</span>
                  )}
                </button>
                {onOpenChatPopout && (
                  <SidebarOverflowMenu
                    triggerLabel="Thread actions"
                    items={createSidebarChatPopoutActions(chat, onOpenChatPopout)}
                  />
                )}
                {!isTransitionFallback && onAddRunQueueJobToWorkspaceBoard && job.workspaceId && (
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

export function deriveVisibleActiveRunEntries(input: {
  jobs: readonly RunQueueJob[]
  chats: readonly ChatRecord[]
  surface?: ActiveRunsSurface
  workChatIds?: ReadonlySet<string>
}): ActiveRunEntry[] {
  const workChatIds = input.workChatIds || new Set<string>()
  const chatsById = new Map(input.chats.map((chat) => [chat.appChatId, chat]))
  const visible: ActiveRunEntry[] = []

  for (const job of input.jobs) {
    if (!isActiveQueueStatus(job.status)) continue
    const directChat = resolveActiveRunChat(job, input.chats)
    if (!directChat || !isJobBackedByLiveChat(job, directChat)) continue
    const chat = resolveActiveRunParentThread(directChat, chatsById)
    if (!chat) continue
    if (input.surface && !isActiveRunVisibleOnSurface(job, chat, input.surface, workChatIds)) {
      continue
    }
    addVisibleActiveRunEntry(visible, { job, chat, isTransitionFallback: false })
  }

  for (const directChat of input.chats) {
    const fallback = transitionFallbackEntry(directChat)
    if (!fallback) continue
    const chat = resolveActiveRunParentThread(directChat, chatsById)
    if (!chat) continue
    if (
      input.surface &&
      !isActiveRunVisibleOnSurface(fallback.job, chat, input.surface, workChatIds)
    ) {
      continue
    }
    addVisibleActiveRunEntry(visible, { ...fallback, chat })
  }
  return visible
}

function addVisibleActiveRunEntry(visible: ActiveRunEntry[], entry: ActiveRunEntry): void {
  const existingIndex = visible.findIndex(
    (current) => current.chat.appChatId === entry.chat.appChatId
  )
  if (existingIndex < 0) {
    visible.push(entry)
    return
  }

  const existing = visible[existingIndex]
  if (
    !entry.isTransitionFallback &&
    activeRunStatusPriority(entry.job.status) > activeRunStatusPriority(existing.job.status)
  ) {
    visible[existingIndex] = entry
  }
}

function activeRunStatusPriority(status: ActiveRunQueueStatus): number {
  if (status === 'active') return 4
  if (status === 'starting' || status === 'promoting' || status === 'steer_promoting') return 3
  return 2
}

/** Keep the Active Runs surface at the user's thread granularity. A delegated
 * sub-thread or fan-out side chat is represented by its parent; ordinary side
 * chats remain independently visible. This is presentation-only and never
 * alters the child or lane lifecycle. */
function resolveActiveRunParentThread(
  chat: ChatRecord,
  chatsById: ReadonlyMap<string, ChatRecord>
): ChatRecord | null {
  let current = chat
  const seenChatIds = new Set([current.appChatId])
  while (shouldProjectActiveRunToParent(current)) {
    const parentChatId = current.parentChatId
    if (!parentChatId || seenChatIds.has(parentChatId)) return null
    const parent = chatsById.get(parentChatId)
    if (!parent) return null
    seenChatIds.add(parentChatId)
    current = parent
  }
  return current
}

function shouldProjectActiveRunToParent(chat: ChatRecord): boolean {
  if (!chat.parentChatId) return false
  return (
    chat.parentChatRelation === undefined ||
    chat.parentChatRelation === 'subThread' ||
    (chat.parentChatRelation === 'sideChat' && chat.sideChatContext?.mode === 'fanOut')
  )
}

function transitionFallbackEntry(
  chat: ChatRecord
): Pick<ActiveRunEntry, 'job' | 'isTransitionFallback'> | null {
  const round = chat.ensemble?.activeRound
  const transition = round?.turnTransition
  if (!round || !transition || !isEnsembleRoundPresentationLive(round)) return null

  const participantId = transition.targetParticipantId || transition.sourceParticipantId
  const configuredParticipant = chat.ensemble?.participants.find(
    (participant) => participant.id === participantId
  )
  const roundParticipant = round.participants.find(
    (participant) => participant.participantId === participantId
  )
  const provider = configuredParticipant?.provider || roundParticipant?.provider || chat.provider
  if (!provider) return null
  const job: RunQueueJob = {
    id: `ensemble-transition:${chat.appChatId}:${round.roundId}`,
    runId: transition.sourceRunId,
    provider,
    ...(participantId ? { ensembleParticipantId: participantId } : {}),
    ...(configuredParticipant?.role || roundParticipant?.role
      ? { ensembleRole: configuredParticipant?.role || roundParticipant?.role }
      : {}),
    scope: chat.scope,
    workspaceId: chat.workspaceId,
    workspacePath: chat.workspacePath,
    chatId: chat.appChatId,
    source: 'system',
    status: 'active',
    priority: 0,
    attempt: 1,
    promptPreview: round.prompt,
    createdAt: round.startedAt,
    updatedAt: transition.startedAt,
    startedAt: round.startedAt
  }
  return { job, isTransitionFallback: true }
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

function getWorkspaceShortName(job: RunQueueJob, chat: ChatRecord): string {
  if (chat.scope === 'global' || (!chat.scope && job.scope === 'global')) return 'General'
  const workspacePath = chat.workspacePath || job.workspacePath || ''
  const basename = workspacePath.split(/[\\/]/).filter(Boolean).pop()
  if (basename) return basename
  return chat.workspaceId || job.workspaceId || 'Unknown workspace'
}

/** Primary Active Runs label: chat title (fallback: prompt preview / Untitled). */
export function getActiveRunChatLabel(job: RunQueueJob, chat: ChatRecord | null): string {
  const title = chat?.title?.trim()
  if (title) return title
  const preview = job.promptPreview?.trim()
  if (preview) return preview
  return 'Untitled chat'
}

function getActiveRunThreadProvider(chat: ChatRecord): ProviderId | 'ensemble' {
  return chat.chatKind === 'ensemble' ? 'ensemble' : chat.provider || 'gemini'
}

function getActiveRunThreadStyle(provider: ProviderId | 'ensemble'): ActiveRunThreadStyle {
  return {
    '--chat-provider-accent': `var(--provider-${provider}-color, var(--accent))`
  }
}

function ActiveRunThreadProviderLabel({
  provider
}: {
  provider: ProviderId | 'ensemble'
}): JSX.Element {
  const label = provider === 'ensemble' ? 'Ensemble' : getProviderLabel(provider)
  return (
    <span className={`sidebar-provider-label provider-${provider}`}>
      <ProviderBrandLogoIcon provider={provider} />
      <span>{label}</span>
    </span>
  )
}
