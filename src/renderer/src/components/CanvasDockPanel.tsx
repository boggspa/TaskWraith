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
import { TelemetryCanvasPanel } from './TelemetryCanvasPanel'
import { friendlyCanvasError } from './CanvasComposerButton'
import {
  isCanvasDockPresentationEvent,
  selectUnownedDockPresentations
} from '../lib/canvasPresentation'
import { validateCanvasChart, type CanvasChartDocument } from '../../../shared/canvasChart'
import {
  consumeMeshCanvasOpenRequest,
  getPendingMeshCanvasOpenRequest,
  subscribeMeshCanvasOpenRequests
} from '../lib/meshCanvasLaunch'
import {
  consumeSimulatorCanvasOpenRequest,
  getPendingSimulatorCanvasOpenRequest,
  isSimulatorCanvasPresentationEvent,
  subscribeSimulatorCanvasOpenRequests
} from '../lib/simulatorCanvasLaunch'
import { shouldOpenMeshFromChatRehydrate } from '../lib/simulatorCanvasPanelHelpers'
import { MeshCanvasPanel, toMeshSceneSummary } from './MeshCanvasPanel'
import { SimulatorCanvasPanel } from './SimulatorCanvasPanel'
import type {
  CanvasPopoutSessionSeed,
  CanvasPopoutSurface
} from '../../../main/canvas/CanvasPopoutWindowManager'

export type CanvasDockSessionKind = 'web' | 'sketch' | 'chart' | 'emulator'

export interface CanvasDockSessionRef {
  canvasId: string
  kind: CanvasDockSessionKind
}

/** Map a Canvas driver string onto the dock session-tab kind. */
export function dockSessionKindFromDriver(driver: string | undefined): CanvasDockSessionKind {
  if (driver === 'sketch') return 'sketch'
  if (driver === 'chart') return 'chart'
  if (driver === 'emulator') return 'emulator'
  return 'web'
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
    (ref.kind === 'web' || ref.kind === 'sketch' || ref.kind === 'chart' || ref.kind === 'emulator')
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
  /** Present when main/list includes the structured chart payload. */
  chartDocument?: CanvasChartDocument
}

