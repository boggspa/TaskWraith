import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode
} from 'react'
import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { CanvasBrowserChrome } from './CanvasBrowserChrome'
import { CanvasPane } from './CanvasPane'
import { ChatMediaDockPanel, type ChatMediaRef } from './ChatMediaPanel'
import {
  ChatMediaIcon,
  GitCommitSymbolIcon,
  PlusSymbolIcon,
  SidebarRunningGhost,
  XSymbolIcon
} from './AppChromeSymbols'
import { DigitOdometer } from './DigitOdometer'
import { MeshCanvasPanel, type MeshCanvasPanelHandle } from './MeshCanvasPanel'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { SimulatorCanvasPanel } from './SimulatorCanvasPanel'
import { TelemetryCanvasPanel } from './TelemetryCanvasPanel'
import { isSubThreadChat } from '../lib/chatScope'
import { getProviderLabel } from '../lib/providerLabels'
import { selectRecentChats } from '../lib/recentChatsList'
import { threadHomeRunStats, type ThreadHomeRunStats } from '../lib/threadHomeActivityStats'
import { isHideableUnstartedDraft } from '../lib/unstartedDraftFilter'

export type ThreadHomeSurface = 'charts' | 'browser' | 'mesh' | 'sketch' | 'media' | 'simulator'

export interface ThreadHomeSurfaceOption {
  id: ThreadHomeSurface
  label: string
  description: string
}

export const THREAD_HOME_SURFACES: readonly ThreadHomeSurfaceOption[] = [
  { id: 'charts', label: 'Graphs & charts', description: 'Inspect structured telemetry canvases' },
  { id: 'browser', label: 'Browser', description: 'Open a blank TaskWraith browser' },
  { id: 'mesh', label: 'Mesh', description: 'Inspect and author 3D scenes' },
  { id: 'sketch', label: 'Sketch', description: 'Shapes, arrows, freehand, and text' },
  { id: 'media', label: 'Media', description: 'Browse this thread’s uploads and paths' },
  { id: 'simulator', label: 'Simulator', description: 'Preview and control an iOS app' }
]

export interface ThreadHomeThreadOption {
  chatId: string
  title: string
  provider: ProviderId | 'ensemble'
  workspaceLabel: string
  running: boolean
  stats?: ThreadHomeRunStats
  paneIndex?: number
}

/** Existing home-screen surfaces composed into the full Thread Home. */
export interface ThreadHomeOverviewSections {
  heatmaps?: ReactNode
}

export const THREAD_HOME_RECENT_LIMIT = 6

function workspaceLabelForChat(chat: ChatRecord): string {
  if (chat.scope === 'global') return 'General'
  const basename = (chat.workspacePath || '').split(/[\\/]/).filter(Boolean).pop()
  return basename || chat.workspaceId || 'Workspace'
}

/**
 * Project only the thread ids already admitted by the sidebar's live-run
 * authority. Pane/current selection may annotate a live row, but cannot add it.
 */
export function buildThreadHomeThreadOptions(input: {
  chats: readonly ChatRecord[]
  runningChatIds: readonly string[]
  paneChatIds: readonly (string | null)[]
}): ThreadHomeThreadOption[] {
  const chatsById = new Map(
    input.chats.filter((chat) => !chat.archived).map((chat) => [chat.appChatId, chat])
  )
  const running = new Set(input.runningChatIds)
  const paneIndexByChatId = new Map<string, number>()
  input.paneChatIds.forEach((chatId, paneIndex) => {
    if (chatId && !paneIndexByChatId.has(chatId)) paneIndexByChatId.set(chatId, paneIndex)
  })

  const orderedIds = [...new Set(input.runningChatIds)].filter((chatId) => chatsById.has(chatId))

  return orderedIds.map((chatId) => {
    const chat = chatsById.get(chatId)!
    const stats = threadHomeRunStats(chat)
    return {
      chatId,
      title: chat.title?.trim() || 'Untitled thread',
      provider: chat.chatKind === 'ensemble' ? 'ensemble' : chat.provider || 'gemini',
      workspaceLabel: workspaceLabelForChat(chat),
      running: running.has(chatId),
      ...(stats ? { stats } : {}),
      ...(paneIndexByChatId.has(chatId) ? { paneIndex: paneIndexByChatId.get(chatId) } : {})
    }
  })
}

