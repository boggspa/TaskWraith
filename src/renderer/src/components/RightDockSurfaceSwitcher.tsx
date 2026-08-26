import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { RightDockTab } from '../lib/rightDockState'

/**
 * Right-dock surface switcher + ⌘K palette (1.5 corporate-clean redesign).
 *
 * Replaces the old two-tier glyph rail. The dock header is one slim row: the
 * active surface (icon + name) doubles as a switcher button that opens a
 * grouped, labeled, card-style popover — the "pick an environment" moment,
 * Codex-style — plus a ⌘K hint and a close control. Every destination carries a
 * real label, a one-line hint and a neutral count badge, so navigation stops
 * being a wall of unlabeled icons.
 *
 * ⌘K opens the same popover in COMMAND mode: a search box over a flat list that
 * spans the surfaces AND flattens the Inspector's sub-views (Diff / Safety / …)
 * as first-class jump targets — the power-user accelerator. Styled entirely on
 * the neutral --rightdock-* token family (accent rationed to the focus ring);
 * no vibey toggle — permanently corporate.
 */

export interface RightDockSurfaceDef {
  id: RightDockTab
  label: string
  icon: ReactNode
  enabled: boolean
  badge?: number
  group: 'session' | 'work' | 'inspect'
  hint?: string
}

export type RightDockCanvasSurface = 'browser' | 'sketch' | 'mesh' | 'simulator'

export const RIGHT_DOCK_CANVAS_SURFACES: ReadonlyArray<{
  id: RightDockCanvasSurface
  label: string
  hint: string
}> = [
  { id: 'browser', label: 'Browser', hint: 'Empty browser with its own address bar' },
  { id: 'sketch', label: 'Sketch Canvas', hint: 'Shapes, freehand marks, arrows & text' },
  { id: 'mesh', label: 'Mesh Canvas', hint: 'Local 3D scenes and models' },
  { id: 'simulator', label: 'Simulator Canvas', hint: 'Live iOS Simulator preview' }
]

/** Lightweight id/label pair for the Inspector's 7 sub-views, flattened into
 * the ⌘K palette so power users can jump straight to Diff / Safety / etc. */
export interface RightDockInspectorViewDef {
  id: string
  label: string
}

const GROUP_ORDER: ReadonlyArray<{ id: RightDockSurfaceDef['group']; label: string }> = [
  { id: 'session', label: 'Session' },
  { id: 'work', label: 'Work' },
  { id: 'inspect', label: 'Inspect' }
]

/** Why a surface is unavailable — shown on disabled cards so the dead state
 * explains itself instead of just dimming. Mirrors the old rail tooltips. */
const DISABLED_REASON: Partial<Record<RightDockTab, string>> = {
  chat: 'Open a side chat from a message first',
  files: 'Files need a bound workspace',
  office: 'Office needs a bound workspace',
  pins: 'Open a chat first'
}

interface RightDockSurfaceSwitcherProps {
  tabs: RightDockSurfaceDef[]
  activeTab: RightDockTab
  onActivate: (id: RightDockTab) => void
  onClose: () => void
  /** Canvas is one dock tab but four distinct launchable surfaces. */
  onActivateCanvasSurface?: (surface: RightDockCanvasSurface) => void
  /** Inspector sub-views, flattened into the ⌘K palette (optional). */
  inspectorTabs?: RightDockInspectorViewDef[]
  activeInspectorTab?: string
  onSelectInspectorTab?: (id: string) => void
}

