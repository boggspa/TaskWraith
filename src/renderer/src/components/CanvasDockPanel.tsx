/**
 * CanvasDockPanel — the right-dock "Canvas" surface: the sidebar variant of the
 * floating Canvas windows. Hosts live-embedded web previews and the sketch board
 * over the dock region (via CanvasPane bounds reporting), and lists every other
 * canvas open in the chat — including agent-opened ones (canvas_open /
 * canvas_render_html) — so agent browser activity is visible without hunting for
 * floating windows.
 *
 * Dock-opened sessions are tracked in a module store (persisted per chat in
 * localStorage) so they survive tab switches and window reloads; on mount the
 * store reconciles against the live canvas list and silently drops sessions
 * whose backing canvas is gone (app restart).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CanvasBrowserChrome } from './CanvasBrowserChrome'
import { CanvasPane } from './CanvasPane'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'
import { friendlyCanvasError } from './CanvasComposerButton'
import { isNavigableCanvasUrl } from '../lib/canvasBrowserUrl'
import {
  isCanvasDockPresentationEvent,
  selectUnownedDockPresentations
} from '../lib/canvasPresentation'
import {
  consumeMeshCanvasOpenRequest,
  getPendingMeshCanvasOpenRequest,
  subscribeMeshCanvasOpenRequests
} from '../lib/meshCanvasLaunch'
import {
  consumeSimulatorCanvasOpenRequest,
  getPendingSimulatorCanvasOpenRequest,
  subscribeSimulatorCanvasOpenRequests
} from '../lib/simulatorCanvasLaunch'
import { shouldOpenMeshFromChatRehydrate } from '../lib/simulatorCanvasPanelHelpers'
import { MeshCanvasPanel, toMeshSceneSummary } from './MeshCanvasPanel'
import { SimulatorCanvasPanel } from './SimulatorCanvasPanel'

export type CanvasDockSessionKind = 'web' | 'sketch'

export interface CanvasDockSessionRef {
  canvasId: string
  kind: CanvasDockSessionKind
}

export interface CanvasDockChatState {
  sessions: CanvasDockSessionRef[]
  activeCanvasId: string | null
}

const EMPTY_STATE: CanvasDockChatState = { sessions: [], activeCanvasId: null }
const STORAGE_PREFIX = 'taskwraith.canvasDockSessions.'

function isSessionRef(value: unknown): value is CanvasDockSessionRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as { canvasId?: unknown; kind?: unknown }
  return (
    typeof ref.canvasId === 'string' &&
    ref.canvasId.length > 0 &&
    (ref.kind === 'web' || ref.kind === 'sketch')
  )
}

function readStoredState(chatId: string): CanvasDockChatState {
  try {
    if (typeof localStorage === 'undefined') return EMPTY_STATE
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${chatId}`)
    if (!raw) return EMPTY_STATE
    const parsed = JSON.parse(raw) as { sessions?: unknown; activeCanvasId?: unknown }
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.filter(isSessionRef) : []
    const active =
      typeof parsed.activeCanvasId === 'string' &&
      sessions.some((session) => session.canvasId === parsed.activeCanvasId)
        ? parsed.activeCanvasId
        : (sessions[sessions.length - 1]?.canvasId ?? null)
    return { sessions, activeCanvasId: active }
  } catch {
    return EMPTY_STATE
  }
}

function writeStoredState(chatId: string, state: CanvasDockChatState): void {
  try {
    if (typeof localStorage === 'undefined') return
    const key = `${STORAGE_PREFIX}${chatId}`
    if (!state.sessions.length) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Storage may be full/blocked; dock sessions then just don't survive reload.
  }
}

/** Pure: drop sessions whose backing canvas no longer exists; repair the active id. */
export function reconcileDockSessions(
  state: CanvasDockChatState,
  liveCanvasIds: ReadonlySet<string>
): CanvasDockChatState {
  const sessions = state.sessions.filter((session) => liveCanvasIds.has(session.canvasId))
  if (sessions.length === state.sessions.length) return state
  const activeCanvasId =
    state.activeCanvasId && sessions.some((session) => session.canvasId === state.activeCanvasId)
      ? state.activeCanvasId
      : (sessions[sessions.length - 1]?.canvasId ?? null)
  return { sessions, activeCanvasId }
}

/**
 * Module store: per-chat dock sessions survive the panel unmounting (tab
 * switches) and — via localStorage — window reloads. Snapshots are cached per
 * chat so useSyncExternalStore sees stable references between mutations.
 */
