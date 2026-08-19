import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

/**
 * Action item rendered inside the sidebar tile overflow menu. Items can be
 * grouped via the `group` discriminator: items in the same group render
 * together, the menu inserts a thin divider between groups so destructive
 * actions (delete) stay visually separated from neutral ones (pin, archive).
 */
export interface SidebarOverflowMenuItem {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  group?: 'primary' | 'secondary' | 'destructive'
}

interface SidebarOverflowMenuProps {
  /** Accessible label for the trigger button. Keeps the dots glyph
   * announceable for screen readers. */
  triggerLabel?: string
  /** Items to render in the menu. `undefined`-returning suppliers can be
   * trimmed by the caller before passing in. Empty list → menu trigger
   * still renders for layout consistency but presses no-op. */
  items: SidebarOverflowMenuItem[]
  /** When true the trigger button stays visible even at rest. Otherwise
   * the trigger fades in on tile hover via CSS (the tile is responsible
   * for setting :hover scope). */
  alwaysVisible?: boolean
  /** Optional className on the trigger button. */
  className?: string
}

const GROUP_ORDER: NonNullable<SidebarOverflowMenuItem['group']>[] = [
  'primary',
  'secondary',
  'destructive'
]

/**
 * Decide whether a capture-phase scroll event should dismiss an open menu.
 *
 * The popover is `position: fixed`, anchored to the trigger's bounding rect,
 * so it only goes stale when the trigger itself moves — that is, when a
 * scroll container the trigger lives INSIDE scrolls (the sidebar list, or the
 * document). A scroll anywhere else leaves the anchor exactly where it was
 * and must be ignored.
 *
 * This matters because the listener has to capture from `window` to see
 * nested scrolls at all, which also hands it every unrelated one. The
 * transcript pane pins itself to the live edge on every streaming delta, so
 * an unfiltered dismissal closed the menu roughly as fast as it could be
 * opened — the sidebar menus were usable only on a silent thread.
 *
 * Duck-types `contains` rather than testing `instanceof Node`: the same check
 * then covers `Document` (page-level scroll) and `Element` (container scroll)
 * alike, and stays callable in the renderer's DOM-less test environment.
 */
export function scrollDismissesMenu(
  scrollTarget: EventTarget | null,
  trigger: Node | null
): boolean {
  if (!scrollTarget || !trigger) return false
  const container = scrollTarget as { contains?: (node: Node) => boolean }
  if (typeof container.contains !== 'function') return false
  return container.contains(trigger)
}

/**
 * Sidebar tile overflow menu. Tap the `…` glyph to open a popover with the
 * tile's actions; tap outside or press Escape to dismiss.
 *
 * The popover is rendered via `createPortal` into `document.body` and
 * positioned with `position: fixed` against the trigger's bounding rect.
 * This frees it from any sidebar scroll container's `overflow: hidden|auto`
 * (which would otherwise clip the menu and make items invisible/unclickable
 * — same pattern as `AgentMentionMenu`).
 */