/** Sidebar-parity recency, excluding live rows and non-primary/draft surfaces. */
export function buildThreadHomeRecentThreadOptions(input: {
  chats: readonly ChatRecord[]
  runningChatIds: readonly string[]
  paneChatIds: readonly (string | null)[]
}): ThreadHomeThreadOption[] {
  const running = new Set(input.runningChatIds)
  const paneIndexByChatId = new Map<string, number>()
  input.paneChatIds.forEach((chatId, paneIndex) => {
    if (chatId && !paneIndexByChatId.has(chatId)) paneIndexByChatId.set(chatId, paneIndex)
  })
  const recent = selectRecentChats(
    input.chats.filter(
      (chat) =>
        !running.has(chat.appChatId) &&
        !chat.hiddenFromMainList &&
        !isSubThreadChat(chat) &&
        chat.parentChatRelation !== 'sideChat' &&
        !isHideableUnstartedDraft(chat)
    ),
    { limit: THREAD_HOME_RECENT_LIMIT }
  )
  return recent.map((chat) => ({
    chatId: chat.appChatId,
    title: chat.title?.trim() || 'Untitled thread',
    provider: chat.chatKind === 'ensemble' ? 'ensemble' : chat.provider || 'gemini',
    workspaceLabel: workspaceLabelForChat(chat),
    running: false,
    ...(paneIndexByChatId.has(chat.appChatId)
      ? { paneIndex: paneIndexByChatId.get(chat.appChatId) }
      : {})
  }))
}

function ThreadHomeSurfaceGlyph({ surface }: { surface: ThreadHomeSurface }): ReactNode {
  if (surface === 'media') return <ChatMediaIcon />
  if (surface === 'browser') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden>
        <circle cx="10" cy="10" r="7.25" />
        <path d="M2.9 10h14.2M10 2.75c2 2.1 3.05 4.52 3.05 7.25S12 15.15 10 17.25C8 15.15 6.95 12.73 6.95 10S8 4.85 10 2.75Z" />
      </svg>
    )
  }
  const path = {
    charts: 'M3 15V9m4 6V5m4 10v-3m4 3V2M2 17h16',
    mesh: 'm10 2.8 6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4L10 2.8Zm0 7.2 6.1-3.5M10 10 3.9 6.5M10 10v7',
    sketch:
      'm4 14.9.55-3.25L12.7 3.5a1.55 1.55 0 0 1 2.2 0l1.6 1.6a1.55 1.55 0 0 1 0 2.2l-8.15 8.15L5.1 16 4 14.9Z',
    simulator: 'M6 2.75h8v14.5H6zM8.4 5h3.2M9.2 15h1.6'
  }[surface]
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d={path} />
    </svg>
  )
}

export interface ThreadHomeProps {
  variant: 'main' | 'pane'
  threads: readonly ThreadHomeThreadOption[]
  recentThreads: readonly ThreadHomeThreadOption[]
  authorityChatId?: string | null
  mediaCount?: number
  busySurface?: ThreadHomeSurface | null
  issue?: string | null
  overviewSections?: ThreadHomeOverviewSections
  onNewChat: () => void
  onSelectThread: (chatId: string) => void
  onSelectSurface: (surface: ThreadHomeSurface) => void
  onClosePane?: () => void
  onActivate?: () => void
}

