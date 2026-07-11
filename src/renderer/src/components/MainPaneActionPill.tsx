import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  ChatPopoutIcon,
  GhostCompanionIcon,
  InfoCircleIcon,
  PreviewSymbolIcon,
  SidebarCornerIcon
} from './AppChromeSymbols'

type MainPaneMenu = 'fx' | 'info' | null

export const MAIN_PANE_PRIMARY_ACTION_IDS = ['fx', 'info', 'popout', 'run', 'home'] as const
export const FX_MENU_ITEMS = [
  { id: 'sky', label: 'Weather/Sky' },
  { id: 'ghost', label: 'Ghost' }
] as const
export const INFO_MENU_ITEMS = [
  { id: 'changelog', label: 'Changelog' },
  { id: 'first-launch', label: 'First Launch' },
  { id: 'bug-report', label: 'Bug Report' }
] as const
export const MAIN_PANE_GLASS_POPOVER_CLASS =
  'side-chat-layout-menu composer-combined-picker-popover'

export interface MainPaneActionPillProps {
  /** Stable DOM-id scope. Multiview supplies one per pane to avoid duplicate
   * trigger/menu ids while the single focused pane keeps the legacy ids. */
  idScope?: string
  className?: string
  fxEnabled: boolean
  skyEnabled: boolean
  ghostEnabled: boolean
  weatherDescription?: string
  onToggleSky: () => void
  onToggleGhost: () => void
  changelogOpen: boolean
  firstLaunchOpen: boolean
  bugReportOpen: boolean
  onToggleChangelog: () => void
  onToggleFirstLaunch: () => void
  onToggleBugReport: () => void
  popoutMenuOpen: boolean
  setPopoutMenuOpen: Dispatch<SetStateAction<boolean>>
  popoutMenuRef: RefObject<HTMLDivElement | null>
  canOpenWorkspacePopout: boolean
  hasCurrentChat: boolean
  onOpenWorkbench: () => void
  onOpenDiffStudio: () => void
  onOpenFileEditor: () => void
  onOpenChatPopout: () => void
  runTitle: string
  runMenuOpen: boolean
  runHasMenu: boolean
  runDisabled: boolean
  runMenu?: ReactNode
  runError?: ReactNode
  onRun: () => void
  homeOpen: boolean
  onToggleHome: () => void
}