export function SidebarOverflowMenu({
  triggerLabel = 'More actions',
  items,
  alwaysVisible = false,
  className
}: SidebarOverflowMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [position, setPosition] = useState<{ top: number; left?: number; right?: number } | null>(
    null
  )
  // When the menu is opened via right-click on the host tile we anchor it to
  // the pointer (left/top) instead of the trigger's right edge. Cleared on a
  // normal trigger open so the click path keeps its under-trigger placement.
  const pointerOpenRef = useRef<{ x: number; y: number } | null>(null)
  // Trigger is rendered as a <span role="button"> rather than a real
  // <button> because tile rows are themselves buttons (chat tile = full
  // row click target) and nesting actual buttons is invalid HTML; the
  // sidebar uses the span+role pattern throughout for the same reason.
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  // Sort items by group so destructive lands at the bottom regardless of
  // caller ordering. Within a group, original order is preserved.
  const orderedItems = [...items].sort((a, b) => {
    const groupA = GROUP_ORDER.indexOf(a.group || 'primary')
    const groupB = GROUP_ORDER.indexOf(b.group || 'primary')
    return groupA - groupB
  })

  // Right-align the popover to the trigger's right edge; sit 4px below.
  // Expressed as a `right` offset from the viewport edge so the popover
  // doesn't slide off-screen on a narrow window.
  const updatePosition = useCallback(() => {
    const point = pointerOpenRef.current
    if (point) {
      // Pointer-anchored (right-click): left-align to the cursor so the menu
      // opens rightward into the screen (the sidebar sits at the left edge),
      // clamped so it can't spill off the right/bottom.
      const menuWidth = 188
      const menuHeightEstimate = 44 * Math.max(1, orderedItems.length) + 16
      const left = Math.min(Math.max(8, point.x), window.innerWidth - menuWidth)
      const top = Math.min(point.y, Math.max(8, window.innerHeight - menuHeightEstimate))
      setPosition({ top, left })
      return
    }
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const right = Math.max(8, window.innerWidth - rect.right)
    const top = rect.bottom + 4
    setPosition({ top, right })
  }, [orderedItems.length])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const handleDocumentMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  // Close on ancestor scroll (sidebar lists scroll, and we'd otherwise leave
  // a stale popover floating where the trigger used to be). Reposition on
  // viewport resize so the menu tracks layout changes.
  //
  // The scroll listener is registered with `capture: true` because scroll
  // events do not bubble — capturing from `window` is the only way to observe
  // a scroll inside a nested container. The cost is that it observes EVERY
  // scroll container in the app, so the dismissal has to be filtered down to
  // the ones that actually move this trigger (see `scrollDismissesMenu`).
  useEffect(() => {
    if (!open) return
    const handleScroll = (event: Event) => {
      if (!scrollDismissesMenu(event.target, triggerRef.current)) return
      setOpen(false)
    }
    const handleResize = () => updatePosition()
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
    }
  }, [open, updatePosition])

  // Reset focused index when menu closes so opening it again starts fresh.
  useEffect(() => {
    if (open) return
    pointerOpenRef.current = null
    const frame = window.requestAnimationFrame(() => setFocusedIndex(-1))
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  // Right-click anywhere on the host tile opens this same actions menu at the
  // pointer. The menu already lives inside each tile (chats, pinned, recents,
  // workspaces), so attaching to the closest interactive ancestor gives every
  // sidebar row a native-feeling context menu with zero per-tile wiring.
  useEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    // Resolve the enclosing tile row. Start from the menu wrapper (trigger's
    // parent) so we skip the trigger itself — the trigger is a role="button"
    // span, which a plain `closest('[role=button]')` would wrongly match.
    const host =
      (trigger.parentElement?.closest(
        '.sidebar-item, .sidebar-pinned-item, .sidebar-recents-item, .sidebar-workspace-board-item'
      ) as HTMLElement | null) ?? null
    if (!host) return
    const handleContextMenu = (event: globalThis.MouseEvent): void => {
      if (items.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      pointerOpenRef.current = { x: event.clientX, y: event.clientY }
      setOpen(true)
      setFocusedIndex(0)
    }
    host.addEventListener('contextmenu', handleContextMenu)
    return () => host.removeEventListener('contextmenu', handleContextMenu)
  }, [items.length])

  const handleTriggerClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    // Trigger-click anchors under the dots glyph, not the last right-click point.
    pointerOpenRef.current = null
    setOpen((current) => !current)
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      pointerOpenRef.current = null
      setOpen(true)
      setFocusedIndex(0)
    }
  }

  const handleItemSelect = (item: SidebarOverflowMenuItem) => {
    if (item.disabled) return
    setOpen(false)
    // Run the action after closing so any selection state in the menu
    // doesn't survive into the action's React updates.
    queueMicrotask(item.onSelect)
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setFocusedIndex((index) => Math.min(orderedItems.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setFocusedIndex((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const target = orderedItems[focusedIndex]
      if (target) handleItemSelect(target)
    }
  }

  const triggerStyle: CSSProperties = alwaysVisible
    ? { opacity: 1 }
    : { opacity: open ? 1 : undefined }

  const popover =
    open && position
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            className="sidebar-overflow-menu-popover"
            style={{
              position: 'fixed',
              top: position.top,
              ...(position.left !== undefined
                ? { left: position.left }
                : { right: position.right }),
              zIndex: 50
            }}
            onKeyDown={handleMenuKeyDown}
          >
            {orderedItems.map((item, index) => {
              const lastInGroup =
                index < orderedItems.length - 1 &&
                (orderedItems[index + 1].group || 'primary') !== (item.group || 'primary')
              return (
                <div key={item.id} className="sidebar-overflow-menu-item-wrap">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    className={`sidebar-overflow-menu-item ${item.danger ? 'is-danger' : ''} ${
                      focusedIndex === index ? 'is-focused' : ''
                    }`}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      handleItemSelect(item)
                    }}
                    onMouseEnter={() => setFocusedIndex(index)}
                  >
                    {item.icon && (
                      <span className="sidebar-overflow-menu-item-icon" aria-hidden>
                        {item.icon}
                      </span>
                    )}
                    <span className="sidebar-overflow-menu-item-label">{item.label}</span>
                  </button>
                  {lastInGroup && <div className="sidebar-overflow-menu-divider" aria-hidden />}
                </div>
              )
            })}
          </div>,
          document.body
        )
      : null

  return (
    <span className={`sidebar-overflow-menu ${open ? 'is-open' : ''}`}>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        className={`sidebar-item-action sidebar-overflow-trigger ${className || ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        style={triggerStyle}
      >
        <span className="sf-symbol-icon" aria-hidden>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" role="img">
            <circle cx="3.2" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="12.8" cy="8" r="1.4" />
          </svg>
        </span>
      </span>
      {popover}
    </span>
  )
}