/** Thread and utility launcher shared by the single-pane home and empty cells. */
export function ThreadHome({
  variant,
  threads,
  recentThreads,
  authorityChatId,
  mediaCount = 0,
  busySurface,
  issue,
  overviewSections,
  onNewChat,
  onSelectThread,
  onSelectSurface,
  onClosePane,
  onActivate
}: ThreadHomeProps) {
  const surfaceDisabled = !authorityChatId || Boolean(busySurface)
  const showOverviewSections = variant === 'main' && Boolean(overviewSections?.heatmaps)
  const renderThreadRow = (thread: ThreadHomeThreadOption) => (
    <button
      key={thread.chatId}
      type="button"
      className={`thread-home-thread-row provider-${thread.provider}`}
      onClick={() => onSelectThread(thread.chatId)}
      aria-label={threadHomeThreadAriaLabel(thread)}
    >
      <span className="thread-home-thread-provider" aria-hidden>
        <ProviderBrandLogoIcon provider={thread.provider} />
      </span>
      <span className="thread-home-thread-copy">
        <strong>{thread.title}</strong>
        <span className="thread-home-thread-subline">
          <small>
            {thread.workspaceLabel}
            {thread.paneIndex !== undefined ? ` · Pane ${thread.paneIndex + 1}` : ''}
          </small>
          {thread.stats && <ThreadHomeStats stats={thread.stats} />}
        </span>
      </span>
      {thread.running ? (
        <SidebarRunningGhost />
      ) : (
        <span className="thread-home-thread-provider-label">
          {thread.provider === 'ensemble' ? 'Ensemble' : getProviderLabel(thread.provider)}
        </span>
      )}
    </button>
  )
  return (
    <section
      className={`thread-home thread-home--${variant}`}
      aria-label="Thread Home"
      onPointerDownCapture={onActivate}
    >
      {onClosePane && (
        <div className="thread-home-pane-actions chat-corner-controls chat-corner-controls-right">
          <button
            type="button"
            className="chat-corner-btn"
            onClick={onClosePane}
            title="Close empty pane"
            aria-label="Close empty pane"
          >
            <XSymbolIcon />
          </button>
        </div>
      )}
      <div
        className={`thread-home-scroll${
          showOverviewSections ? ' thread-home-scroll--with-overview' : ''
        }`}
      >
        <section className="thread-home-section" aria-label="Active threads">
          <div className="thread-home-thread-list">
            <button
              type="button"
              className="thread-home-thread-row thread-home-new-chat-row"
              onClick={onNewChat}
              aria-label="New Chat"
            >
              <span className="thread-home-thread-provider" aria-hidden>
                <PlusSymbolIcon />
              </span>
              <span className="thread-home-thread-copy">
                <strong>New Chat</strong>
                <small>Start a new thread</small>
              </span>
              <span className="thread-home-thread-provider-label">New</span>
            </button>
            <div className="thread-home-list-heading" role="heading" aria-level={3}>
              Active
            </div>
            {threads.map(renderThreadRow)}
            <div className="thread-home-list-heading" role="heading" aria-level={3}>
              Recents
            </div>
            {recentThreads.map(renderThreadRow)}
            {recentThreads.length === 0 && (
              <div className="thread-home-empty-copy">No recent threads yet.</div>
            )}
          </div>
        </section>

        <section className="thread-home-section" aria-label="Thread tools">
          <div className="thread-home-list-heading" role="heading" aria-level={3}>
            Canvas
          </div>
          <div className="thread-home-surface-grid">
            {THREAD_HOME_SURFACES.map((surface) => (
              <button
                key={surface.id}
                type="button"
                className="thread-home-surface-card"
                disabled={surfaceDisabled}
                onClick={() => onSelectSurface(surface.id)}
                aria-label={`${surface.label}. ${surface.description}`}
              >
                <span className="thread-home-surface-icon">
                  <ThreadHomeSurfaceGlyph surface={surface.id} />
                </span>
                <span>
                  <strong>{surface.label}</strong>
                  <small>{surface.description}</small>
                </span>
                {surface.id === 'media' && mediaCount > 0 && (
                  <em aria-label={`${mediaCount} media items`}>
                    {mediaCount > 99 ? '99+' : mediaCount}
                  </em>
                )}
              </button>
            ))}
          </div>
          {busySurface && <div className="thread-home-status">Opening {busySurface}…</div>}
          {issue && (
            <div className="thread-home-issue" role="alert">
              {issue}
            </div>
          )}
        </section>
        {showOverviewSections && overviewSections?.heatmaps && (
          <section className="thread-home-heatmaps-region" aria-label="Activity heatmaps">
            {overviewSections.heatmaps}
          </section>
        )}
      </div>
    </section>
  )
}

function threadHomeStatsLabel(stats: ThreadHomeRunStats): string {
  return [
    `${stats.filesChanged} changed file${stats.filesChanged === 1 ? '' : 's'}`,
    ...(stats.hasLineStats ? [`${stats.additions} additions`, `${stats.deletions} deletions`] : []),
    `${stats.commits} commit${stats.commits === 1 ? '' : 's'}`
  ].join(', ')
}