/** The shared pane glass pill intentionally exposes exactly five primary actions. */
export function MainPaneActionPill({
  idScope = 'chat-corner',
  className,
  fxEnabled,
  skyEnabled,
  ghostEnabled,
  weatherDescription,
  onToggleSky,
  onToggleGhost,
  changelogOpen,
  firstLaunchOpen,
  bugReportOpen,
  onToggleChangelog,
  onToggleFirstLaunch,
  onToggleBugReport,
  popoutMenuOpen,
  setPopoutMenuOpen,
  popoutMenuRef,
  canOpenWorkspacePopout,
  hasCurrentChat,
  onOpenWorkbench,
  onOpenDiffStudio,
  onOpenFileEditor,
  onOpenChatPopout,
  runTitle,
  runMenuOpen,
  runHasMenu,
  runDisabled,
  runMenu,
  runError,
  onRun,
  homeOpen,
  onToggleHome
}: MainPaneActionPillProps) {
  const [menu, setMenu] = useState<MainPaneMenu>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fxTriggerRef = useRef<HTMLButtonElement>(null)
  const infoTriggerRef = useRef<HTMLButtonElement>(null)
  const popoutTriggerRef = useRef<HTMLButtonElement>(null)
  const fxTriggerId = `${idScope}-fx-trigger`
  const fxMenuId = `${idScope}-fx-menu`
  const infoTriggerId = `${idScope}-info-trigger`
  const infoMenuId = `${idScope}-info-menu`

  useEffect(() => {
    if (!menu && !popoutMenuOpen) return
    const handlePointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setMenu(null)
      setPopoutMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const closingMenu = menu
      setMenu(null)
      setPopoutMenuOpen(false)
      if (closingMenu === 'fx') fxTriggerRef.current?.focus()
      else if (closingMenu === 'info') infoTriggerRef.current?.focus()
      else popoutTriggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menu, popoutMenuOpen, setPopoutMenuOpen])

  useEffect(() => {
    if (!menu) return
    const id = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
    }, 0)
    return () => window.clearTimeout(id)
  }, [menu])

  const toggleMenu = (next: Exclude<MainPaneMenu, null>): void => {
    setPopoutMenuOpen(false)
    setMenu((current) => (current === next ? null : next))
  }

  const runMenuAction = (
    action: () => void,
    returnFocusTo?: RefObject<HTMLButtonElement | null>
  ): void => {
    setMenu(null)
    action()
    if (returnFocusTo) window.setTimeout(() => returnFocusTo.current?.focus(), 0)
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      setMenu(null)
      setPopoutMenuOpen(false)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? (currentIndex <= 0 ? items.length : currentIndex) - 1
            : (currentIndex + 1) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <div
      ref={rootRef}
      className={`chat-corner-controls chat-corner-controls-right${className ? ` ${className}` : ''}`}
    >
      <div className="side-chat-menu-wrap chat-corner-picker-wrap">
        <button
          ref={fxTriggerRef}
          id={fxTriggerId}
          data-main-pane-action="fx"
          className={`chat-corner-btn ${menu === 'fx' || skyEnabled || ghostEnabled ? 'active' : ''}`}
          type="button"
          onClick={() => toggleMenu('fx')}
          title="Visual effects"
          aria-label="Choose visual effects"
          aria-haspopup="menu"
          aria-controls={fxMenuId}
          aria-expanded={menu === 'fx'}
        >
          <GhostCompanionIcon />
        </button>
        {menu === 'fx' && (
          <div
            ref={menuRef}
            id={fxMenuId}
            className={`${MAIN_PANE_GLASS_POPOVER_CLASS} chat-corner-picker-menu`}
            role="menu"
            aria-labelledby={fxTriggerId}
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              role="menuitemcheckbox"
              className={`chat-corner-picker-item${skyEnabled ? ' is-active' : ''}${!fxEnabled ? ' is-disabled' : ''}`}
              aria-checked={skyEnabled}
              aria-disabled={!fxEnabled}
              onClick={() => {
                if (fxEnabled) runMenuAction(onToggleSky, fxTriggerRef)
              }}
            >
              <span>{FX_MENU_ITEMS[0].label}</span>
              <small>
                {!fxEnabled ? 'Enable Epic FX in Settings' : skyEnabled ? 'On' : 'Off'}
                {weatherDescription ? ` · ${weatherDescription}` : ''}
              </small>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              className={`chat-corner-picker-item${ghostEnabled ? ' is-active' : ''}${!fxEnabled ? ' is-disabled' : ''}`}
              aria-checked={ghostEnabled}
              aria-disabled={!fxEnabled}
              onClick={() => {
                if (fxEnabled) runMenuAction(onToggleGhost, fxTriggerRef)
              }}
            >
              <span>{FX_MENU_ITEMS[1].label}</span>
              <small>
                {!fxEnabled ? 'Enable Epic FX in Settings' : ghostEnabled ? 'On' : 'Off'}
              </small>
            </button>
          </div>
        )}
      </div>

      <div className="side-chat-menu-wrap chat-corner-picker-wrap">
        <button
          ref={infoTriggerRef}
          id={infoTriggerId}
          data-main-pane-action="info"
          className={`chat-corner-btn ${menu === 'info' || changelogOpen || firstLaunchOpen || bugReportOpen ? 'active' : ''}`}
          type="button"
          onClick={() => toggleMenu('info')}
          title="Product information"
          aria-label="Choose product information"
          aria-haspopup="menu"
          aria-controls={infoMenuId}
          aria-expanded={menu === 'info'}
        >
          <InfoCircleIcon />
        </button>
        {menu === 'info' && (
          <div
            ref={menuRef}
            id={infoMenuId}
            className={`${MAIN_PANE_GLASS_POPOVER_CLASS} chat-corner-picker-menu`}
            role="menu"
            aria-labelledby={infoTriggerId}
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              className="chat-corner-picker-item"
              onClick={() => runMenuAction(onToggleChangelog)}
            >
              <span>{INFO_MENU_ITEMS[0].label}</span>
              <small>What changed in this release</small>
            </button>
            <button
              type="button"
              role="menuitem"
              className="chat-corner-picker-item"
              onClick={() => runMenuAction(onToggleFirstLaunch)}
            >
              <span>{INFO_MENU_ITEMS[1].label}</span>
              <small>Open the onboarding guide</small>
            </button>
            <button
              type="button"
              role="menuitem"
              className="chat-corner-picker-item"
              onClick={() => runMenuAction(onToggleBugReport)}
            >
              <span>{INFO_MENU_ITEMS[2].label}</span>
              <small>Report an issue or share feedback</small>
            </button>
          </div>
        )}
      </div>

      <div className="chat-popout-menu-wrap" ref={popoutMenuRef}>
        <button
          ref={popoutTriggerRef}
          data-main-pane-action="popout"
          className={`chat-corner-btn ${popoutMenuOpen ? 'active' : ''}`}
          type="button"
          onClick={() => {
            setMenu(null)
            setPopoutMenuOpen((open) => !open)
          }}
          title="Open popout tools"
          aria-label="Open popout tools"
          aria-haspopup="menu"
          aria-expanded={popoutMenuOpen}
          disabled={!canOpenWorkspacePopout && !hasCurrentChat}
        >
          <ChatPopoutIcon />
        </button>
        {popoutMenuOpen && (
          <div
            className={`${MAIN_PANE_GLASS_POPOVER_CLASS} chat-popout-menu`}
            role="menu"
            aria-label="Popout tools"
          >
            <button
              type="button"
              role="menuitem"
              onClick={onOpenWorkbench}
              disabled={!canOpenWorkspacePopout}
            >
              <span>Workbench</span>
              <small>Open files and diffs together</small>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={onOpenDiffStudio}
              disabled={!canOpenWorkspacePopout}
            >
              <span>Diff Studio</span>
              <small>Open workspace diff tools</small>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={onOpenFileEditor}
              disabled={!canOpenWorkspacePopout}
            >
              <span>File Editor</span>
              <small>Open workspace files</small>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={onOpenChatPopout}
              disabled={!hasCurrentChat}
            >
              <span>Pop-Out Chat</span>
              <small>Open this thread in a separate window</small>
            </button>
          </div>
        )}
      </div>

      <div className="side-chat-menu-wrap pane-preview-menu-wrap" data-preview-menu-root="true">
        <button
          data-main-pane-action="run"
          className={`chat-corner-btn ${runMenuOpen ? 'active' : ''}`}
          type="button"
          onClick={() => {
            setMenu(null)
            setPopoutMenuOpen(false)
            onRun()
          }}
          title={runTitle}
          aria-label="Run build or preview"
          aria-haspopup={runHasMenu ? 'menu' : undefined}
          aria-expanded={runHasMenu ? runMenuOpen : undefined}
          aria-pressed={runMenuOpen}
          disabled={runDisabled}
        >
          <PreviewSymbolIcon />
        </button>
        {runMenu}
        {runError}
      </div>

      <button
        data-main-pane-action="home"
        className={`chat-corner-btn ${homeOpen ? 'active' : ''}`}
        type="button"
        onClick={() => {
          setMenu(null)
          setPopoutMenuOpen(false)
          onToggleHome()
        }}
        title={homeOpen ? 'Hide sidebar home' : 'Open sidebar home'}
        aria-label="Toggle sidebar home"
        aria-pressed={homeOpen}
      >
        <SidebarCornerIcon direction="right" isOpen={homeOpen} />
      </button>
    </div>
  )
}
