import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'
import {
  MULTIVIEW_LAYOUT_IDS,
  getMultiviewLayoutSpec,
  type MultiviewLayout
} from '../../../shared/multiviewLayouts'
import { resolveComposerSurfacePopoverPosition } from '../lib/composerSurfacePopover'
import { MultiviewSymbolIcon } from './AppChromeSymbols'

/**
 * A tiny preview of a layout: each pane drawn as a filled rounded rect,
 * derived straight from the layout catalogue's grid-template-areas so the
 * glyph and the real grid can never drift. Returned bare (no span) because
 * ComposerPlusPicker wraps row icons in its own `composer-plus-picker-row-icon`.
 */
export function MultiviewLayoutGlyph({ layout }: { layout: MultiviewLayout }): ReactElement {
  const spec = getMultiviewLayoutSpec(layout)
  const rows = (spec.gridTemplateAreas.match(/"([^"]*)"/g) ?? ['"a"']).map((row) =>
    row.replace(/"/g, '').trim().split(/\s+/)
  )
  const rowCount = rows.length
  const colCount = rows[0].length
  const boxes = new Map<string, { r0: number; c0: number; r1: number; c1: number }>()
  rows.forEach((cols, r) =>
    cols.forEach((name, c) => {
      const box = boxes.get(name)
      if (!box) {
        boxes.set(name, { r0: r, c0: c, r1: r, c1: c })
      } else {
        box.r0 = Math.min(box.r0, r)
        box.c0 = Math.min(box.c0, c)
        box.r1 = Math.max(box.r1, r)
        box.c1 = Math.max(box.c1, c)
      }
    })
  )
  const width = 16
  const height = 14
  const gap = 1.4
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="currentColor" stroke="none">
      {[...boxes.entries()].map(([name, box]) => {
        const x = (box.c0 / colCount) * width + gap / 2
        const y = (box.r0 / rowCount) * height + gap / 2
        const w = ((box.c1 - box.c0 + 1) / colCount) * width - gap
        const h = ((box.r1 - box.r0 + 1) / rowCount) * height - gap
        return <rect key={name} x={x} y={y} width={w} height={h} rx={1.3} opacity={0.85} />
      })}
    </svg>
  )
}

/**
 * Build the grid items listing every layout. Extracted so the item set (labels,
 * active flag, disabled-when-too-narrow) can be unit-tested without rendering
 * the portal-based picker.
 */
export function buildMultiviewLayoutGridItems(
  current: MultiviewLayout,
  onSelectLayout: (layout: MultiviewLayout) => void,
  disabledLayouts?: ReadonlySet<MultiviewLayout>
): Array<{
  id: MultiviewLayout
  label: string
  description: string
  active: boolean
  disabled: boolean
  onSelect: () => void
}> {
  return MULTIVIEW_LAYOUT_IDS.map((id) => {
    const spec = getMultiviewLayoutSpec(id)
    return {
      id,
      label: spec.label,
      description: id === 'single' ? 'One chat' : `${spec.paneCount} panes`,
      active: current === id,
      disabled: disabledLayouts?.has(id) ?? false,
      onSelect: () => onSelectLayout(id)
    }
  })
}

export interface MultiviewLayoutPickerProps {
  layout: MultiviewLayout
  onSelectLayout: (layout: MultiviewLayout) => void
  provider: ProviderId
  composerStyle: ComposerStyle
  disabled?: boolean
  /** Layouts that cannot fit the current window width (kept selectable=false). */
  disabledLayouts?: ReadonlySet<MultiviewLayout>
  /** Slash-command open request — see `lib/composerSurfaceRequest`. Each new
   * positive value opens the picker once; 0 is inert. A bare `/multiview`
   * opens it; `/multiview <layout>` bypasses it and sets the layout directly. */
  openSignal?: number
}

export function MultiviewLayoutPicker(props: MultiviewLayoutPickerProps): ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null
  )
  const items = buildMultiviewLayoutGridItems(
    props.layout,
    props.onSelectLayout,
    props.disabledLayouts
  )

  // Bare `/multiview` opens the same picker the icon does. `disabled` is read
  // at fire time so a later disabling re-render can't retroactively re-open it.
  const layoutOpenSignal = props.openSignal
  const layoutPickerDisabled = props.disabled
  useEffect(() => {
    if (!layoutOpenSignal || layoutPickerDisabled) return
    setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutOpenSignal])

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
    setPosition(
      resolveComposerSurfacePopoverPosition({
        triggerRect,
        surfaceRect,
        viewportWidth: window.innerWidth
      })
    )
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

  const handleSelect = (item: (typeof items)[number]): void => {
    if (item.disabled) return
    item.onSelect()
    setOpen(false)
  }

  const popover =
    open && position && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-multiview-popover provider-${props.provider} shell-${props.composerStyle}`}
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              width: `${position.width}px`,
              maxWidth: 'calc(100vw - 16px)',
              transform: 'translateY(-100%)'
            }}
            role="dialog"
            aria-label="Multiview layout"
          >
            <div className="composer-multiview-popover-header">Multiview layout</div>
            <div className="composer-multiview-grid" role="list">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="listitem"
                  className={`composer-multiview-grid-item${item.active ? ' is-selected' : ''}`}
                  disabled={item.disabled}
                  onClick={() => handleSelect(item)}
                  title={item.disabled ? `${item.label} cannot fit this pane` : item.label}
                  aria-pressed={item.active}
                >
                  <span className="composer-multiview-grid-icon" aria-hidden>
                    <MultiviewLayoutGlyph layout={item.id} />
                  </span>
                  <span className="composer-multiview-grid-copy">
                    <span className="composer-multiview-grid-label">{item.label}</span>
                    <span className="composer-multiview-grid-sub">{item.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        className="composer-multiview-trigger composer-hint-pill--left composer-hint-pill"
        type="button"
        aria-label="Multiview layout"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={props.disabled || items.length === 0}
        data-composer-control="multiview"
        data-hint-label="Multiview"
      >
        <MultiviewSymbolIcon />
      </button>
      {popover}
    </>
  )
}