class CanvasDockSessionStore {
  private readonly cache = new Map<string, CanvasDockChatState>()
  private readonly listeners = new Set<() => void>()

  snapshot(chatId: string): CanvasDockChatState {
    let state = this.cache.get(chatId)
    if (!state) {
      state = readStoredState(chatId)
      this.cache.set(chatId, state)
    }
    return state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private commit(chatId: string, next: CanvasDockChatState): void {
    this.cache.set(chatId, next)
    writeStoredState(chatId, next)
    for (const listener of this.listeners) listener()
  }

  add(chatId: string, ref: CanvasDockSessionRef): void {
    const state = this.snapshot(chatId)
    this.commit(chatId, {
      sessions: [...state.sessions.filter((s) => s.canvasId !== ref.canvasId), ref],
      activeCanvasId: ref.canvasId
    })
  }

  remove(chatId: string, canvasId: string): void {
    const state = this.snapshot(chatId)
    if (!state.sessions.some((s) => s.canvasId === canvasId)) return
    const sessions = state.sessions.filter((s) => s.canvasId !== canvasId)
    this.commit(chatId, {
      sessions,
      activeCanvasId:
        state.activeCanvasId === canvasId
          ? (sessions[sessions.length - 1]?.canvasId ?? null)
          : state.activeCanvasId
    })
  }

  activate(chatId: string, canvasId: string): void {
    const state = this.snapshot(chatId)
    if (state.activeCanvasId === canvasId) return
    if (!state.sessions.some((s) => s.canvasId === canvasId)) return
    this.commit(chatId, { ...state, activeCanvasId: canvasId })
  }

  reconcile(chatId: string, liveCanvasIds: ReadonlySet<string>): void {
    const state = this.snapshot(chatId)
    const next = reconcileDockSessions(state, liveCanvasIds)
    if (next !== state) this.commit(chatId, next)
  }
}

export const canvasDockSessionStore = new CanvasDockSessionStore()

export interface CanvasDockSummary {
  canvasId: string
  driver: string
  url: string
  title: string
  status: string
  isLoading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  presentation?: 'dock'
}

/** Defensive decode of a canvas summary that crossed the IPC bridge. */
export function toCanvasDockSummary(value: unknown): CanvasDockSummary | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.canvasId !== 'string' || !raw.canvasId) return null
  return {
    canvasId: raw.canvasId,
    driver: typeof raw.driver === 'string' ? raw.driver : 'web',
    url: typeof raw.url === 'string' ? raw.url : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    ...(typeof raw.isLoading === 'boolean' ? { isLoading: raw.isLoading } : {}),
    ...(typeof raw.canGoBack === 'boolean' ? { canGoBack: raw.canGoBack } : {}),
    ...(typeof raw.canGoForward === 'boolean' ? { canGoForward: raw.canGoForward } : {}),
    ...(raw.presentation === 'dock' ? { presentation: 'dock' as const } : {})
  }
}

/** Pure: the chat canvases this renderer does NOT host (agent windows, offscreen renders). */
export function selectAgentCanvases(
  chatSummaries: readonly CanvasDockSummary[],
  rendererOwnedIds: ReadonlySet<string>
): CanvasDockSummary[] {
  return chatSummaries.filter(
    (summary) => !rendererOwnedIds.has(summary.canvasId) && summary.status !== 'closed'
  )
}

export function canvasSummaryLabel(summary: {
  title?: string
  url?: string
  driver?: string
}): string {
  if (summary.title) return summary.title
  // A sketch's record url is an internal sketch://<id> — never a useful label.
  if (summary.driver === 'sketch') return 'Sketch canvas'
  if (summary.url) {
    try {
      const parsed = new URL(summary.url)
      // Compact only real web origins; html://sha / device://… read better raw.
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host) {
        return parsed.host
      }
    } catch {
      // Not a parseable URL — fall through to the raw string.
    }
    return summary.url
  }
  return summary.driver === 'sketch' ? 'Sketch canvas' : 'Canvas'
}

function driverBadge(driver: string): string {
  if (driver === 'html') return 'render'
  if (driver === 'device') return 'simulator'
  return driver
}

function PopOutGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 3.5H3.5v9h9V9.5M9.5 3h3.5v3.5M13 3 8 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export interface CanvasDockPanelProps {
  chatId: string
}

interface CanvasPresentationBridge {
  adoptEmbedded?: (args: { chatId: string; canvasId: string }) => Promise<unknown>
}

