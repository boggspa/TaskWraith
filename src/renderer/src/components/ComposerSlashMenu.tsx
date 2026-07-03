import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle } from '../../../main/store/types'
import {
  COMPOSER_SLASH_GROUP_ORDER,
  filterComposerSlashCommands,
  type CommandPaletteGroup,
  type ComposerSlashCommand
} from '../lib/ComposerSlashCommands'

interface ComposerSlashMenuProps {
  /** Caller-controlled visibility. Parent toggles open on `/` keystroke. */
  open: boolean
  /** Anchor element (the composer textarea) used to position the popover. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Filter substring — the text the user has typed AFTER the leading `/`. */
  query: string
  /** Full registry of slash commands available in the current chat / provider
   * context. The picker filters this list against `query` internally. */
  commands: ComposerSlashCommand[]
  /** Replace the slash token in the prompt with the selected command. */
  onPick: (command: ComposerSlashCommand) => void
  /** Dismiss without picking (Escape, click outside, blur). */
  onDismiss: () => void
  /**
   * 1.0.6-EW67 — Active composer shell, mirrored onto the portal
   * root as `shell-${composerStyle}`. The popover is portaled to
   * document.body (outside the composer subtree), so this class is
   * how the theme-immune Obsidian / Alabaster popover CSS reaches it.
   */
  composerStyle?: ComposerStyle
}

interface SlashMenuPlacementInput {
  anchorTop: number
  surfaceLeft: number
  surfaceWidth: number
  viewportWidth: number
  viewportHeight: number
}

export function resolveComposerSlashMenuPlacement({
  anchorTop,
  surfaceLeft,
  surfaceWidth,
  viewportWidth,
  viewportHeight
}: SlashMenuPlacementInput): { left: number; maxHeight: number; top: number; width: number } {
  const margin = 8
  const horizontalInset = 16
  const availableWidth = Math.max(0, viewportWidth - margin * 2)
  const desiredWidth = Math.max(0, surfaceWidth - horizontalInset)
  const widthFloor = Math.min(320, availableWidth)
  const width = Math.min(Math.max(desiredWidth, widthFloor), availableWidth)
  const preferredLeft = surfaceLeft + horizontalInset / 2
  const maxLeft = Math.max(margin, viewportWidth - width - margin)
  const left = Math.min(Math.max(preferredLeft, margin), maxLeft)
  const top = Math.max(margin, anchorTop - margin)
  const availableHeightAboveComposer = Math.max(96, top - margin)
  const maxHeight = Math.min(420, availableHeightAboveComposer, Math.max(96, viewportHeight - 16))
  return { left, maxHeight, top, width }
}

type SlashCommandIconName =
  | 'bolt'
  | 'branch'
  | 'clear'
  | 'command'
  | 'compact'
  | 'copy'
  | 'editor'
  | 'explain'
  | 'feedback'
  | 'files'
  | 'goal'
  | 'help'
  | 'memory'
  | 'model'
  | 'network'
  | 'permissions'
  | 'review'
  | 'screen'
  | 'settings'
  | 'side'
  | 'status'
  | 'stop'
  | 'test'

export interface ComposerSlashMenuRow {
  command: ComposerSlashCommand
  depth: number
  hasChildren: boolean
  isExpanded: boolean
}

export interface ComposerSlashMenuGroup {
  group: CommandPaletteGroup
  rows: ComposerSlashMenuRow[]
}

function childrenByParentId(
  commands: readonly ComposerSlashCommand[]
): Map<string, ComposerSlashCommand[]> {
  const byParent = new Map<string, ComposerSlashCommand[]>()
  for (const command of commands) {
    if (!command.parentId) continue
    const children = byParent.get(command.parentId) || []
    children.push(command)
    byParent.set(command.parentId, children)
  }
  return byParent
}