export function RightDockSurfaceSwitcher({
  tabs,
  activeTab,
  onActivate,
  onClose,
  onActivateCanvasSurface,
  inspectorTabs,
  activeInspectorTab,
  onSelectInspectorTab
}: RightDockSurfaceSwitcherProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'menu' | 'command'>('menu')
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]

  // Outside-click + Escape dismiss (only while open).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        // Return focus to the trigger on keyboard dismiss (menu a11y convention).
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // ⌘K / Ctrl+K toggles the command palette (global while the dock is mounted).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') ||
        event.defaultPrevented
      ) {
        return
      }
      // Don't hijack the keystroke while the user is typing in an editable
      // element (incl. macOS Ctrl+K "kill line", or composing a message) —
      // except our own search box, so ⌘K can still toggle the palette closed.
      const target = event.target as HTMLElement | null
      const editable =
        !!target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
      if (editable && target !== searchRef.current) return
      event.preventDefault()
      if (open && mode === 'command') {
        setOpen(false)
        return
      }
      setMode('command')
      setQuery('')
      setOpen(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, mode])

  // Focus the search box whenever the command palette opens.
  useEffect(() => {
    if (open && mode === 'command') {
      const id = window.setTimeout(() => searchRef.current?.focus(), 0)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open, mode])

  const openMenu = (): void => {
    if (open && mode === 'menu') {
      setOpen(false)
      return
    }
    setMode('menu')
    setOpen(true)
  }

  const openCommand = (): void => {
    setMode('command')
    setQuery('')
    setOpen(true)
  }

  const pickSurface = (id: RightDockTab, enabled: boolean): void => {
    if (!enabled) return
    onActivate(id)
    setOpen(false)
  }

  const pickInspectorView = (id: string): void => {
    onSelectInspectorTab?.(id)
    setOpen(false)
  }

  const pickCanvasSurface = (surface: RightDockCanvasSurface): void => {
    onActivateCanvasSurface?.(surface)
    setOpen(false)
  }

  // Command-mode filtered results across surfaces + inspector views.
  const q = query.trim().toLowerCase()
  const surfaceResults = useMemo(
    () => tabs.filter((tab) => tab.enabled && (!q || tab.label.toLowerCase().includes(q))),
    [tabs, q]
  )
  const inspectorResults = useMemo(
    () => (inspectorTabs ?? []).filter((view) => !q || view.label.toLowerCase().includes(q)),
    [inspectorTabs, q]
  )
  const noResults = surfaceResults.length === 0 && inspectorResults.length === 0

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (surfaceResults.length > 0) pickSurface(surfaceResults[0].id, true)
      else if (inspectorResults.length > 0) pickInspectorView(inspectorResults[0].id)
    }
  }

  return (
    <div className="right-dock-header" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`right-dock-switcher${open && mode === 'menu' ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open && mode === 'menu'}
        aria-label={`Current surface: ${active?.label ?? 'Surfaces'}. Choose a surface`}
        onClick={openMenu}
      >
        <span className="right-dock-switcher-icon" aria-hidden>
          {active?.icon}
        </span>
        <span className="right-dock-switcher-label">{active?.label ?? 'Surfaces'}</span>
        <svg
          className="right-dock-switcher-caret"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        type="button"
        className="right-dock-cmdk-hint"
        onClick={openCommand}
        title="Search surfaces (⌘K)"
        aria-label="Search surfaces"
      >
        ⌘K
      </button>
      <button
        type="button"
        className="right-dock-close"
        onClick={onClose}
        title="Close surface"
        aria-label="Close surface"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      {open && mode === 'menu' && (
        <div className="right-dock-surface-menu" role="menu" aria-label="Surfaces">
          {GROUP_ORDER.map((group) => {
            const items = tabs.filter((tab) => tab.group === group.id)
            if (items.length === 0) return null
            return (
              <div className="right-dock-surface-group" key={group.id}>
                <div className="right-dock-surface-group-label">{group.label}</div>
                {items.map((tab) => {
                  if (tab.id === 'canvas' && onActivateCanvasSurface) {
                    return RIGHT_DOCK_CANVAS_SURFACES.map((surface) => (
                      <button
                        key={`canvas-${surface.id}`}
                        type="button"
                        role="menuitem"
                        className={`right-dock-surface-card${tab.enabled ? '' : ' disabled'}`}
                        disabled={!tab.enabled}
                        title={tab.enabled ? undefined : 'Open a chat first'}
                        onClick={() => pickCanvasSurface(surface.id)}
                      >
                        <span className="right-dock-surface-card-icon" aria-hidden>
                          <CanvasChoiceIcon kind={surface.id} />
                        </span>
                        <span className="right-dock-surface-card-main">
                          <span className="right-dock-surface-card-title">{surface.label}</span>
                          <span className="right-dock-surface-card-hint">{surface.hint}</span>
                        </span>
                      </button>
                    ))
                  }
                  const isActive = tab.id === activeTab
                  const reason = tab.enabled ? tab.hint : (DISABLED_REASON[tab.id] ?? tab.hint)
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      className={`right-dock-surface-card${isActive ? ' active' : ''}${
                        tab.enabled ? '' : ' disabled'
                      }`}
                      disabled={!tab.enabled}
                      title={tab.enabled ? undefined : DISABLED_REASON[tab.id]}
                      onClick={() => pickSurface(tab.id, tab.enabled)}
                    >
                      <span className="right-dock-surface-card-icon" aria-hidden>
                        {tab.icon}
                      </span>
                      <span className="right-dock-surface-card-main">
                        <span className="right-dock-surface-card-title">{tab.label}</span>
                        {reason && <span className="right-dock-surface-card-hint">{reason}</span>}
                      </span>
                      {typeof tab.badge === 'number' && tab.badge > 0 && (
                        <span className="right-dock-surface-card-badge">
                          {tab.badge > 99 ? '99+' : tab.badge}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {open && mode === 'command' && (
        <div
          className="right-dock-surface-menu right-dock-command"
          role="dialog"
          aria-label="Jump to a surface"
        >
          <div className="right-dock-command-search">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4-4" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder="Jump to a surface or inspector view…"
              aria-label="Search surfaces and inspector views"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            <span className="right-dock-command-esc">esc</span>
          </div>
          <div className="right-dock-command-list">
            {surfaceResults.length > 0 && (
              <div className="right-dock-surface-group">
                <div className="right-dock-surface-group-label">Surfaces</div>
                {surfaceResults.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`right-dock-command-item${tab.id === activeTab ? ' active' : ''}`}
                    onClick={() => pickSurface(tab.id, tab.enabled)}
                  >
                    <span className="right-dock-command-item-icon" aria-hidden>
                      {tab.icon}
                    </span>
                    <span className="right-dock-command-item-label">{tab.label}</span>
                    {typeof tab.badge === 'number' && tab.badge > 0 && (
                      <span className="right-dock-surface-card-badge">
                        {tab.badge > 99 ? '99+' : tab.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {inspectorResults.length > 0 && (
              <div className="right-dock-surface-group">
                <div className="right-dock-surface-group-label">Inspector views</div>
                {inspectorResults.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    className={`right-dock-command-item${
                      activeTab === 'inspector' && view.id === activeInspectorTab ? ' active' : ''
                    }`}
                    onClick={() => pickInspectorView(view.id)}
                  >
                    <span className="right-dock-command-item-icon" aria-hidden>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
                        <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
                      </svg>
                    </span>
                    <span className="right-dock-command-item-label">{view.label}</span>
                  </button>
                ))}
              </div>
            )}
            {noResults && <div className="right-dock-command-empty">No matching surfaces.</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function CanvasChoiceIcon({ kind }: { kind: RightDockCanvasSurface }) {
  if (kind === 'browser') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="8" />
        <path d="M4 12h16M12 4c2.4 2.5 3.6 5.2 3.6 8S14.4 17.5 12 20c-2.4-2.5-3.6-5.2-3.6-8S9.6 6.5 12 4Z" />
      </svg>
    )
  }
  if (kind === 'sketch') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="m5 18 1-4L16.5 3.5a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L10 18l-4 1Z" />
        <path d="m14.8 5.2 4 4" />
      </svg>
    )
  }
  if (kind === 'mesh') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
        <path d="m4.3 7.7 7.7 4.4 7.7-4.4M12 12.1V21" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M10 6h4M11 18h2" />
    </svg>
  )
}