function threadHomeThreadAriaLabel(thread: ThreadHomeThreadOption): string {
  const state = thread.running
    ? 'running'
    : thread.paneIndex !== undefined
      ? `pane ${thread.paneIndex + 1}`
      : 'thread'
  return `${thread.title}, ${state}${thread.stats ? `, ${threadHomeStatsLabel(thread.stats)}` : ''}`
}

function ThreadHomeStats({ stats }: { stats: ThreadHomeRunStats }) {
  return (
    <span className="thread-home-run-stats" aria-label={threadHomeStatsLabel(stats)}>
      {stats.filesChanged > 0 && <span>{stats.filesChanged}f</span>}
      {stats.hasLineStats && (
        <>
          <span className="workspace-stats-addition">
            <DigitOdometer value={stats.additions} sign="+" />
          </span>
          <span className="workspace-stats-deletion">
            <DigitOdometer value={stats.deletions} sign="-" />
          </span>
        </>
      )}
      {stats.commits > 0 && (
        <span className="thread-home-run-commits">
          <GitCommitSymbolIcon />
          <DigitOdometer value={stats.commits} ariaLabel={`${stats.commits} commits`} />
        </span>
      )}
    </span>
  )
}

interface ThreadHomeChartSummary {
  canvasId: string
  title: string
}

function decodeChartSummaries(value: unknown): ThreadHomeChartSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    if (
      !record ||
      record.driver !== 'chart' ||
      record.status === 'closed' ||
      typeof record.canvasId !== 'string'
    ) {
      return []
    }
    return [
      {
        canvasId: record.canvasId,
        title: typeof record.title === 'string' && record.title ? record.title : 'Chart'
      }
    ]
  })
}

export function ThreadHomeCharts({ chatId }: { chatId: string }) {
  const [charts, setCharts] = useState<ThreadHomeChartSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = decodeChartSummaries(await window.api.canvas?.listForChat?.(chatId))
      setCharts(next)
      setSelectedId((current) =>
        next.some((chart) => chart.canvasId === current) ? current : (next[0]?.canvasId ?? '')
      )
    } finally {
      setLoaded(true)
    }
  }, [chatId])
  useEffect(() => {
    void refresh()
    const off = window.api.canvas?.onEvent?.((event) => {
      const record = event && typeof event === 'object' ? (event as Record<string, unknown>) : null
      if (record?.chatId === chatId) void refresh()
    })
    return () => off?.()
  }, [chatId, refresh])

  const selected = charts.find((chart) => chart.canvasId === selectedId) || charts[0]
  if (!loaded) return <div className="thread-home-surface-empty">Loading charts…</div>
  if (!selected) {
    return (
      <div className="thread-home-surface-empty">
        Charts created by agents for this thread will appear here.
      </div>
    )
  }
  return (
    <div className="thread-home-charts">
      {charts.length > 1 && (
        <div className="thread-home-chart-tabs" role="tablist" aria-label="Thread charts">
          {charts.map((chart) => (
            <button
              key={chart.canvasId}
              type="button"
              role="tab"
              aria-selected={chart.canvasId === selected.canvasId}
              onClick={() => setSelectedId(chart.canvasId)}
            >
              {chart.title}
            </button>
          ))}
        </div>
      )}
      <TelemetryCanvasPanel chatId={chatId} canvasId={selected.canvasId} title={selected.title} />
    </div>
  )
}

export interface ThreadHomeWorkspaceProps {
  variant: 'main' | 'pane'
  chats: readonly ChatRecord[]
  runningChatIds: readonly string[]
  paneChatIds: readonly (string | null)[]
  authorityChat: ChatRecord | null
  mediaRefs: ChatMediaRef[]
  overviewSections?: ThreadHomeOverviewSections
  onNewChat: () => void
  onSelectThread: (chatId: string) => void
  onClosePane?: () => void
  onActivate?: () => void
  onPreviewImage?: (ref: ChatMediaRef) => void
  onDetachToPane?: (ref: ChatMediaRef) => void
}