export function buildComposerSlashMenuGroups(
  commands: ComposerSlashCommand[],
  query: string,
  expandedCommandIds: readonly string[]
): ComposerSlashMenuGroup[] {
  const trimmedQuery = query.trim()
  const hasQuery = trimmedQuery.length > 0
  const filtered = filterComposerSlashCommands(commands, query)
  const filteredIds = new Set(filtered.map((command) => command.id))
  const commandIds = new Set(commands.map((command) => command.id))
  const expandedIds = new Set(expandedCommandIds)
  const childMap = childrenByParentId(commands)
  const groups: ComposerSlashMenuGroup[] = []

  for (const group of COMPOSER_SLASH_GROUP_ORDER) {
    const rows: ComposerSlashMenuRow[] = []
    for (const command of commands) {
      if (command.group !== group) continue
      if (command.parentId && commandIds.has(command.parentId)) continue

      const children = childMap.get(command.id) || []
      const matchingChildren = children.filter((child) => filteredIds.has(child.id))
      const parentMatches = filteredIds.has(command.id)
      if (!parentMatches && matchingChildren.length === 0) continue

      const showChildren = Boolean(
        children.length > 0 &&
          (expandedIds.has(command.id) || (hasQuery && matchingChildren.length > 0))
      )
      rows.push({
        command,
        depth: 0,
        hasChildren: children.length > 0,
        isExpanded: showChildren
      })

      if (showChildren) {
        const visibleChildren = hasQuery ? matchingChildren : children
        for (const child of visibleChildren) {
          rows.push({
            command: child,
            depth: 1,
            hasChildren: false,
            isExpanded: false
          })
        }
      }
    }
    if (rows.length > 0) groups.push({ group, rows })
  }

  return groups
}

export function resolveComposerSlashCommandIcon(
  command: Pick<ComposerSlashCommand, 'command' | 'description' | 'group' | 'id' | 'label'>
): SlashCommandIconName {
  const haystack =
    `${command.id} ${command.command} ${command.label} ${command.description} ${command.group}`.toLowerCase()
  if (haystack.includes('review') || haystack.includes('diff')) return 'review'
  if (haystack.includes('compact')) return 'compact'
  if (haystack.includes('settings')) return 'settings'
  if (haystack.includes('help')) return 'help'
  if (haystack.includes('feedback')) return 'feedback'
  if (haystack.includes('memory')) return 'memory'
  if (haystack.includes('model')) return 'model'
  if (haystack.includes('copy')) return 'copy'
  if (haystack.includes('screen') || haystack.includes('window')) return 'screen'
  if (haystack.includes('file') || haystack.includes('attach')) return 'files'
  if (haystack.includes('editor')) return 'editor'
  if (haystack.includes('stop') || haystack.includes('cancel')) return 'stop'
  if (haystack.includes('side')) return 'side'
  if (haystack.includes('explain')) return 'explain'
  if (haystack.includes('test')) return 'test'
  if (haystack.includes('goal')) return 'goal'
  if (haystack.includes('fork') || haystack.includes('resume')) return 'branch'
  if (haystack.includes('mcp') || haystack.includes('extension') || haystack.includes('hook')) return 'network'
  if (haystack.includes('permission') || haystack.includes('approval') || haystack.includes('audit')) {
    return 'permissions'
  }
  if (haystack.includes('fast')) return 'bolt'
  if (haystack.includes('status') || haystack.includes('stats')) return 'status'
  if (haystack.includes('clear')) return 'clear'
  return 'command'
}