/** Defensive decode of a canvas summary that crossed the IPC bridge. */
export function toCanvasDockSummary(value: unknown): CanvasDockSummary | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.canvasId !== 'string' || !raw.canvasId) return null
  const chartVerdict =
    raw.chartDocument !== undefined ? validateCanvasChart(raw.chartDocument) : null
  return {
    canvasId: raw.canvasId,
    driver: typeof raw.driver === 'string' ? raw.driver : 'web',
    url: typeof raw.url === 'string' ? raw.url : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    ...(typeof raw.isLoading === 'boolean' ? { isLoading: raw.isLoading } : {}),
    ...(typeof raw.canGoBack === 'boolean' ? { canGoBack: raw.canGoBack } : {}),
    ...(typeof raw.canGoForward === 'boolean' ? { canGoForward: raw.canGoForward } : {}),
    ...(raw.presentation === 'dock' ? { presentation: 'dock' as const } : {}),
    ...(chartVerdict?.ok ? { chartDocument: chartVerdict.document } : {})
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
  // A sketch/chart/emulator record URL is internal state, never a useful label.
  if (summary.driver === 'sketch') return 'Sketch canvas'
  if (summary.driver === 'chart') return 'Chart'
  if (summary.driver === 'emulator') return 'Homebrew emulator'
  if (summary.driver === 'web' && (!summary.url || summary.url === 'about:blank')) return 'Browser'
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
  if (summary.driver === 'sketch') return 'Sketch canvas'
  if (summary.driver === 'chart') return 'Chart'
  if (summary.driver === 'emulator') return 'Homebrew emulator'
  return 'Canvas'
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

function DockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2.75"
        y="3"
        width="10.5"
        height="10"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M9.25 3v10M6.5 8h4.75M9.5 6.25 11.25 8 9.5 9.75"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GlobeGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M2.9 10h14.2M10 2.75c2 2.1 3.05 4.52 3.05 7.25S12 15.15 10 17.25C8 15.15 6.95 12.73 6.95 10S8 4.85 10 2.75Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SurfaceGlyph({ kind }: { kind: 'browser' | 'sketch' | 'mesh' | 'simulator' }) {
  if (kind === 'browser') return <GlobeGlyph />
  if (kind === 'sketch') {
    return (
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="m4 14.9.55-3.25L12.7 3.5a1.55 1.55 0 0 1 2.2 0l1.6 1.6a1.55 1.55 0 0 1 0 2.2l-8.15 8.15L5.1 16 4 14.9Z"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
        <path d="m11.6 4.6 3.8 3.8M4.6 11.8l3.6 3.6" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    )
  }
  if (kind === 'mesh') {
    return (
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="m10 2.8 6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4L10 2.8Zm0 7.2 6.1-3.5M10 10 3.9 6.5M10 10v7"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="5"
        y="2.75"
        width="10"
        height="14.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="M8.25 5h3.5M9.1 14.9h1.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ShieldGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2.6 16 5v4.4c0 3.7-2.2 6.4-6 8-3.8-1.6-6-4.3-6-8V5l6-2.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="m7.5 10 1.55 1.55L12.8 7.8"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export interface CanvasDockPanelProps {
  chatId: string
  /** The same panel is reused as the complete contents of a Canvas pop-out. */
  host?: 'dock' | 'popout'
  initialSurface?: Exclude<CanvasPopoutSurface, 'media'>
  initialSession?: CanvasPopoutSessionSeed
}

interface CanvasPresentationBridge {
  adoptEmbedded?: (args: { chatId: string; canvasId: string }) => Promise<unknown>
  clearBrowserProfile?: () => Promise<
    { ok: true; closedSurfaceCount: number } | { ok: false; error: string }
  >
  openPopout?: (args: {
    chatId: string
    surface: Exclude<CanvasPopoutSurface, 'media'>
    session?: CanvasPopoutSessionSeed
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  dockPopout?: (args: {
    chatId: string
    surface: Exclude<CanvasPopoutSurface, 'media'>
  }) => Promise<{ ok: true; canvasIds: string[] } | { ok: false; error: string }>
}

export function CanvasDockPanel({
  chatId,
  host = 'dock',
  initialSurface = 'browser',
  initialSession
}: CanvasDockPanelProps) {
  const sessionStoreKey = host === 'popout' ? `${chatId}:popout` : chatId
  // Seed before the first snapshot so a transferred WebContentsView never
  // paints an empty frame while the pop-out waits for its first list refresh.
  useState(() => {
    if (initialSession) {
      canvasDockSessionStore.add(sessionStoreKey, {
        canvasId: initialSession.canvasId,
        kind: initialSession.kind
      })
    }
    return true
  })
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => canvasDockSessionStore.subscribe(listener), []),
    () => canvasDockSessionStore.snapshot(sessionStoreKey),
    // Server snapshot: the static-markup tests render through React's server
    // path, which requires it; same source of truth.
    () => canvasDockSessionStore.snapshot(sessionStoreKey)
  )
  const [ownedSummaries, setOwnedSummaries] = useState<ReadonlyMap<string, CanvasDockSummary>>(
    new Map()
  )
  const [chatSummaries, setChatSummaries] = useState<readonly CanvasDockSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'web' | 'sketch' | null>(null)
  const [showLauncher, setShowLauncher] = useState(false)
  const [showMesh, setShowMesh] = useState(initialSurface === 'mesh')
  const [showSimulator, setShowSimulator] = useState(initialSurface === 'simulator')
  const [openMenu, setOpenMenu] = useState<'surfaces' | 'profile' | null>(null)
  const [confirmingProfileClear, setConfirmingProfileClear] = useState(false)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileNotice, setProfileNotice] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)
  // Async completions race chat switches; compare-and-drop stale ones.
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const showSimulatorRef = useRef(showSimulator)
  showSimulatorRef.current = showSimulator

  const openMeshSurface = useCallback((): void => {
    setShowSimulator(false)
    setShowMesh(true)
    setShowLauncher(false)
    setOpenMenu(null)
  }, [])

  const dismissMeshSurface = useCallback((): void => {
    setShowMesh(false)
    setOpenMenu(null)
  }, [])

  const openSimulatorSurface = useCallback((): void => {
    setShowMesh(false)
    setShowSimulator(true)
    setShowLauncher(false)
    setOpenMenu(null)
  }, [])

  useEffect(() => {
    setOpenMenu(null)
    setConfirmingProfileClear(false)
    setProfileBusy(false)
    setProfileNotice(null)
  }, [chatId])

  useEffect(() => {
    if (initialSession) {
      canvasDockSessionStore.add(sessionStoreKey, {
        canvasId: initialSession.canvasId,
        kind: initialSession.kind
      })
      setShowLauncher(false)
    }
    setShowMesh(initialSurface === 'mesh')
    setShowSimulator(initialSurface === 'simulator')
    if (initialSurface === 'browser' || initialSurface === 'sketch') {
      setShowLauncher(
        !initialSession && canvasDockSessionStore.snapshot(sessionStoreKey).sessions.length === 0
      )
    }
  }, [initialSession, initialSurface, sessionStoreKey])

  useEffect(() => {
    if (!openMenu) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [openMenu])

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.api?.canvas
    if (!api) return
    try {
      const owned = (await api.list())
        .map(toCanvasDockSummary)
        .filter((summary): summary is CanvasDockSummary => summary !== null)
      if (chatIdRef.current !== chatId) return
      const chatWide = api.listForChat ? await api.listForChat(chatId) : []
      if (chatIdRef.current !== chatId) return
      const decodedChatWide = chatWide
        .map(toCanvasDockSummary)
        .filter((summary): summary is CanvasDockSummary => summary !== null)
      const ownedById = new Map(owned.map((summary) => [summary.canvasId, summary]))
      const presentationApi = api as typeof api & CanvasPresentationBridge

      // Chart dock presentations have no WebContentsView, so they never appear in
      // renderer `list()`. Host them from the chat-wide summary so reconcile and
      // the tab body can see titles / optional chartDocument payloads.
      for (const summary of decodedChatWide) {
        if (
          summary.driver === 'chart' &&
          summary.presentation === 'dock' &&
          summary.status !== 'closed'
        ) {
          ownedById.set(summary.canvasId, summary)
        }
      }

      const adoptablePresentations =
        host === 'dock'
          ? selectUnownedDockPresentations(decodedChatWide, new Set(ownedById.keys()))
          : []
      for (const candidate of adoptablePresentations) {
        // Chart docks are native TelemetryPane tabs — no WebContentsView to adopt.
        if (candidate.driver === 'chart') {
          continue
        }
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
        const stored = canvasDockSessionStore.snapshot(sessionStoreKey)
        if (stored.sessions.some((session) => session.canvasId === summary.canvasId)) continue
        canvasDockSessionStore.add(sessionStoreKey, {
          canvasId: summary.canvasId,
          kind: dockSessionKindFromDriver(summary.driver)
        })
      }

      canvasDockSessionStore.reconcile(sessionStoreKey, new Set(ownedById.keys()))
      setOwnedSummaries(ownedById)
      setChatSummaries(decodedChatWide)
    } catch {
      // Listing is best-effort; the launcher stays usable without it.
    }
  }, [chatId, host, sessionStoreKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A presentation may have been made while this dock was closed. On the next
  // mount, restore that explicit user-facing intent from the chat-owned scene
  // summaries; this is deliberately not provider/session state.
  useEffect(() => {
    const api = window.api?.meshCanvas
    let cancelled = false
    setShowMesh(host === 'popout' && initialSurface === 'mesh')
    setShowSimulator(host === 'popout' && initialSurface === 'simulator')
    if (!api)
      return () => {
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
  }, [chatId, host, initialSurface, openMeshSurface])

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
        setOpenMenu(null)
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

  // Agent Simulator QA presents the dedicated surface inside an already-open
  // dock; App owns opening the outer dock when it is currently closed.
  useEffect(() => {
    const api = window.api?.simulatorCanvas
    if (!api?.onEvent) return
    return api.onEvent((event) => {
      if (isSimulatorCanvasPresentationEvent(event, chatId)) openSimulatorSurface()
    })
  }, [chatId, openSimulatorSurface])

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
    setOpenMenu(null)
    try {
      const result = await open()
      if (chatIdRef.current !== chatId) return
      if (result?.ok) {
        canvasDockSessionStore.add(sessionStoreKey, { canvasId: result.canvasId, kind: mode })
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

  const openWeb = (): void => {
    const api = window.api?.canvas
    if (!api) return
    void runOpen('web', () => api.openEmbedded({ chatId }))
  }

  const openSketch = (): void => {
    const api = window.api?.canvas
    if (!api?.openSketchEmbedded) {
      setError('Sketch Canvas needs the updated preload bridge. Restart TaskWraith and try again.')
      return
    }
    void runOpen('sketch', () => api.openSketchEmbedded({ chatId }))
  }

  const clearBrowserProfile = async (): Promise<void> => {
    const api = window.api?.canvas as
      | (typeof window.api.canvas & CanvasPresentationBridge)
      | undefined
    if (!api?.clearBrowserProfile) {
      setProfileNotice({
        kind: 'error',
        text: 'Browser profile controls need the updated preload bridge. Restart TaskWraith and try again.'
      })
      return
    }
    setProfileBusy(true)
    setProfileNotice(null)
    try {
      const result = await api.clearBrowserProfile()
      if (chatIdRef.current !== chatId) return
      if (!result.ok) {
        setProfileNotice({ kind: 'error', text: friendlyCanvasError(result.error) })
        return
      }
      setConfirmingProfileClear(false)
      setShowMesh(false)
      setShowSimulator(false)
      setShowLauncher(true)
      await refresh()
      if (chatIdRef.current === chatId) {
        setProfileNotice({
          kind: 'success',
          text:
            result.closedSurfaceCount > 0
              ? `Browsing data cleared and ${result.closedSurfaceCount} browser ${result.closedSurfaceCount === 1 ? 'tab was' : 'tabs were'} closed.`
              : 'Browsing data cleared.'
        })
      }
    } catch (err) {
      if (chatIdRef.current === chatId) {
        setProfileNotice({
          kind: 'error',
          text: friendlyCanvasError(err instanceof Error ? err.message : String(err))
        })
      }
    } finally {
      if (chatIdRef.current === chatId) setProfileBusy(false)
    }
  }

  const closeSession = async (canvasId: string): Promise<void> => {
    const api = window.api?.canvas
    const session = state.sessions.find((entry) => entry.canvasId === canvasId)
    canvasDockSessionStore.remove(sessionStoreKey, canvasId)
    try {
      // Chart tabs are never renderer-embed-owned; close through the chat-scoped
      // path (same authority as closing an agent canvas). Web/sketch embeds use
      // the ordinary owned close channel.
      if (session?.kind === 'chart') {
        await api?.closeForChat?.(chatId, canvasId)
      } else {
        await api?.close(canvasId)
      }
    } catch {
      // Already closed (chat cleared / main restarted) — the store entry is gone.
    }
    void refresh()
  }

  const popOutSession = async (session: CanvasDockSessionRef): Promise<void> => {
    const api = window.api?.canvas as
      | (typeof window.api.canvas & CanvasPresentationBridge)
      | undefined
    if (!api) return
    // Chart tabs are dock-native; there is no floating-window host for them.
    if (session.kind === 'chart' || session.kind === 'emulator') return
    setError(null)
    if (!api.openPopout) {
      setError('Canvas pop-out needs the updated preload bridge. Restart TaskWraith and try again.')
      return
    }
    const summary = ownedSummaries.get(session.canvasId)
    try {
      const result = await api.openPopout({
        chatId,
        surface: session.kind === 'sketch' ? 'sketch' : 'browser',
        session: {
          canvasId: session.canvasId,
          kind: session.kind,
          ...(summary?.url ? { url: summary.url } : {}),
          ...(summary?.title ? { title: summary.title } : {})
        }
      })
      if (!result.ok) {
        setError(friendlyCanvasError(result.error))
      } else if (chatIdRef.current === chatId) {
        // Main has atomically reparented the live WebContentsView. Removing the
        // local tab now unmounts its old bounds reporter without closing/reloading it.
        canvasDockSessionStore.remove(sessionStoreKey, session.canvasId)
      }
    } catch (err) {
      if (chatIdRef.current === chatId) {
        setError(friendlyCanvasError(err instanceof Error ? err.message : String(err)))
      }
    }
    void refresh()
  }

  const popOutSpecialSurface = async (surface: 'mesh' | 'simulator'): Promise<void> => {
    const api = window.api?.canvas as
      | (typeof window.api.canvas & CanvasPresentationBridge)
      | undefined
    if (!api?.openPopout) {
      setError('Canvas pop-out needs the updated preload bridge. Restart TaskWraith and try again.')
      return
    }
    setError(null)
    try {
      const result = await api.openPopout({ chatId, surface })
      if (!result.ok) {
        setError(friendlyCanvasError(result.error))
        return
      }
      if (surface === 'mesh') setShowMesh(false)
      else setShowSimulator(false)
    } catch (error) {
      setError(friendlyCanvasError(error instanceof Error ? error.message : String(error)))
    }
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
  const agentCanvases = selectAgentCanvases(chatSummaries, new Set(ownedSummaries.keys()))
  const launcherVisible = showLauncher || !sessions.length
  const showingSpecialSurface = showMesh || showSimulator
  const toolbarTitle = showSimulator ? 'Simulator Canvas' : showMesh ? 'Mesh Canvas' : 'New tab'
  const currentSurface: Exclude<CanvasPopoutSurface, 'media'> = showSimulator
    ? 'simulator'
    : showMesh
      ? 'mesh'
      : active?.kind === 'sketch'
        ? 'sketch'
        : 'browser'

  const showPopoutInDock = async (): Promise<void> => {
    const api = window.api?.canvas as
      | (typeof window.api.canvas & CanvasPresentationBridge)
      | undefined
    if (!api?.dockPopout) {
      setError('Dock transfer needs the updated preload bridge. Restart TaskWraith and try again.')
      return
    }
    setError(null)
    try {
      const result = await api.dockPopout({ chatId, surface: currentSurface })
      if (!result.ok) setError(friendlyCanvasError(result.error))
    } catch (error) {
      setError(friendlyCanvasError(error instanceof Error ? error.message : String(error)))
    }
  }

  const showBrowserSurface = (newTab: boolean): void => {
    setShowMesh(false)
    setShowSimulator(false)
    setShowLauncher(newTab || sessions.length === 0)
    setOpenMenu(null)
  }

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
                    canvasDockSessionStore.activate(sessionStoreKey, session.canvasId)
                  }}
                >
                  <span className="canvas-dock-tab-label">{label}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <span className="canvas-dock-toolbar-title">
            {!showingSpecialSurface && <GlobeGlyph size={13} />}
            <span>{toolbarTitle}</span>
          </span>
        )}
        <div className="canvas-dock-toolbar-actions">
          {host === 'popout' && active?.kind !== 'emulator' ? (
            <button
              type="button"
              className="canvas-dock-placement"
              onClick={() => void showPopoutInDock()}
              aria-label="Show Canvas in dock"
              title="Show in dock"
            >
              <DockGlyph />
              <span>Dock</span>
            </button>
          ) : showSimulator ||
            showMesh ||
            (active && active.kind !== 'chart' && active.kind !== 'emulator') ? (
            <button
              type="button"
              className="canvas-dock-placement"
              onClick={() => {
                if (showSimulator) void popOutSpecialSurface('simulator')
                else if (showMesh) void popOutSpecialSurface('mesh')
                else if (active) void popOutSession(active)
              }}
              aria-label="Move Canvas to a floating window"
              title="Move to a floating window"
            >
              <PopOutGlyph />
            </button>
          ) : null}
          <button
            type="button"
            className={`canvas-dock-new${openMenu === 'surfaces' ? ' is-active' : ''}`}
            onClick={() => {
              setOpenMenu((current) => (current === 'surfaces' ? null : 'surfaces'))
              setConfirmingProfileClear(false)
            }}
            aria-label="Choose canvas surface"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'surfaces'}
            title="Choose canvas surface"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {host === 'dock' ? (
            <button
              type="button"
              className={`canvas-dock-more${openMenu === 'profile' ? ' is-active' : ''}`}
              onClick={() => {
                setOpenMenu((current) => (current === 'profile' ? null : 'profile'))
                setConfirmingProfileClear(false)
              }}
              aria-label="Browser profile and privacy"
              aria-haspopup="dialog"
              aria-expanded={openMenu === 'profile'}
              title="Browser profile and privacy"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="3.25" cy="8" r="1" />
                <circle cx="8" cy="8" r="1" />
                <circle cx="12.75" cy="8" r="1" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {openMenu && (
        <button
          type="button"
          className="canvas-dock-menu-scrim"
          aria-label="Close Canvas menu"
          onClick={() => setOpenMenu(null)}
          tabIndex={-1}
        />
      )}

      {openMenu === 'surfaces' && (
        <div
          className="canvas-dock-popover canvas-dock-surface-menu"
          role="menu"
          aria-label="Canvas surfaces"
        >
          <div className="canvas-dock-popover-eyebrow">Canvas surfaces</div>
          <button
            type="button"
            className="canvas-dock-menu-item"
            role="menuitem"
            onClick={() => showBrowserSurface(false)}
          >
            <span className="canvas-dock-menu-icon">
              <SurfaceGlyph kind="browser" />
            </span>
            <span className="canvas-dock-menu-copy">
              <strong>{sessions.length ? 'Browser tabs' : 'Browser'}</strong>
              <small>
                {sessions.length ? 'Return to your open pages' : 'Start with a new tab'}
              </small>
            </span>
          </button>
          {sessions.length > 0 && (
            <button
              type="button"
              className="canvas-dock-menu-item"
              role="menuitem"
              onClick={() => showBrowserSurface(true)}
            >
              <span className="canvas-dock-menu-icon canvas-dock-menu-plus" aria-hidden="true">
                +
              </span>
              <span className="canvas-dock-menu-copy">
                <strong>New browser tab</strong>
                <small>Open another site or local app</small>
              </span>
            </button>
          )}
          <button
            type="button"
            className="canvas-dock-menu-item"
            role="menuitem"
            onClick={openSketch}
            disabled={busy !== null}
          >
            <span className="canvas-dock-menu-icon">
              <SurfaceGlyph kind="sketch" />
            </span>
            <span className="canvas-dock-menu-copy">
              <strong>Sketch canvas</strong>
              <small>Shapes, arrows, freehand, and text</small>
            </span>
          </button>
          <div className="canvas-dock-menu-divider" />
          <button
            type="button"
            className="canvas-dock-menu-item"
            role="menuitem"
            onClick={openMeshSurface}
          >
            <span className="canvas-dock-menu-icon">
              <SurfaceGlyph kind="mesh" />
            </span>
            <span className="canvas-dock-menu-copy">
              <strong>Mesh Canvas</strong>
              <small>Inspect and author 3D scenes</small>
            </span>
          </button>
          <button
            type="button"
            className="canvas-dock-menu-item"
            role="menuitem"
            onClick={openSimulatorSurface}
          >
            <span className="canvas-dock-menu-icon">
              <SurfaceGlyph kind="simulator" />
            </span>
            <span className="canvas-dock-menu-copy">
              <strong>Simulator Canvas</strong>
              <small>Preview and control an iOS app</small>
            </span>
          </button>
        </div>
      )}

      {openMenu === 'profile' && (
        <div
          className="canvas-dock-popover canvas-dock-profile-menu"
          role="dialog"
          aria-label="TaskWraith Browser profile"
        >
          <div className="canvas-dock-profile-heading">
            <span className="canvas-dock-profile-icon">
              <ShieldGlyph />
            </span>
            <span>
              <strong>TaskWraith Browser</strong>
              <small>Persistent profile on this device</small>
            </span>
          </div>
          <p>
            Cookies and sign-ins stay inside TaskWraith. They are never shared with Safari, Chrome,
            or provider credentials.
          </p>
          <div className="canvas-dock-profile-safety">
            Agents can use pages after you sign in, but cannot type passwords or verification codes.
          </div>
          {profileNotice && (
            <div className={`canvas-dock-profile-notice is-${profileNotice.kind}`} role="status">
              {profileNotice.text}
            </div>
          )}
          {confirmingProfileClear ? (
            <div className="canvas-dock-profile-confirm">
              <p>
                Close browser tabs across all tasks and clear cookies, sign-ins, site data, and
                cache? Sketch, 3D, Simulator, and Emulator canvases stay open.
              </p>
              <div className="canvas-dock-profile-actions">
                <button
                  type="button"
                  onClick={() => setConfirmingProfileClear(false)}
                  disabled={profileBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => void clearBrowserProfile()}
                  disabled={profileBusy}
                >
                  {profileBusy ? 'Clearing…' : 'Clear data'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="canvas-dock-profile-clear"
              onClick={() => {
                setConfirmingProfileClear(true)
                setProfileNotice(null)
              }}
            >
              Clear browsing data…
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="canvas-dock-error" role="alert">
          {error}
        </div>
      )}

      {showSimulator ? (
        <SimulatorCanvasPanel chatId={chatId} />
      ) : showMesh ? (
        <MeshCanvasPanel chatId={chatId} onDismiss={dismissMeshSurface} />
      ) : (
        <>
          {launcherVisible && (
            <section
              className="canvas-dock-browser-empty"
              aria-labelledby="canvas-browser-empty-title"
            >
              <div className="canvas-dock-browser-empty-icon">
                <GlobeGlyph size={25} />
              </div>
              <h2 id="canvas-browser-empty-title">Browser</h2>
              <p>Open a blank tab, then use its address bar.</p>
              <div className="canvas-dock-browser-launcher">
                <CanvasPaneLauncher onOpen={openWeb} />
              </div>
              <div className="canvas-dock-browser-privacy">
                <ShieldGlyph />
                <span>
                  Sign-ins stay in TaskWraith. You handle passwords and verification codes.
                </span>
              </div>
              {busy && <div className="canvas-dock-browser-opening">Opening…</div>}
            </section>
          )}

          {active && !launcherVisible && active.kind === 'chart' && (
            <div className="canvas-dock-pane-host">
              <TelemetryCanvasPanel
                key={active.canvasId}
                chatId={chatId}
                canvasId={active.canvasId}
                title={canvasSummaryLabel({
                  title: activeSummary?.title,
                  url: activeSummary?.url,
                  driver: 'chart'
                })}
                document={activeSummary?.chartDocument ?? null}
                onClose={() => void closeSession(active.canvasId)}
              />
            </div>
          )}

          {active && !launcherVisible && active.kind !== 'chart' && (
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
                  active.kind === 'web' ? (
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
