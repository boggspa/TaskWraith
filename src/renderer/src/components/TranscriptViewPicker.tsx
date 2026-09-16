import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'
import { TRANSCRIPT_VIEWS } from '../lib/transcriptViewFold'
import { setTranscriptViewOverride, type TranscriptView } from '../lib/transcriptViewOverride'
import { useTranscriptViewSelection } from '../hooks/useTranscriptView'
import {
  resolveComposerSurfacePopoverPosition,
  sameComposerSurfacePopoverPosition
} from '../lib/composerSurfacePopover'
import { TRANSCRIPT_VIEW_OPTIONS } from './settings/settingsUiOptions'
import { TranscriptViewSymbolIcon } from './AppChromeSymbols'

/** `default` is the "follow the Appearance default" row, which owns no view. */
export type TranscriptViewMenuItemId = TranscriptView | 'default'

export interface TranscriptViewMenuItem {
  id: TranscriptViewMenuItemId
  label: string
  description: string
  /** Exactly one item is active at a time — see the note on the builder. */
  active: boolean
  onSelect: () => void
}

/**
 * Build the four menu rows.
 *
 * Extracted as a pure function for the same reason
 * `buildMultiviewLayoutGridItems` is: the popover is a PORTAL, and portals
 * never render under `renderToStaticMarkup`. A test asserting menu markup
 * would pass over an empty string and prove nothing, so the item array is the
 * thing worth pinning.
 *
 * FOUR items, not three, and the first one is load-bearing. Once an Appearance
 * default exists, "this chat follows the default" and "the user picked
 * standard" are different states that look identical on screen. A three-item
 * menu cannot express the difference: the ticked row on an un-overridden chat
 * would be whichever view the default resolves to, and clicking it would write
 * an explicit entry and pin that chat forever — after which a later default of
 * `minimal` reaches every chat EXCEPT the ones whose menu was opened. The
 * store's own doc records this; `setTranscriptViewOverride` is only correct
 * against this shape.
 *
 * `active` is therefore keyed on `hasOverride` rather than on the resolved
 * view alone. Without that, an un-overridden chat would tick BOTH "Follow
 * default" and the view it currently resolves to.
 */
export function buildTranscriptViewMenuItems(
  resolvedView: TranscriptView,
  hasOverride: boolean,
  onSelect: (view: TranscriptView | null) => void
): TranscriptViewMenuItem[] {
  const items: TranscriptViewMenuItem[] = [
    {
      id: 'default',
      label: 'Follow default',
      // Names what the default currently resolves to, because otherwise this
      // row is the only one whose effect the reader cannot see.
      description: hasOverride
        ? 'Use the Appearance default for this chat again'
        : `Using the Appearance default (${labelFor(resolvedView)})`,
      active: !hasOverride,
      onSelect: () => onSelect(null)
    }
  ]
  // Quietest first, straight from the catalogue, so the menu and any other
  // consumer can never disagree about the order or the wording.
  for (const view of TRANSCRIPT_VIEWS) {
    const option = TRANSCRIPT_VIEW_OPTIONS.find((candidate) => candidate.value === view)
    items.push({
      id: view,
      label: option?.label ?? view,
      description: option?.helper ?? '',
      active: hasOverride && resolvedView === view,
      onSelect: () => onSelect(view)
    })
  }
  return items
}

function labelFor(view: TranscriptView): string {
  return TRANSCRIPT_VIEW_OPTIONS.find((candidate) => candidate.value === view)?.label ?? view
}

export interface TranscriptViewPickerProps {
  /**
   * The chat whose view this menu sets, or null when no chat is resolved.
   *
   * MUST NOT be ''. Several panes carry `appChatId ?? ''`, and an empty key is
   * written into the store's snapshot and notifies every listener while both
   * readers short-circuit on it — the menu writes, the store churns, and
   * nothing on screen changes. The picker hides itself rather than write one.
   */
  chatId: string | null
  provider: ProviderId
  composerStyle: ComposerStyle
  disabled?: boolean
  /** Slash-command open request — see `lib/composerSurfaceRequest`. */
  openSignal?: number
}

export function TranscriptViewPicker(props: TranscriptViewPickerProps): ReactElement | null {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null
  )
  const chatId = props.chatId && props.chatId.length > 0 ? props.chatId : null
  const { view, hasOverride } = useTranscriptViewSelection(chatId)
  const items = buildTranscriptViewMenuItems(view, hasOverride, (next) => {
    if (!chatId) return
    setTranscriptViewOverride(chatId, next)
  })

  // Bare `/view` opens the same menu the icon does. `disabled` is read at fire
  // time so a later disabling re-render cannot retroactively re-open it.
  const viewOpenSignal = props.openSignal
  const viewPickerDisabled = props.disabled || !chatId
  useEffect(() => {
    if (!viewOpenSignal || viewPickerDisabled) return
    setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOpenSignal])

  const updatePosition = useCallback((): void => {
    if (typeof window === 'undefined') return
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const triggerRect = trigger.getBoundingClientRect()
    const surface = trigger.closest('.composer-surface') as HTMLElement | null
    const surfaceRect = surface?.getBoundingClientRect() ?? triggerRect
    const next = resolveComposerSurfacePopoverPosition({
      triggerRect,
      surfaceRect,
      viewportWidth: window.innerWidth
    })
    // Hold the previous object when nothing moved. Repositioning runs from a
    // CAPTURING window scroll listener, so a scroll inside the popover's own
    // body arrives here too — and storing a fresh object for that re-renders
    // the whole menu for a position identical to the one it already had.
    setPosition((current) => (sameComposerSurfacePopoverPosition(current, next) ? current : next))
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) updatePosition()
    })
    const handleReposition = (): void => updatePosition()
    window.addEventListener('scroll', handleReposition, true)
    window.addEventListener('resize', handleReposition)
    return () => {
      cancelled = true
      window.removeEventListener('scroll', handleReposition, true)
      window.removeEventListener('resize', handleReposition)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  const handleSelect = (item: TranscriptViewMenuItem): void => {
    item.onSelect()
    setOpen(false)
  }

  const popover =
    open && position && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-transcript-view-popover provider-${props.provider} shell-${props.composerStyle}`}
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              width: `${position.width}px`,
              maxWidth: 'calc(100vw - 16px)',
              transform: 'translateY(-100%)'
            }}
            role="dialog"
            aria-label="Transcript view"
          >
            <div className="composer-transcript-view-popover-header">Transcript view</div>
            <div className="composer-transcript-view-list" role="list">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="listitem"
                  className={`composer-transcript-view-item${item.active ? ' is-selected' : ''}${
                    item.id === 'default' ? ' is-follow-default' : ''
                  }`}
                  onClick={() => handleSelect(item)}
                  title={item.description}
                  aria-pressed={item.active}
                >
                  <span className="composer-transcript-view-copy">
                    <span className="composer-transcript-view-label">{item.label}</span>
                    <span className="composer-transcript-view-sub">{item.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )
      : null

  // No chat, nothing to set. Hiding beats rendering a control whose every
  // click is a no-op.
  if (!chatId) return null

  return (
    <>
      <button
        ref={triggerRef}
        className="composer-transcript-view-trigger composer-hint-pill--left composer-hint-pill"
        type="button"
        aria-label="Transcript view"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={props.disabled}
        data-composer-control="view"
        data-transcript-view={hasOverride ? view : 'default'}
        data-hint-label="View"
      >
        <TranscriptViewSymbolIcon />
      </button>
      {popover}
    </>
  )
}