function ComposerSlashCommandIcon({ name }: { name: SlashCommandIconName }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8
  }
  return (
    <svg
      className="composer-slash-menu-icon-svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'bolt' ? (
        <path {...common} d="M13 2.8 5.8 13h5.4L10.8 21.2 18.2 10h-5.6L13 2.8Z" />
      ) : name === 'branch' ? (
        <>
          <path {...common} d="M7 6v6a5 5 0 0 0 5 5h5" />
          <path {...common} d="M7 12h6a4 4 0 0 0 4-4V6" />
          <circle {...common} cx="7" cy="6" r="2" />
          <circle {...common} cx="17" cy="6" r="2" />
          <circle {...common} cx="17" cy="17" r="2" />
        </>
      ) : name === 'clear' ? (
        <>
          <path {...common} d="M5 7h14" />
          <path {...common} d="M9 7V5.5h6V7" />
          <path {...common} d="M8 10v8.5h8V10" />
          <path {...common} d="M10.5 12.5v3.8M13.5 12.5v3.8" />
        </>
      ) : name === 'compact' ? (
        <>
          <path {...common} d="M4 8h6V2.8" />
          <path {...common} d="M20 8h-6V2.8" />
          <path {...common} d="M4 16h6v5.2" />
          <path {...common} d="M20 16h-6v5.2" />
          <path {...common} d="M10 8 4 2M14 8l6-6M10 16l-6 6M14 16l6 6" />
        </>
      ) : name === 'copy' ? (
        <>
          <rect {...common} x="8" y="8" width="10" height="12" rx="1.8" />
          <path {...common} d="M6 16H5.8A1.8 1.8 0 0 1 4 14.2V5.8A1.8 1.8 0 0 1 5.8 4h7.4A1.8 1.8 0 0 1 15 5.8V6" />
        </>
      ) : name === 'editor' ? (
        <>
          <path {...common} d="M5 4.5h14v15H5z" />
          <path {...common} d="M8 8h5.5M8 11h8M8 14h4.5" />
          <path {...common} d="m14.5 17 3-3 1.5 1.5-3 3H14.5z" />
        </>
      ) : name === 'explain' ? (
        <>
          <path {...common} d="M7 3.5h7l3 3v14H7z" />
          <path {...common} d="M14 3.5v3h3" />
          <path {...common} d="M9.5 11h5M9.5 14h5M9.5 17h3" />
          <path {...common} d="M5 8l-2 2 2 2M19 12l2-2-2-2" />
        </>
      ) : name === 'feedback' ? (
        <>
          <path {...common} d="M5 5.5h14v9.5H9l-4 3.5z" />
          <path {...common} d="M8.5 9h7M8.5 12h4.5" />
        </>
      ) : name === 'files' ? (
        <>
          <path {...common} d="M5 6.5h5l1.6 2H19v9.5H5z" />
          <path {...common} d="M5 8.5V6a2 2 0 0 1 2-2h3l1.5 2H17a2 2 0 0 1 2 2v.5" />
        </>
      ) : name === 'goal' ? (
        <>
          <circle {...common} cx="12" cy="12" r="7.5" />
          <circle {...common} cx="12" cy="12" r="3.8" />
          <path {...common} d="M12 4.5V2.8M19.5 12h1.7M12 19.5v1.7M4.5 12H2.8" />
        </>
      ) : name === 'help' ? (
        <>
          <circle {...common} cx="12" cy="12" r="8.2" />
          <path {...common} d="M9.8 9.2a2.3 2.3 0 1 1 3.8 1.8c-.9.7-1.5 1.1-1.5 2.2" />
          <path {...common} d="M12 16.8h.01" />
        </>
      ) : name === 'memory' ? (
        <>
          <path {...common} d="M6 7c0-1.7 2.7-3 6-3s6 1.3 6 3-2.7 3-6 3-6-1.3-6-3Z" />
          <path {...common} d="M6 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" />
          <path {...common} d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
        </>
      ) : name === 'model' ? (
        <>
          <path {...common} d="m12 3.5 7 4v8l-7 4-7-4v-8z" />
          <path {...common} d="m5.4 7.8 6.6 3.8 6.6-3.8M12 11.6v7.8" />
        </>
      ) : name === 'network' ? (
        <>
          <circle {...common} cx="6" cy="12" r="2.2" />
          <circle {...common} cx="18" cy="7" r="2.2" />
          <circle {...common} cx="18" cy="17" r="2.2" />
          <path {...common} d="m8 11.1 8-3.2M8 12.9l8 3.2" />
        </>
      ) : name === 'permissions' ? (
        <>
          <path {...common} d="M12 3.2 18.5 6v5.2c0 4.1-2.7 7.4-6.5 9.6-3.8-2.2-6.5-5.5-6.5-9.6V6z" />
          <path {...common} d="m9.2 12.2 2 2 3.8-4.2" />
        </>
      ) : name === 'review' ? (
        <>
          <path {...common} d="M5.5 4.5h8.8l3.2 3.2v11.8h-12z" />
          <path {...common} d="M14 4.5V8h3.5" />
          <path {...common} d="M8.3 11h5.4M8.3 14h3.2" />
          <circle {...common} cx="15.6" cy="15.6" r="2.2" />
          <path {...common} d="m17.2 17.2 2.3 2.3" />
        </>
      ) : name === 'screen' ? (
        <>
          <rect {...common} x="4" y="5" width="16" height="11" rx="2" />
          <path {...common} d="M9 20h6M12 16v4" />
          <path {...common} d="M8 9.5h2.5M8 12.5h6.5" />
        </>
      ) : name === 'settings' ? (
        <>
          <circle {...common} cx="12" cy="12" r="3" />
          <path {...common} d="M12 3.5v2M12 18.5v2M4.6 7.2l1.7 1M17.7 15.8l1.7 1M4.6 16.8l1.7-1M17.7 8.2l1.7-1" />
          <path {...common} d="M7.8 4.8 9 6.5M15 17.5l1.2 1.7M7.8 19.2 9 17.5M15 6.5l1.2-1.7" />
        </>
      ) : name === 'side' ? (
        <>
          <rect {...common} x="4" y="5" width="16" height="14" rx="2.2" />
          <path {...common} d="M11 5v14M6.8 9h1.8M6.8 12h1.8M6.8 15h1.8" />
        </>
      ) : name === 'status' ? (
        <>
          <path {...common} d="M4.5 14a7.5 7.5 0 1 1 15 0" />
          <path {...common} d="m12 14 4-4" />
          <path {...common} d="M7 18h10" />
        </>
      ) : name === 'stop' ? (
        <>
          <rect {...common} x="6" y="6" width="12" height="12" rx="2.5" />
          <path {...common} d="M9.2 9.2 14.8 14.8M14.8 9.2 9.2 14.8" />
        </>
      ) : name === 'test' ? (
        <>
          <path {...common} d="M9 3.5h6M10 3.5v5.2l-4.3 7.6A3 3 0 0 0 8.3 21h7.4a3 3 0 0 0 2.6-4.7L14 8.7V3.5" />
          <path {...common} d="M8.4 15.5h7.2" />
        </>
      ) : (
        <>
          <path {...common} d="M9 4.5 4 19.5" />
          <path {...common} d="m13 8 4 4-4 4" />
        </>
      )}
    </svg>
  )
}