export function CanvasDockPanel({ chatId }: CanvasDockPanelProps) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => canvasDockSessionStore.subscribe(listener), []),
    () => canvasDockSessionStore.snapshot(chatId),
    // Server snapshot: the static-markup tests render through React's server
    // path, which requires it; same source of truth.
    () => canvasDockSessionStore.snapshot(chatId)
  )
  const [ownedSummaries, setOwnedSummaries] = useState<ReadonlyMap<string, CanvasDockSummary>>(
    new Map()
  )
  const [chatSummaries, setChatSummaries] = useState<readonly CanvasDockSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'web' | 'sketch' | null>(null)
  const [showLauncher, setShowLauncher] = useState(false)
  const [showMesh, setShowMesh] = useState(false)
  const [showSimulator, setShowSimulator] = useState(false)
  // Async completions race chat switches; compare-and-drop stale ones.
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const showSimulatorRef = useRef(showSimulator)
  showSimulatorRef.current = showSimulator

  const openMeshSurface = useCallback((): void => {
    setShowSimulator(false)
    setShowMesh(true)
    setShowLauncher(false)
  }, [])

  const openSimulatorSurface = useCallback((): void => {
    setShowMesh(false)
    setShowSimulator(true)
    setShowLauncher(false)
  }, [])

  const toggleMeshSurface = useCallback((): void => {
    setShowMesh((current) => {
      const next = !current
      if (next) setShowSimulator(false)
      return next
    })
    setShowLauncher(false)
  }, [])

  const toggleSimulatorSurface = useCallback((): void => {
    setShowSimulator((current) => {
      const next = !current
      if (next) setShowMesh(false)
      return next
    })
    setShowLauncher(false)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.api?.canvas
    if (!api) return
    try {
      const owned = (await api.list()).map(toCanvasDockSummary).filter(
        (summary): summary is CanvasDockSummary => summary !== null
      )
      if (chatIdRef.current !== chatId) return
      const chatWide = api.listForChat ? await api.listForChat(chatId) : []
      if (chatIdRef.current !== chatId) return
      const decodedChatWide = chatWide
        .map(toCanvasDockSummary)
        .filter((summary): summary is CanvasDockSummary => summary !== null)
      const ownedById = new Map(owned.map((summary) => [summary.canvasId, summary]))
      const presentationApi = api as typeof api & CanvasPresentationBridge

      for (const candidate of selectUnownedDockPresentations(
        decodedChatWide,
        new Set(ownedById.keys())
      )) {
        if (!presentationApi.adoptEmbedded) {
          setError(
            'Canvas presentation needs the updated preload bridge. Restart TaskWraith and try again.'
          )
          break
        }
        const result = await presentationApi.adoptEmbedded({
          chatId,
          canvasId: candidate.canvasId
        })
        if (chatIdRef.current !== chatId) return
        const record =
          result && typeof result === 'object' ? (result as Record<string, unknown>) : null
        if (!record || record.ok !== true) {
          setError(
            friendlyCanvasError(
              record && typeof record.error === 'string'
                ? record.error
                : 'Could not adopt the Canvas presentation.'
            )
          )
          continue
        }
        const adopted = toCanvasDockSummary(record)
        if (adopted) ownedById.set(adopted.canvasId, adopted)
      }

      for (const summary of ownedById.values()) {
        if (summary.presentation !== 'dock') continue
        const stored = canvasDockSessionStore.snapshot(chatId)
        if (stored.sessions.some((session) => session.canvasId === summary.canvasId)) continue
        canvasDockSessionStore.add(chatId, {
          canvasId: summary.canvasId,
          kind: summary.driver === 'sketch' ? 'sketch' : 'web'
        })
      }

      canvasDockSessionStore.reconcile(chatId, new Set(ownedById.keys()))
      setOwnedSummaries(ownedById)
      setChatSummaries(decodedChatWide)
    } catch {
      // Listing is best-effort; the launcher stays usable without it.
    }
  }, [chatId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A presentation may have been made while this dock was closed. On the next
  // mount, restore that explicit user-facing intent from the chat-owned scene
  // summaries; this is deliberately not provider/session state.
  useEffect(() => {
    const api = window.api?.meshCanvas
    let cancelled = false
    setShowMesh(false)
    setShowSimulator(false)
    if (!api) return () => {
      cancelled = true
    }
    void api
      .listForChat(chatId)
      .then((records) => {
        if (cancelled || chatIdRef.current !== chatId) return
        if (!records.map(toMeshSceneSummary).some((scene) => scene?.presentedAt)) return
        // Do not clobber an active Simulator surface or a pending composer open.
        if (
          !shouldOpenMeshFromChatRehydrate({
            showSimulator: showSimulatorRef.current,
            chatId,
            pendingSimulatorChatId: getPendingSimulatorCanvasOpenRequest()?.chatId ?? null
          })
        ) {
          return
        }
        openMeshSurface()
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [chatId, openMeshSurface])

  // The composer can explicitly open Mesh Canvas before any scene exists. Keep
  // that one-shot renderer request long enough for this dock to mount, then
  // consume it so ordinary dock reopens preserve the user's last surface.
  useEffect(() => {
    let consumeTimer: number | null = null
    const showRequestedMesh = (): void => {
      const request = getPendingMeshCanvasOpenRequest()
      if (!request || request.chatId !== chatId) return
      openMeshSurface()
      // Defer consumption by one task. React development Strict Mode runs
      // mount effects twice; consuming synchronously would make the second
      // pass reset `showMesh` to its normal default before the dock paints.
      if (consumeTimer !== null) window.clearTimeout(consumeTimer)
      consumeTimer = window.setTimeout(() => {
        consumeTimer = null
        consumeMeshCanvasOpenRequest(request.id)
      }, 0)
    }
    showRequestedMesh()
    const unsubscribe = subscribeMeshCanvasOpenRequests(showRequestedMesh)
    return () => {
      unsubscribe()
      if (consumeTimer !== null) window.clearTimeout(consumeTimer)
    }
  }, [chatId, openMeshSurface])

  // Composer one-shot for Simulator Canvas — same mount/consume timing as Mesh.
  useEffect(() => {
    let consumeTimer: number | null = null
    const showRequestedSimulator = (): void => {
      const request = getPendingSimulatorCanvasOpenRequest()
      if (!request || request.chatId !== chatId) return
      openSimulatorSurface()
      if (consumeTimer !== null) window.clearTimeout(consumeTimer)
      consumeTimer = window.setTimeout(() => {
        consumeTimer = null
        consumeSimulatorCanvasOpenRequest(request.id)
      }, 0)
    }
    showRequestedSimulator()
    const unsubscribe = subscribeSimulatorCanvasOpenRequests(showRequestedSimulator)
    return () => {
      unsubscribe()
      if (consumeTimer !== null) window.clearTimeout(consumeTimer)
    }
  }, [chatId, openSimulatorSurface])

  // Live refresh: every canvas action broadcasts an audit event carrying its
  // chatId — agent opens/closes/navigations show up without polling.
  useEffect(() => {
    const api = window.api?.canvas
    if (!api?.onEvent) return
    let timer: number | null = null
    const off = api.onEvent((event) => {
      const record = event as { chatId?: unknown } | null
      if (!record || record.chatId !== chatId) return
      if (isCanvasDockPresentationEvent(event, chatId)) {
        setShowMesh(false)
        setShowSimulator(false)
        setShowLauncher(false)
      }
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void refresh()
      }, 180)
    })
    return () => {
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [chatId, refresh])

  // `mesh_scene_present` is an explicit agent request to show the human a
  // scene. When the Canvas dock is already open, switch its local surface to
  // Mesh Canvas immediately; no provider/session state is involved.
  useEffect(() => {
    const api = window.api?.meshCanvas
    if (!api?.onEvent) return
    return api.onEvent((event) => {
      const record = event as { chatId?: unknown; kind?: unknown } | null
      if (record?.chatId === chatId && record.kind === 'scene.presented') openMeshSurface()
    })
  }, [chatId, openMeshSurface])

  const runOpen = async (
    mode: 'web' | 'sketch',
    open: () => Promise<
      | { ok: true; canvasId: string; url: string; title: string }
      | { ok: false; error: string }
      | undefined
    >
  ): Promise<void> => {
    setError(null)
    setBusy(mode)
    try {
      const result = await open()
      if (chatIdRef.current !== chatId) return
      if (result?.ok) {
        canvasDockSessionStore.add(chatId, { canvasId: result.canvasId, kind: mode })
        setShowLauncher(false)
        void refresh()
      } else {
        setError(friendlyCanvasError(result?.error))
      }
    } catch (err) {
      if (chatIdRef.current === chatId) {
        setError(friendlyCanvasError(err instanceof Error ? err.message : String(err)))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  const openWeb = (url: string): void => {
    const api = window.api?.canvas
    if (!api) return
    void runOpen('web', () => api.openEmbedded({ url, chatId }))
  }

  const openSketch = (): void => {
    const api = window.api?.canvas
    if (!api?.openSketchEmbedded) {
      setError('Sketch Canvas needs the updated preload bridge. Restart TaskWraith and try again.')
      return
    }
    void runOpen('sketch', () => api.openSketchEmbedded({ chatId }))
  }

  const closeSession = async (canvasId: string): Promise<void> => {
    const api = window.api?.canvas
    canvasDockSessionStore.remove(chatId, canvasId)
    try {
      await api?.close(canvasId)
    } catch {
      // Already closed (chat cleared / main restarted) — the store entry is gone.
    }
    void refresh()
  }

  const popOutSession = async (session: CanvasDockSessionRef): Promise<void> => {
    const api = window.api?.canvas
    if (!api) return
    setError(null)
    const summary = ownedSummaries.get(session.canvasId)
    // Close the embed first: a sketch's document is chat-persisted (lossless);
    // a web canvas reopens at its current URL (page state resets — same as any
    // reload). Two live surfaces over one sketch doc would fight, so never
    // open the window before the embed is gone.
    canvasDockSessionStore.remove(chatId, session.canvasId)
    try {
      await api.close(session.canvasId)
    } catch {
      // Best-effort; the window open below is what the user asked for.
    }
    try {
      const result =
        session.kind === 'sketch'
          ? await api.openSketchWindow({ chatId })
          : await api.openWindow({ url: summary?.url || 'http://localhost:3000', chatId })
      if (chatIdRef.current === chatId && result && !result.ok) {
        setError(friendlyCanvasError(result.error))
      }
    } catch (err) {
      if (chatIdRef.current === chatId) {
        setError(friendlyCanvasError(err instanceof Error ? err.message : String(err)))
      }
    }
    void refresh()
  }

  const closeAgentCanvas = async (canvasId: string): Promise<void> => {
    const api = window.api?.canvas
    if (!api?.closeForChat) return
    try {
      await api.closeForChat(chatId, canvasId)
    } catch (err) {
      if (chatIdRef.current === chatId) {
        setError(friendlyCanvasError(err instanceof Error ? err.message : String(err)))
      }
    }
    void refresh()
  }

  const sessions = state.sessions
  const active =
    sessions.find((session) => session.canvasId === state.activeCanvasId) ??
    sessions[sessions.length - 1] ??
    null
  const activeSummary = active ? ownedSummaries.get(active.canvasId) : undefined
  const agentCanvases = selectAgentCanvases(
    chatSummaries,
    new Set(ownedSummaries.keys())
  )
  const launcherVisible = showLauncher || !sessions.length
  const showingSpecialSurface = showMesh || showSimulator
  const toolbarTitle = showSimulator
    ? 'Simulator Canvas'
    : showMesh
      ? 'Mesh Canvas'
      : 'Canvas'

  return (
    <div className="canvas-dock-panel" aria-label="Canvas panel">
      <div className="canvas-dock-toolbar">
        {!showingSpecialSurface && sessions.length ? (
          <div className="canvas-dock-tabs" role="tablist" aria-label="Open canvases">
            {sessions.map((session) => {
              const summary = ownedSummaries.get(session.canvasId)
              const label = canvasSummaryLabel({
                title: summary?.title,
                url: summary?.url,
                driver: session.kind
              })
              const isActive = active?.canvasId === session.canvasId
              return (
                <button
                  key={session.canvasId}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`canvas-dock-tab${isActive ? ' is-active' : ''}`}
                  title={summary?.url || label}
                  onClick={() => {
                    setShowLauncher(false)
                    setShowMesh(false)
                    setShowSimulator(false)
                    canvasDockSessionStore.activate(chatId, session.canvasId)
                  }}
                >
                  <span className="canvas-dock-tab-label">{label}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <span className="canvas-dock-toolbar-title">{toolbarTitle}</span>
        )}
        <button
          type="button"
          className={`canvas-dock-mesh${showMesh ? ' is-active' : ''}`}
          onClick={toggleMeshSurface}
          aria-label="Show Mesh Canvas"
          title="Show Mesh Canvas"
        >
          3D
        </button>
        <button
          type="button"
          className={`canvas-dock-sim${showSimulator ? ' is-active' : ''}`}
          onClick={toggleSimulatorSurface}
          aria-label="Show Simulator Canvas"
          title="Show Simulator Canvas"
        >
          Sim
        </button>
        {!showingSpecialSurface && sessions.length > 0 && (
          <button
            type="button"
            className={`canvas-dock-new${launcherVisible ? ' is-active' : ''}`}
            onClick={() => setShowLauncher((value) => !value)}
            aria-label="Open a new canvas"
            title="Open a new canvas"
          >
            +
          </button>
        )}
      </div>

      {showSimulator ? (
        <SimulatorCanvasPanel chatId={chatId} />
      ) : showMesh ? (
        <MeshCanvasPanel chatId={chatId} />
      ) : (
        <>
      {launcherVisible && (
        <div className="canvas-dock-launcher">
          <div className="canvas-dock-launcher-group">
            <div className="canvas-dock-launcher-title">Browser</div>
            <div className="canvas-dock-launcher-hint">
              Open a website, your dev server, or a running app in a sandboxed pane.
            </div>
            <CanvasPaneLauncher onOpen={openWeb} />
          </div>
          <div className="canvas-dock-launcher-divider" />
          <div className="canvas-dock-launcher-group">
            <div className="canvas-dock-launcher-title">Sketch canvas</div>
            <div className="canvas-dock-launcher-hint">
              Quick shapes, freehand marks, arrows, and text.
            </div>
            <button
              type="button"
              className="canvas-dock-launcher-sketch"
              onClick={openSketch}
              disabled={busy !== null}
            >
              Open sketch canvas
            </button>
          </div>
          <div className="canvas-dock-launcher-divider" />
          <div className="canvas-dock-launcher-group">
            <div className="canvas-dock-launcher-title">Simulator Canvas</div>
            <div className="canvas-dock-launcher-hint">
              Preview an iOS Simulator in this chat.
            </div>
            <button
              type="button"
              className="canvas-dock-launcher-sketch"
              onClick={openSimulatorSurface}
            >
              Open Simulator Canvas
            </button>
          </div>
          {busy && <div className="canvas-dock-launcher-hint">Opening…</div>}
        </div>
      )}

      {error && (
        <div className="canvas-dock-error" role="alert">
          {error}
        </div>
      )}

      {active && !launcherVisible && (
        <div className="canvas-dock-pane-host">
          <CanvasPane
            key={active.canvasId}
            canvasId={active.canvasId}
            title={canvasSummaryLabel({
              title: activeSummary?.title,
              url: activeSummary?.url,
              driver: active.kind
            })}
            url={activeSummary?.url}
            overlayGuard
            chrome={
              active.kind === 'web' && isNavigableCanvasUrl(activeSummary?.url) ? (
                <CanvasBrowserChrome
                  key={active.canvasId}
                  chatId={chatId}
                  canvasId={active.canvasId}
                  initialState={{
                    url: activeSummary?.url ?? '',
                    title: activeSummary?.title ?? '',
                    isLoading: activeSummary?.isLoading === true,
                    canGoBack: activeSummary?.canGoBack === true,
                    canGoForward: activeSummary?.canGoForward === true
                  }}
                  onNavigateError={(message) => setError(friendlyCanvasError(message))}
                />
              ) : undefined
            }
            actions={
              <button
                type="button"
                className="canvas-dock-popout"
                onClick={() => void popOutSession(active)}
                aria-label="Move canvas to a floating window"
                title="Move to a floating window"
              >
                <PopOutGlyph />
              </button>
            }
            onClose={() => void closeSession(active.canvasId)}
          />
        </div>
      )}

      {agentCanvases.length > 0 && (
        <div className="canvas-dock-agent-section">
          <div className="canvas-dock-agent-title">Agent canvases</div>
          <ul className="canvas-dock-agent-list">
            {agentCanvases.map((summary) => (
              <li key={summary.canvasId} className="canvas-dock-agent-row">
                <span
                  className={`canvas-dock-agent-status is-${summary.status || 'unknown'}`}
                  aria-hidden="true"
                />
                <span className="canvas-dock-agent-label" title={summary.url}>
                  {canvasSummaryLabel(summary)}
                </span>
                <span className="canvas-dock-agent-driver">{driverBadge(summary.driver)}</span>
                <button
                  type="button"
                  className="canvas-dock-agent-close"
                  onClick={() => void closeAgentCanvas(summary.canvasId)}
                  aria-label={`Close ${canvasSummaryLabel(summary)}`}
                  title="Close this canvas"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="canvas-dock-agent-hint">
            Opened by agents via canvas tools — web canvases live in floating windows; renders
            are off-screen.
          </div>
        </div>
      )}
        </>
      )}
    </div>
  )
}