export interface ThreadHomeWorkspaceHandle {
  closeCurrentPane: () => void
}

export interface ThreadHomeCanvasOpenSuccess {
  ok: true
  canvasId: string
  url: string
  title: string
}

export type ThreadHomeCanvasOpenResult =
  | ThreadHomeCanvasOpenSuccess
  | { ok: false; error?: string }
  | undefined

/** Settle one embedded-canvas request without leaking a late successful view. */
export async function settleThreadHomeCanvasOpen(input: {
  request: Promise<ThreadHomeCanvasOpenResult>
  isCurrent: () => boolean
  fallbackError: string
  onAccepted: (result: ThreadHomeCanvasOpenSuccess) => void
  onRejected: (message: string) => void
  onDiscarded: (canvasId: string) => void | Promise<unknown>
}): Promise<void> {
  try {
    const result = await input.request
    if (!result?.ok) {
      if (input.isCurrent()) input.onRejected(result?.error || input.fallbackError)
      return
    }
    if (!input.isCurrent()) {
      try {
        await input.onDiscarded(result.canvasId)
      } catch {
        // Best-effort cleanup: the view may already have been closed by main.
      }
      return
    }
    input.onAccepted(result)
  } catch (error) {
    if (input.isCurrent()) {
      input.onRejected(error instanceof Error ? error.message : input.fallbackError)
    }
  }
}