/**
 * Floating popover anchored to the composer textarea that lists provider-
 * aware slash commands. Triggered by the parent detecting a `/` keystroke
 * at start-of-line or after whitespace; selecting an item dispatches via
 * `onPick` which the parent then routes through the slash-command
   * dispatcher (`palette-passthrough` → existing `handlePaletteCommand`,
   * `action` → renderer handler, etc.).
 *
 * Visually + interactively mirrors `AgentMentionMenu` (the `@`-mention
 * picker that lives right below in App.tsx) — same fixed positioning,
 * same capture-phase keydown listener, same click-outside dismiss — so
 * the two popovers feel identical to the user even though they target
 * different surfaces.
 *
 * Keyboard handling:
 *   ArrowUp / ArrowDown — navigate
 *   Enter / Tab         — select highlighted item
 *   Escape              — dismiss
 *
 * Items are grouped by `group` (Core / Discovery / Memory / Inspectors /
 * Custom); group headers are non-interactive and don't participate in
 * keyboard navigation.
 */
export function ComposerSlashMenu({
  open,
  anchorRef,
  query,
  commands,
  onPick,
  onDismiss,
  composerStyle
}: ComposerSlashMenuProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [position, setPosition] = useState<{
    left: number
    maxHeight: number
    top: number
    width: number
  } | null>(null)
  const [expandedCommandIds, setExpandedCommandIds] = useState<string[]>([])

  // Group commands keyed by their `group` field, in the canonical order exported
  // from the registry module. Hierarchical child commands stay normal commands
  // for dispatch, but render under their parent when expanded or when the query
  // matches a child.
  const grouped = useMemo(() => {
    return buildComposerSlashMenuGroups(commands, query, expandedCommandIds)
  }, [commands, query, expandedCommandIds])

  // Flat list (in render order) used by keyboard nav. Kept in lockstep
  // with the grouped render via `flatIndexFor`.
  const flat = useMemo(() => grouped.flatMap((block) => block.rows), [grouped])

  const toggleExpanded = useCallback((commandId: string): void => {
    setExpandedCommandIds((current) =>
      current.includes(commandId)
        ? current.filter((id) => id !== commandId)
        : [...current, commandId]
    )
  }, [])

  const expandCommand = useCallback((commandId: string): void => {
    setExpandedCommandIds((current) =>
      current.includes(commandId) ? current : [...current, commandId]
    )
  }, [])

  const collapseCommand = useCallback((commandId: string): void => {
    setExpandedCommandIds((current) => current.filter((id) => id !== commandId))
  }, [])

  const pickRow = useCallback((row: ComposerSlashMenuRow): void => {
    if (row.hasChildren && !row.isExpanded) {
      expandCommand(row.command.id)
      return
    }
    onPick(row.command)
  }, [expandCommand, onPick])

  // Recompute popover position when the anchor moves / when opening.
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (!open) {
        setPosition(null)
        return
      }
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const surface = anchor.closest('.composer-surface') as HTMLElement | null
      const surfaceRect = surface?.getBoundingClientRect() ?? rect
      // Anchor the popover ABOVE the textarea so the input never gets
      // pushed down when the picker opens. Width tracks the composer with
      // a small inset, matching Codex's slash menu without overflowing
      // narrow side panes or multiview cells.
      setPosition(
        resolveComposerSlashMenuPlacement({
          anchorTop: rect.top,
          surfaceLeft: surfaceRect.left,
          surfaceWidth: surfaceRect.width,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth
        })
      )
    })
    return () => {
      cancelled = true
    }
  }, [open, anchorRef, query])

  // Reset highlight to the first item when the filter changes.
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setHighlight(0)
    })
    return () => {
      cancelled = true
    }
  }, [flat.length])

  useEffect(() => {
    if (!open) setExpandedCommandIds([])
  }, [open])

  // Keyboard handlers — capture phase so Enter inside the picker beats
  // the textarea's send-on-Enter. Same approach as AgentMentionMenu.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (!open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
        return
      }
      if (flat.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((current) => (current + 1) % flat.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => (current - 1 + flat.length) % flat.length)
      } else if (event.key === 'ArrowRight') {
        const row = flat[highlight]
        if (row?.hasChildren && !row.isExpanded) {
          event.preventDefault()
          expandCommand(row.command.id)
        }
      } else if (event.key === 'ArrowLeft') {
        const row = flat[highlight]
        const parentId = row?.command.parentId || (row?.hasChildren ? row.command.id : null)
        if (parentId) {
          event.preventDefault()
          collapseCommand(parentId)
        }
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const choice = flat[highlight]
        if (choice) pickRow(choice)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, flat, highlight, expandCommand, collapseCommand, pickRow, onDismiss])

  // Click outside dismisses (anchor clicks bubble back into the textarea
  // and don't count as outside-clicks).
  useEffect(() => {
    if (!open) return
    const onMouse = (event: MouseEvent) => {
      const popover = popoverRef.current
      const anchor = anchorRef.current
      if (popover?.contains(event.target as Node)) return
      if (anchor?.contains(event.target as Node)) return
      onDismiss()
    }
    window.addEventListener('mousedown', onMouse, true)
    return () => window.removeEventListener('mousedown', onMouse, true)
  }, [open, anchorRef, onDismiss])

  if (!open || !position) return null

  // Portal into document.body so the popover escapes any transformed
  // ancestor (notably `.welcome-mode .composer-area` which carries a
  // `transform: translateY(-18%)` on the new-chat landing). Without
  // the portal, that transform would trap `position: fixed`, causing
  // the popover to anchor against the transformed container instead
  // of the viewport — landing at the wrong vertical offset. Same
  // escape pattern as `SidebarOverflowMenu`.
  return createPortal(
    <div
      ref={popoverRef}
      className={`composer-slash-menu shell-${composerStyle || 'default'}`}
      role="listbox"
      aria-label="Slash command picker"
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
        width: position.width,
        transform: 'translateY(-100%)',
        zIndex: 50
      }}
    >
      {flat.length === 0 ? (
        <div className="composer-slash-menu-empty">
          {commands.length === 0 ? 'No slash commands available' : `No commands match "${query}"`}
        </div>
      ) : (
        <div className="composer-slash-menu-list">
          {grouped.map((block) => (
            <div key={block.group} className="composer-slash-menu-group">
              <div className="composer-slash-menu-group-title" aria-hidden>
                {block.group}
              </div>
              <ul className="composer-slash-menu-group-items" role="group">
                {block.rows.map((row) => {
                  const entry = row.command
                  const localFlatIndex = flat.findIndex(
                    (flatRow) => flatRow.command.id === entry.id
                  )
                  const isHighlighted = localFlatIndex === highlight
                  return (
                    <li
                      key={entry.id}
                      role="option"
                      aria-selected={isHighlighted}
                      aria-expanded={row.hasChildren ? row.isExpanded : undefined}
                      className={`composer-slash-menu-item ${
                        isHighlighted ? 'is-highlighted' : ''
                      } ${row.depth > 0 ? 'is-child' : ''} ${
                        row.hasChildren ? 'has-children' : ''
                      }`}
                      onMouseEnter={() => setHighlight(localFlatIndex)}
                      onClick={() => pickRow(row)}
                    >
                      <span className="composer-slash-menu-disclosure-slot">
                        {row.hasChildren ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            className={`composer-slash-menu-disclosure ${
                              row.isExpanded ? 'is-expanded' : ''
                            }`}
                            aria-label={
                              row.isExpanded
                                ? `Collapse ${entry.label} options`
                                : `Expand ${entry.label} options`
                            }
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleExpanded(entry.id)
                            }}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                              <path d="M6 4.5 9.5 8 6 11.5" />
                            </svg>
                          </button>
                        ) : null}
                      </span>
                      <span className="composer-slash-menu-icon" aria-hidden="true">
                        <ComposerSlashCommandIcon
                          name={resolveComposerSlashCommandIcon(entry)}
                        />
                      </span>
                      <span className="composer-slash-menu-copy">
                        <span className="composer-slash-menu-title-row">
                          <span className="composer-slash-menu-label">{entry.label}</span>
                          <span className="composer-slash-menu-command">{entry.command}</span>
                        </span>
                        <span className="composer-slash-menu-description">{entry.description}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body
  )
}
