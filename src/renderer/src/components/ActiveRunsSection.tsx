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
import { useHostProjection } from '../hooks/useHostProjection'
import { useHostCommandController, useHostProjectionStore } from './HostProjectionProvider'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
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
  /** Backed by the live Host projection, not a renderer queue job: the round
   * or run is Host-owned, so no queue poll or activeRunsRef entry sees it. */
  isHostProjection?: boolean
  /** Set when the entry is backed by a live Host ensemble round — the stop
   * affordance targets that round through the durable cancel path. */
  hostRoundId?: string
  /** Connection truth for a row whose activity came from the Host cache. */
  hostProjectionAvailability?: 'live' | 'loading' | 'unavailable'
  /** Exact work identity used by the canonical control authority. A round can
   * be cancelled by Desktop only while the local record names the same round;
   * Host-native runs use expectedWorkId to fail closed across a run rollover. */
  hostStopTarget?: {
    threadId: string
    roundId?: string
    expectedWorkId?: string
  }
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
  const [queueProjectionStatus, setQueueProjectionStatus] = useState<'live' | 'unavailable'>('live')
  const [localCollapsed, setLocalCollapsed] = useState(false)
  const collapsed = controlledCollapsed ?? localCollapsed
  // Idle gate: with nothing queued or running there are no elapsed labels to
  // advance, so the section neither joins the shared 1s tick (a Sync-lane
  // rerender every second) nor refetches the run queue on it. The chats /
  // runningKey / focus refreshes below still run, so a newly queued job
  // re-arms the tick on its next poll. Host-projection entries are exempt on
  // purpose: they rerender from the projection store's own subscription, so
  // a Host-owned round never needs this tick to stay current.
  const nowTick = useSharedNowTick(jobs.length > 0 || runningChatIds.length > 0)
  const hasObservedTick = useRef(false)
  const workChatIdSet = useMemo(() => new Set(workChatIds), [workChatIds])
  const runningKey = runningChatIds.join('|')
  const hostProjectionStore = useHostProjectionStore()
  const hostCommands = useHostCommandController()
  // refreshOnMount=false: the provider's continuity loop already polls Host —
  // a sidebar mount must not trigger an extra snapshot fetch of its own.
  const hostProjection = useHostProjection(hostProjectionStore, false)
  const [stopStatusByTarget, setStopStatusByTarget] = useState<
    ReadonlyMap<string, 'pending' | 'failed'>
  >(new Map())

  const handleStopHostActivity = useCallback(
    async (target: NonNullable<ActiveRunEntry['hostStopTarget']>) => {
      const pendingKey = `${target.threadId}:${target.roundId ?? target.expectedWorkId ?? ''}`
      setStopStatusByTarget((current) => new Map(current).set(pendingKey, 'pending'))
      let finalStatus: 'clear' | 'pending' | 'failed' = 'failed'
      try {
        let cancelledByDesktop = false
        if (target.roundId && typeof window.api?.cancelEnsembleRound === 'function') {
          const directChat = chats.find((candidate) => candidate.appChatId === target.threadId)
          const localRound = directChat?.ensemble?.activeRound
          // `cancelEnsembleRound` is chat-scoped, so the exact local round-id
          // check is the authority fence that prevents a stale Host row from
          // cancelling a newer round on the same thread.
          if (
            localRound?.roundId === target.roundId &&
            isEnsembleRoundPresentationLive(localRound)
          ) {
            cancelledByDesktop = await window.api.cancelEnsembleRound(target.threadId)
          }
        }
        if (cancelledByDesktop) finalStatus = 'clear'
        if (!cancelledByDesktop && target.expectedWorkId && hostCommands) {
          const outcome = await hostCommands.submit({
            name: 'run.cancel',
            target: { threadId: target.threadId },
            arguments: { expectedWorkId: target.expectedWorkId }
          })
          finalStatus =
            outcome.kind === 'terminal' && outcome.receipt.status === 'succeeded'
              ? 'clear'
              : outcome.kind === 'pending-timeout'
                ? 'pending'
                : 'failed'
        }
      } catch {
        // A rejected command leaves the activity unresolved. The next Host
        // projection decides what to display; this view never paints success.
      } finally {
        setStopStatusByTarget((current) => {
          const next = new Map(current)
          if (finalStatus === 'clear') next.delete(pendingKey)
          else next.set(pendingKey, finalStatus)
          return next
        })
      }
    },
    [chats, hostCommands]
  )

  const refresh = useCallback(async () => {
    if (typeof window.api.getRunQueueJobs !== 'function') return
    try {
      const result = await window.api.getRunQueueJobs({
        statuses: ACTIVE_STATUSES as unknown as RunQueueJobStatus[]
      })
      const next = Array.isArray(result) ? result : []
      setQueueProjectionStatus('live')
      // Keep the empty identity stable: an empty poll must not schedule a
      // render when the section already shows nothing.
      setJobs((current) => (current.length === 0 && next.length === 0 ? current : next))
    } catch {
      // A failed poll says the queue is unavailable, not empty. Retain the
      // last coherent rows and mark them explicitly below so a transient IPC
      // drop cannot flash a still-running provider to "No active runs".
      setQueueProjectionStatus('unavailable')
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
        workChatIds: workChatIdSet,
        hostProjection
      }),
    [chats, jobs, nowTick, surface, workChatIdSet, hostProjection]
  )
  const hostEmptyState = hostProjectionEmptyState(hostProjection, queueProjectionStatus)

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
              <span>{hostEmptyState}</span>
            </div>
          )}
          {visibleJobs.map(
            ({
              job,
              chat,
              isTransitionFallback,
              isHostProjection,
              hostProjectionAvailability,
              hostStopTarget
            }) => {
              const isCurrent = currentChat?.appChatId === chat.appChatId
              const hostStatusIsCurrent =
                !isHostProjection ||
                hostProjectionAvailability === undefined ||
                hostProjectionAvailability === 'live'
              const queueStatusUnavailable =
                !isHostProjection &&
                !isTransitionFallback &&
                queueProjectionStatus === 'unavailable' &&
                hostProjectionAvailability !== 'live'
              const isRunning =
                !queueStatusUnavailable &&
                hostStatusIsCurrent &&
                (isTransitionFallback || job.status !== 'queued')
              const isCheckingHost = isHostProjection && hostProjectionAvailability === 'loading'
              const provider = getActiveRunThreadProvider(chat)
              const title = getActiveRunChatLabel(job, chat)
              const activityLabel = isCheckingHost
                ? 'checking Host status'
                : queueStatusUnavailable
                  ? 'activity status unavailable'
                  : isHostProjection && hostProjectionAvailability === 'unavailable'
                    ? 'Host status unavailable'
                    : isRunning
                      ? 'running'
                      : 'queued'
              const pendingKey = hostStopTarget
                ? `${hostStopTarget.threadId}:${hostStopTarget.roundId ?? hostStopTarget.expectedWorkId ?? ''}`
                : ''
              const stopStatus = pendingKey ? stopStatusByTarget.get(pendingKey) : undefined
              return (
                <div key={job.id || job.runId} className="sidebar-active-run-entry">
                  <button
                    type="button"
                    className={`sidebar-active-run-row sidebar-active-run-thread provider-${provider} ${isCurrent ? 'active' : ''}`}
                    style={getActiveRunThreadStyle(provider)}
                    onClick={() => onSelectChat(chat)}
                    title={`${title} — ${getWorkspaceShortName(job, chat)}`}
                    aria-busy={isRunning || isCheckingHost || undefined}
                    aria-label={`${title}, ${activityLabel}`}
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
                    {queueStatusUnavailable ? (
                      <span className="sidebar-run-status tone-warning">
                        Activity status unavailable
                      </span>
                    ) : isHostProjection && hostProjectionAvailability === 'unavailable' ? (
                      <span className="sidebar-run-status tone-warning">
                        Host status unavailable
                      </span>
                    ) : isCheckingHost ? (
                      <span className="sidebar-run-status tone-muted">Checking Host status</span>
                    ) : isRunning ? (
                      <SidebarRunningGhost />
                    ) : (
                      <span className="sidebar-run-status tone-muted">Queued</span>
                    )}
                  </button>
                  {hostStopTarget && (
                    <button
                      type="button"
                      className="sidebar-active-run-board-action sidebar-active-run-stop-action"
                      onClick={() => void handleStopHostActivity(hostStopTarget)}
                      disabled={stopStatus === 'pending'}
                      title={
                        stopStatus === 'pending'
                          ? 'Stop pending'
                          : stopStatus === 'failed'
                            ? 'Stop failed — retry'
                            : hostStopTarget.roundId
                              ? 'Stop round'
                              : 'Stop run'
                      }
                      aria-label={
                        stopStatus === 'pending'
                          ? `Stop pending on ${title}`
                          : stopStatus === 'failed'
                            ? `Retry stopping ${title}`
                            : `Stop the live ${hostStopTarget.roundId ? 'round' : 'run'} on ${title}`
                      }
                    >
                      {stopStatus === 'pending' ? '…' : stopStatus === 'failed' ? '!' : '■'}
                    </button>
                  )}
                  {onOpenChatPopout && (
                    <SidebarOverflowMenu
                      triggerLabel="Thread actions"
                      items={createSidebarChatPopoutActions(chat, onOpenChatPopout)}
                    />
                  )}
                  {!isTransitionFallback &&
                    !isHostProjection &&
                    onAddRunQueueJobToWorkspaceBoard &&
                    job.workspaceId && (
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
            }
          )}
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
  hostProjection?: HostActiveRunsProjection | null
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

  for (const entry of deriveHostProjectionActiveRunEntries({
    hostProjection: input.hostProjection,
    chats: input.chats,
    surface: input.surface,
    workChatIds
  })) {
    addVisibleActiveRunEntry(visible, entry)
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
  if (entry.isHostProjection && !existing.isHostProjection) {
    // Queue/activity polls and Host snapshots are independent witnesses. Keep
    // the richer queue row, but join its exact Host control target so the Stop
    // action does not flicker away merely because the queue won a dedupe race.
    visible[existingIndex] = {
      ...existing,
      ...(entry.hostProjectionAvailability
        ? { hostProjectionAvailability: entry.hostProjectionAvailability }
        : {}),
      ...(entry.hostStopTarget ? { hostStopTarget: entry.hostStopTarget } : {})
    }
    return
  }
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
  const roundParticipant = (round.participants || []).find(
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

/** The slice of renderer Host projection state this surface reads. */
export type HostActiveRunsProjection = Pick<
  HostProjectionState,
  'status' | 'projection' | 'liveBaselineContinuity'
>

function hostProjectionActivityAvailability(
  state: HostActiveRunsProjection
): NonNullable<ActiveRunEntry['hostProjectionAvailability']> {
  if (state.status === 'loading') return 'loading'
  if (state.status === 'unavailable') return 'unavailable'
  return state.projection?.freshness === 'live' || state.liveBaselineContinuity === true
    ? 'live'
    : 'unavailable'
}

function hostProjectionEmptyState(
  state: HostActiveRunsProjection,
  queueProjectionStatus: 'live' | 'unavailable'
): string {
  if (state.status === 'loading') return 'Checking Host activity'
  if (state.status === 'unavailable') return 'Host activity unavailable'
  if (queueProjectionStatus === 'unavailable') return 'Activity status unavailable'
  if (
    state.status === 'live' &&
    state.projection?.freshness !== 'live' &&
    state.liveBaselineContinuity !== true
  ) {
    return 'Host activity unavailable'
  }
  return 'No active runs'
}

/**
 * Host-owned activity → Active Runs entries at the user's thread granularity.
 *
 * A Host-dispatched ensemble round (or solo Host run) never creates a renderer
 * queue job and never lands in activeRunsRef, so without this the section
 * paints "No active runs" while a Host-owned round is live. Rounds win over
 * individual runs on the same thread, and one thread yields at most one entry
 * — six participant runs of one round are one row, not six.
 *
 * Honesty rule: a retained projection remains visible when connectivity drops,
 * but its row is explicitly unavailable and carries no control target. That
 * preserves the last observation without rewriting unknown as idle/completed.
 */
export function deriveHostProjectionActiveRunEntries(input: {
  hostProjection: HostActiveRunsProjection | null | undefined
  chats: readonly ChatRecord[]
  surface?: ActiveRunsSurface
  workChatIds?: ReadonlySet<string>
}): ActiveRunEntry[] {
  const state = input.hostProjection
  if (!state || state.status === 'idle') return []
  const projection = state.projection
  if (!projection) return []
  const hostProjectionAvailability = hostProjectionActivityAvailability(state)

  const workChatIds = input.workChatIds || new Set<string>()
  const chatsById = new Map(input.chats.map((chat) => [chat.appChatId, chat]))
  const entries: ActiveRunEntry[] = []
  const coveredChatIds = new Set<string>()
  const runningRunsById = new Map(
    projection.runs
      .filter((run) => run.providerOutcome === 'running')
      .map((run) => [run.runId, run])
  )

  const addHostEntry = (entry: {
    threadId: string
    id: string
    runId: string
    startedAt?: number
    hostRoundId?: string
    hostStopTarget?: ActiveRunEntry['hostStopTarget']
    availability?: ActiveRunEntry['hostProjectionAvailability']
  }): void => {
    const directChat = chatsById.get(entry.threadId)
    if (!directChat) return
    const chat = resolveActiveRunParentThread(directChat, chatsById)
    if (!chat || coveredChatIds.has(chat.appChatId)) return
    const job = hostProjectionRunQueueJob({
      id: entry.id,
      runId: entry.runId,
      chat: directChat,
      startedAt: entry.startedAt
    })
    if (input.surface && !isActiveRunVisibleOnSurface(job, chat, input.surface, workChatIds)) {
      return
    }
    entries.push({
      job,
      chat,
      isTransitionFallback: false,
      isHostProjection: true,
      hostProjectionAvailability: entry.availability ?? hostProjectionAvailability,
      ...(entry.hostRoundId ? { hostRoundId: entry.hostRoundId } : {}),
      ...(entry.hostStopTarget ? { hostStopTarget: entry.hostStopTarget } : {})
    })
    coveredChatIds.add(chat.appChatId)
  }

  for (const round of projection.rounds) {
    const unresolved =
      round.status === 'unknown' && round.endedAt === undefined && round.startedAt !== undefined
    if (round.status !== 'running' && !unresolved) continue
    const directChat = chatsById.get(round.threadId)
    const localRound = directChat?.ensemble?.activeRound
    const desktopOwnsExactRound =
      localRound?.roundId === round.roundId && isEnsembleRoundPresentationLive(localRound)
    const linkedRunningRun =
      round.providerRunIds.map((runId) => runningRunsById.get(runId)).find(Boolean) ??
      projection.runs.find(
        (run) => run.threadId === round.threadId && run.providerOutcome === 'running'
      )
    const hostStopTarget =
      desktopOwnsExactRound || linkedRunningRun
        ? {
            threadId: round.threadId,
            roundId: round.roundId,
            ...(linkedRunningRun ? { expectedWorkId: linkedRunningRun.runId } : {})
          }
        : undefined
    addHostEntry({
      threadId: round.threadId,
      id: `host-round:${round.roundId}`,
      runId: round.providerRunIds[0] || round.roundId,
      startedAt: round.startedAt,
      hostRoundId: round.roundId,
      ...(unresolved ? { availability: 'unavailable' as const } : {}),
      ...(hostStopTarget ? { hostStopTarget } : {})
    })
  }

  for (const run of projection.runs) {
    const unresolved =
      run.providerOutcome === 'unknown' && run.endedAt === undefined && run.startedAt !== undefined
    if (run.providerOutcome !== 'running' && !unresolved) continue
    addHostEntry({
      threadId: run.threadId,
      id: `host-run:${run.runId}`,
      runId: run.runId,
      startedAt: run.startedAt,
      ...(unresolved ? { availability: 'unavailable' as const } : {}),
      hostStopTarget: {
        threadId: run.threadId,
        expectedWorkId: run.runId
      }
    })
  }

  return entries
}

/** Synthetic presentation-only job for a Host-projection entry. Never
 * persisted and never leased — the Host journal stays the run's authority. */
function hostProjectionRunQueueJob(input: {
  id: string
  runId: string
  chat: ChatRecord
  startedAt?: number
}): RunQueueJob {
  const startedAt =
    typeof input.startedAt === 'number' && Number.isFinite(input.startedAt) && input.startedAt > 0
      ? new Date(input.startedAt).toISOString()
      : undefined
  return {
    id: input.id,
    runId: input.runId,
    provider: input.chat.provider || 'gemini',
    scope: input.chat.scope,
    workspaceId: input.chat.workspaceId,
    workspacePath: input.chat.workspacePath,
    chatId: input.chat.appChatId,
    source: 'system',
    status: 'active',
    priority: 0,
    attempt: 1,
    createdAt: startedAt || '',
    updatedAt: startedAt || '',
    ...(startedAt ? { startedAt } : {})
  }
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