/** Stateful host for one independent Thread Home instance. */
function ThreadHomeWorkspaceInner(
  {
    variant,
    chats,
    runningChatIds,
    paneChatIds,
    authorityChat,
    mediaRefs,
    overviewSections,
    onNewChat,
    onSelectThread,
    onClosePane,
    onActivate,
    onPreviewImage,
    onDetachToPane
  }: ThreadHomeWorkspaceProps,
  ref: ForwardedRef<ThreadHomeWorkspaceHandle>
) {
  const [surface, setSurface] = useState<ThreadHomeSurface | null>(null)
  const [busySurface, setBusySurface] = useState<ThreadHomeSurface | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [canvas, setCanvas] = useState<{
    canvasId: string
    kind: 'browser' | 'sketch'
    url: string
    title: string
  } | null>(null)
  const canvasIdRef = useRef<string | null>(null)
  const meshCanvasPanelRef = useRef<MeshCanvasPanelHandle>(null)
  const mountedRef = useRef(false)
  const canvasOpenGenerationRef = useRef(0)
  canvasIdRef.current = canvas?.canvasId ?? null
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      canvasOpenGenerationRef.current += 1
      const canvasId = canvasIdRef.current
      if (canvasId) void window.api.canvas?.close?.(canvasId).catch(() => undefined)
    }
  }, [])

  const authorityChatId = authorityChat?.appChatId ?? null
  const { threads, recentThreads } = useMemo(
    () => ({
      threads: buildThreadHomeThreadOptions({
        chats,
        runningChatIds,
        paneChatIds
      }),
      recentThreads: buildThreadHomeRecentThreadOptions({
        chats,
        runningChatIds,
        paneChatIds
      })
    }),
    [chats, paneChatIds, runningChatIds]
  )

  const closeSurface = useCallback((): void => {
    canvasOpenGenerationRef.current += 1
    const canvasId = canvasIdRef.current
    canvasIdRef.current = null
    setCanvas(null)
    setSurface(null)
    setBusySurface(null)
    setIssue(null)
    if (canvasId) void window.api.canvas?.close?.(canvasId).catch(() => undefined)
  }, [])

  const closeCurrentSurface = useCallback((): void => {
    if (surface === 'mesh' && meshCanvasPanelRef.current) {
      void meshCanvasPanelRef.current.dismiss()
      return
    }
    closeSurface()
  }, [closeSurface, surface])

  useImperativeHandle(
    ref,
    () => ({
      closeCurrentPane: () => {
        if (surface) {
          closeCurrentSurface()
          return
        }
        if (authorityChatId) {
          onSelectThread(authorityChatId)
          return
        }
        onClosePane?.()
      }
    }),
    [authorityChatId, closeCurrentSurface, onClosePane, onSelectThread, surface]
  )

  const openSurface = async (next: ThreadHomeSurface): Promise<void> => {
    if (!authorityChatId) return
    setIssue(null)
    if (next !== 'browser' && next !== 'sketch') {
      canvasOpenGenerationRef.current += 1
      setSurface(next)
      return
    }
    const generation = canvasOpenGenerationRef.current + 1
    canvasOpenGenerationRef.current = generation
    setBusySurface(next)
    const api = window.api.canvas
    const request = Promise.resolve(
      next === 'sketch'
        ? api?.openSketchEmbedded?.({ chatId: authorityChatId })
        : api?.openEmbedded?.({ chatId: authorityChatId })
    ).then<ThreadHomeCanvasOpenResult>((result) =>
      result?.ok
        ? {
            ok: true,
            canvasId: result.canvasId,
            url: result.url,
            title: result.title
          }
        : { ok: false, error: result?.error }
    )
    const isCurrent = (): boolean =>
      mountedRef.current && canvasOpenGenerationRef.current === generation
    await settleThreadHomeCanvasOpen({
      request,
      isCurrent,
      fallbackError: `Could not open ${next}.`,
      onAccepted: (result) => {
        canvasIdRef.current = result.canvasId
        setCanvas({
          canvasId: result.canvasId,
          kind: next,
          url: result.url,
          title: result.title
        })
        setSurface(next)
      },
      onRejected: setIssue,
      onDiscarded: (canvasId) => window.api.canvas?.close?.(canvasId)
    })
    if (isCurrent()) setBusySurface(null)
  }

  if (!surface || !authorityChatId || !authorityChat) {
    return (
      <ThreadHome
        variant={variant}
        threads={threads}
        recentThreads={recentThreads}
        authorityChatId={authorityChatId}
        mediaCount={mediaRefs.length}
        busySurface={busySurface}
        issue={issue}
        overviewSections={overviewSections}
        onNewChat={onNewChat}
        onSelectThread={onSelectThread}
        onSelectSurface={(next) => void openSurface(next)}
        onClosePane={onClosePane}
        onActivate={onActivate}
      />
    )
  }

  const surfaceLabel =
    THREAD_HOME_SURFACES.find((option) => option.id === surface)?.label || surface
  return (
    <section
      className={`thread-home-surface thread-home-surface--${variant}`}
      aria-label={surfaceLabel}
    >
      <header className="thread-home-surface-toolbar">
        <button type="button" onClick={closeCurrentSurface} aria-label="Back to Thread Home">
          ‹
        </button>
        <strong>{surfaceLabel}</strong>
        <span>{authorityChat.title || 'Untitled thread'}</span>
      </header>
      <div className="thread-home-surface-body">
        {surface === 'charts' && <ThreadHomeCharts chatId={authorityChatId} />}
        {surface === 'media' && (
          <ChatMediaDockPanel
            refs={mediaRefs}
            workspacePath={authorityChat.workspacePath}
            onClose={closeSurface}
            onPreviewImage={onPreviewImage}
            onDetachToPane={onDetachToPane}
          />
        )}
        {surface === 'mesh' && (
          <MeshCanvasPanel
            ref={meshCanvasPanelRef}
            chatId={authorityChatId}
            onDismiss={closeSurface}
          />
        )}
        {surface === 'simulator' && <SimulatorCanvasPanel chatId={authorityChatId} />}
        {(surface === 'browser' || surface === 'sketch') && canvas && (
          <CanvasPane
            canvasId={canvas.canvasId}
            title={canvas.title || (surface === 'browser' ? 'Browser' : 'Sketch')}
            url={canvas.url}
            overlayGuard
            chrome={
              surface === 'browser' ? (
                <CanvasBrowserChrome
                  chatId={authorityChatId}
                  canvasId={canvas.canvasId}
                  initialState={{
                    url: canvas.url,
                    title: canvas.title,
                    isLoading: false,
                    canGoBack: false,
                    canGoForward: false
                  }}
                  onNavigateError={setIssue}
                />
              ) : undefined
            }
            onClose={closeSurface}
          />
        )}
      </div>
      {issue && (
        <div className="thread-home-surface-issue" role="alert">
          {issue}
        </div>
      )}
    </section>
  )
}

export const ThreadHomeWorkspace = forwardRef(ThreadHomeWorkspaceInner)
