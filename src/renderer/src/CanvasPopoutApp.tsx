import { useCallback, useEffect, useState } from 'react'
import type { ChatRecord } from '../../main/store/types'
import type {
  CanvasPopoutOpenInput,
  CanvasPopoutSessionSeed,
  CanvasPopoutSurface
} from '../../main/canvas/CanvasPopoutWindowManager'
import { CanvasDockPanel } from './components/CanvasDockPanel'
import { useAppearance } from './hooks/useAppearance'
import {
  ChatMediaDockPanel,
  collectChatMediaRefs,
  type ChatMediaRef
} from './components/ChatMediaPanel'

const POPOUT_SURFACES = new Set<CanvasPopoutSurface>([
  'browser',
  'sketch',
  'mesh',
  'simulator',
  'media'
])

export function parseCanvasPopoutRequest(params: URLSearchParams): CanvasPopoutOpenInput | null {
  const chatId = params.get('chat') || ''
  const rawSurface = params.get('surface') as CanvasPopoutSurface | null
  if (!chatId || !rawSurface || !POPOUT_SURFACES.has(rawSurface)) return null
  const canvasId = params.get('canvas') || ''
  const canvasKind = params.get('canvasKind')
  let session: CanvasPopoutSessionSeed | undefined
  if (canvasId && (canvasKind === 'web' || canvasKind === 'sketch')) {
    session = {
      canvasId,
      kind: canvasKind,
      ...(params.get('url') ? { url: params.get('url')! } : {}),
      ...(params.get('title') ? { title: params.get('title')! } : {})
    }
  }
  return { chatId, surface: rawSurface, ...(session ? { session } : {}) }
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

function MediaCanvasPopout({ chatId }: { chatId: string }) {
  const [refs, setRefs] = useState<ChatMediaRef[]>([])
  const [workspacePath, setWorkspacePath] = useState<string | undefined>()
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const chat = (await window.api.getChat(chatId)) as ChatRecord | null
      setWorkspacePath(chat?.workspacePath || undefined)
      setRefs(collectChatMediaRefs(chat, [], []))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Media Viewer could not be refreshed.')
    }
  }, [chatId])

  useEffect(() => {
    void refresh()
    return window.api.canvas.onPopoutChatUpdated((payload) => {
      if (payload.chatId === chatId) void refresh()
    })
  }, [chatId, refresh])

  const showInDock = async (): Promise<void> => {
    setError('')
    const result = await window.api.canvas.dockPopout({ chatId, surface: 'media' })
    if (!result.ok) setError(result.error)
  }

  return (
    <main className="canvas-popout-root">
      <div className="canvas-dock-panel canvas-popout-media" aria-label="Media Viewer Canvas">
        <div className="canvas-dock-toolbar">
          <div className="canvas-dock-tabs" role="tablist" aria-label="Open canvases">
            <button
              type="button"
              role="tab"
              aria-selected="true"
              className="canvas-dock-tab is-active"
            >
              <span className="canvas-dock-tab-label">Media Viewer</span>
            </button>
          </div>
          <div className="canvas-dock-toolbar-actions">
            <button
              type="button"
              className="canvas-dock-placement"
              onClick={() => void showInDock()}
              aria-label="Show Media Viewer in dock"
              title="Show in dock"
            >
              <DockGlyph />
              <span>Dock</span>
            </button>
          </div>
        </div>
        {error ? (
          <div className="canvas-dock-error" role="alert">
            {error}
          </div>
        ) : null}
        <ChatMediaDockPanel
          refs={refs}
          workspacePath={workspacePath}
          onClose={() => window.close()}
        />
      </div>
    </main>
  )
}

export function CanvasPopoutApp() {
  useAppearance()
  const [request, setRequest] = useState<CanvasPopoutOpenInput | null>(() =>
    parseCanvasPopoutRequest(new URLSearchParams(window.location.search))
  )

  useEffect(() => {
    return window.api.canvas.onPopoutOpenSurface((payload) => {
      if (!payload || payload.chatId !== request?.chatId) return
      setRequest(payload)
    })
  }, [request?.chatId])

  if (!request) {
    return (
      <main className="canvas-popout-root">
        <section className="popout-error" role="alert">
          <strong>Canvas unavailable</strong>
          <span>This window is missing its chat or Canvas surface.</span>
        </section>
      </main>
    )
  }

  if (request.surface === 'media') return <MediaCanvasPopout chatId={request.chatId} />

  return (
    <main className="canvas-popout-root">
      <CanvasDockPanel
        chatId={request.chatId}
        host="popout"
        initialSurface={request.surface}
        initialSession={request.session}
      />
    </main>
  )
}
