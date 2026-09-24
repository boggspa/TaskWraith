/**
 * CanvasBrowserChrome — the single-pane browser chrome for a web Canvas:
 * back / forward / reload-stop, an editable address bar, and an
 * open-in-default-browser affordance, styled on the dock's neutral language.
 *
 * The page itself is a main-process WebContentsView; this component only
 * renders chrome and calls the chat-scoped navigate IPC. Live state (url,
 * title, loading, history depth) streams in over `canvas-nav-state` and is
 * seeded from the session summary so the bar is truthful before the first
 * navigation event.
 */
import { useEffect, useRef, useState } from 'react'
import {
  browserAddressDisplay,
  isNavigableCanvasUrl,
  normalizeBrowserUrlInput
} from '../lib/canvasBrowserUrl'

export interface CanvasBrowserNavState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface CanvasBrowserChromeProps {
  chatId: string
  canvasId: string
  initialState: Partial<CanvasBrowserNavState>
  onNavigateError?: (message: string) => void
}

/** Defensive decode of a nav-state push that crossed the IPC bridge. */
export function toCanvasBrowserNavState(payload: unknown): CanvasBrowserNavState | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { state?: unknown }
  const state = record.state as Partial<CanvasBrowserNavState> | undefined
  if (!state || typeof state !== 'object') return null
  return {
    url: typeof state.url === 'string' ? state.url : '',
    title: typeof state.title === 'string' ? state.title : '',
    isLoading: state.isLoading === true,
    canGoBack: state.canGoBack === true,
    canGoForward: state.canGoForward === true
  }
}

function BackGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10 3.5 5.5 8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ForwardGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ReloadGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2.75V6.5H9.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StopGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ExternalGlyph() {
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

export function CanvasBrowserChrome({
  chatId,
  canvasId,
  initialState,
  onNavigateError
}: CanvasBrowserChromeProps) {
  const [nav, setNav] = useState<CanvasBrowserNavState>({
    url: initialState.url ?? '',
    title: initialState.title ?? '',
    isLoading: initialState.isLoading === true,
    canGoBack: initialState.canGoBack === true,
    canGoForward: initialState.canGoForward === true
  })
  // While the human is typing, live pushes must not clobber the draft.
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  useEffect(() => {
    const api = window.api?.canvas
    if (!api?.onNavState) return
    return api.onNavState((payload) => {
      const record = payload as { canvasId?: unknown } | null
      if (!record || record.canvasId !== canvasId) return
      const state = toCanvasBrowserNavState(payload)
      if (state) setNav(state)
    })
  }, [canvasId])

  const navigate = async (input: {
    url?: string
    action?: 'back' | 'forward' | 'reload' | 'stop'
  }): Promise<void> => {
    const api = window.api?.canvas
    if (!api?.navigateForChat) {
      onNavigateError?.('Browser navigation needs the updated preload bridge. Restart TaskWraith.')
      return
    }
    setBusy(true)
    try {
      const result = await api.navigateForChat(chatIdRef.current, canvasId, input)
      if (result.ok) {
        setNav({
          url: result.url,
          title: result.title,
          isLoading: result.isLoading,
          canGoBack: result.canGoBack,
          canGoForward: result.canGoForward
        })
        setDraft(null)
      } else {
        onNavigateError?.(result.error)
      }
    } catch (err) {
      onNavigateError?.(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitAddress = (): void => {
    const raw = draft ?? ''
    const normalized = normalizeBrowserUrlInput(raw)
    if (!normalized) {
      onNavigateError?.('Enter a web address like https://example.com or localhost:3000.')
      return
    }
    inputRef.current?.blur()
    void navigate({ url: normalized })
  }

  const navigable = isNavigableCanvasUrl(nav.url)
  const addressValue = draft ?? browserAddressDisplay(nav.url)
  const secure = navigable && nav.url.startsWith('https:')

  return (
    <div className="canvas-browser-chrome" role="toolbar" aria-label="Browser controls">
      <button
        type="button"
        className="canvas-browser-nav-button"
        onClick={() => void navigate({ action: 'back' })}
        disabled={busy || !nav.canGoBack}
        aria-label="Back"
        title="Back"
      >
        <BackGlyph />
      </button>
      <button
        type="button"
        className="canvas-browser-nav-button"
        onClick={() => void navigate({ action: 'forward' })}
        disabled={busy || !nav.canGoForward}
        aria-label="Forward"
        title="Forward"
      >
        <ForwardGlyph />
      </button>
      <button
        type="button"
        className="canvas-browser-nav-button"
        onClick={() => void navigate({ action: nav.isLoading ? 'stop' : 'reload' })}
        disabled={busy}
        aria-label={nav.isLoading ? 'Stop loading' : 'Reload'}
        title={nav.isLoading ? 'Stop loading' : 'Reload'}
      >
        {nav.isLoading ? <StopGlyph /> : <ReloadGlyph />}
      </button>
      <div className={`canvas-browser-address${nav.isLoading ? ' is-loading' : ''}`}>
        <span
          className={`canvas-browser-address-scheme${secure ? ' is-secure' : ''}`}
          aria-hidden="true"
        >
          {secure ? (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <rect
                x="3.5"
                y="7"
                width="9"
                height="6"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M2.5 8h11M8 2.5c-3.4 3.2-3.4 7.8 0 11M8 2.5c3.4 3.2 3.4 7.8 0 11"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="canvas-browser-address-input"
          value={addressValue}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Enter a web address"
          aria-label="Address"
          title={nav.url || undefined}
          onFocus={(e) => {
            // Edit the FULL url, pre-selected — one keystroke replaces it.
            setDraft(nav.url === 'about:blank' ? '' : nav.url)
            requestAnimationFrame(() => e.target.select())
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAddress()
            if (e.key === 'Escape') {
              setDraft(null)
              inputRef.current?.blur()
            }
          }}
        />
        {nav.isLoading && <span className="canvas-browser-progress" aria-hidden="true" />}
      </div>
      <button
        type="button"
        className="canvas-browser-nav-button"
        onClick={() => {
          if (navigable) void window.api?.openExternalOrPath?.(nav.url)
        }}
        disabled={!navigable}
        aria-label="Open in default browser"
        title="Open in default browser"
      >
        <ExternalGlyph />
      </button>
    </div>
  )
}
