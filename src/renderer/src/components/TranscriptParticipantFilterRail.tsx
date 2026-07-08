import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord } from '../../../main/store/types'
import {
  buildTranscriptParticipantFilterItems,
  type TranscriptParticipantFilterItem
} from '../lib/transcriptParticipantFilter'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { getProviderLabel } from '../lib/providerLabels'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import { ProviderGlyph } from './icons/ProviderGlyph'

interface RailFrame {
  left: number
  top: number
  width: number
}

interface TranscriptParticipantFilterRailProps {
  currentChat?: ChatRecord | null
  items?: readonly TranscriptParticipantFilterItem[]
  activeFilterKeys: ReadonlySet<string>
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onToggleFilter: (key: string) => void
}

interface ElementRect {
  right: number
  top: number
  height: number
}

const RAIL_GAP_PX = 8
const RAIL_MIN_VIEWPORT_WIDTH_PX = 720
const FILTER_MAX_ROWS = 10
const FILTER_COLUMN_WIDTH_PX = 36
const FILTER_COLUMN_GAP_PX = 4
const FILTER_ROW_HEIGHT_PX = 24
const FILTER_ROW_GAP_PX = 2
const FILTER_SYSTEM_GAP_PX = 5
const FILTER_SYSTEM_SIZE_PX = 21

function visibleComposerChildren(composerArea: Element): HTMLElement[] {
  const children: HTMLElement[] = []
  for (const child of Array.from(composerArea.children)) {
    if (!(child instanceof HTMLElement)) continue
    const targets = child.classList.contains('composer-primary-stack')
      ? Array.from(child.children)
      : [child]
    for (const target of targets) {
      if (!(target instanceof HTMLElement)) continue
      const style = window.getComputedStyle(target)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.position === 'absolute' ||
        style.position === 'fixed'
      ) {
        continue
      }
      children.push(target)
    }
  }
  return children
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function composerStackBox(scroller: HTMLElement): ElementRect | null {
  const composerArea = scroller.closest('.app-transcript')?.querySelector('.composer-area')
  if (!composerArea) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const child of visibleComposerChildren(composerArea)) {
    const rect = child.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  return { right, top, height: bottom - top }
}

function composerSurfaceBox(scroller: HTMLElement): ElementRect | null {
  const surface = scroller.closest('.app-transcript')?.querySelector('.composer-surface')
  if (!(surface instanceof HTMLElement)) return null
  const rect = surface.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return { right: rect.right, top: rect.top, height: rect.height }
}

function mountedRowsRightEdgePx(scroller: HTMLElement): number | null {
  const rows = scroller.querySelectorAll<HTMLElement>('[data-vrow-id]')
  let right = Number.NEGATIVE_INFINITY
  let sampled = 0
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    right = Math.max(right, rect.right)
    if (++sampled >= 8) break
  }
  return Number.isFinite(right) ? right : null
}

function BossmanCrownIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M4.7 17.8h14.6l1.2-9.1-4.8 3.4-3.7-6-3.7 6-4.8-3.4 1.2 9.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M5.4 20h13.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CaptainHatIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M5.2 15.8c2.3 1.2 11.3 1.2 13.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M6.8 14.8 8 9.7c.3-1.1 1.2-1.8 2.3-1.8h3.4c1.1 0 2 .7 2.3 1.8l1.2 5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M9 7.8 12 4l3 3.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function SystemFilterIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
      <path
        d="M5.2 6.4h13.6v11.2H5.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m8.1 10 2.1 2-2.1 2M12.2 14h3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FilterItemIcon({ item }: { item: TranscriptParticipantFilterItem }): ReactElement {
  if (item.kind === 'system') return <SystemFilterIcon />
  if (item.pooledAgent) {
    return (
      <PooledAgentIcon
        identity={item.participant?.pooledAgentIdentity}
        size={16}
        className="transcript-participant-filter-pooled-icon"
      />
    )
  }
  const accentProvider = resolveProviderHueClass(item.provider, item.participant?.model)
  return (
    <ProviderGlyph
      provider={item.provider}
      accentProvider={accentProvider}
      className="transcript-participant-filter-provider-icon"
    />
  )
}

function itemAccessibleLabel(item: TranscriptParticipantFilterItem, active: boolean): string {
  const action = active ? 'Remove transcript filter for' : 'Show only transcript messages from'
  if (item.kind === 'system') return `${action} system messages`
  const provider = item.provider ? getProviderLabel(item.provider) : 'Provider'
  const authority = item.isBossman ? 'Boss ' : item.isCaptain ? 'Captain ' : ''
  return `${action} ${authority}${item.role} (${provider}, ${item.ordinal})`
}

export function TranscriptParticipantFilterRail({
  currentChat,
  items: providedItems,
  activeFilterKeys,
  scrollRef,
  contentRef,
  onToggleFilter
}: TranscriptParticipantFilterRailProps): ReactElement | null {
  const items = useMemo(
    () => providedItems || buildTranscriptParticipantFilterItems(currentChat),
    [currentChat, providedItems]
  )
  const participantItems = useMemo(() => items.filter((item) => item.kind === 'participant'), [items])
  const systemItem = useMemo(() => items.find((item) => item.kind === 'system') || null, [items])
  const columnCount = Math.max(1, Math.ceil(participantItems.length / FILTER_MAX_ROWS))
  const [frame, setFrame] = useState<RailFrame | null>(null)

  const updateFrame = useCallback(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content || participantItems.length === 0) return
    if (scroller.offsetParent === null) {
      setFrame(null)
      return
    }
    const scrollerRect = scroller.getBoundingClientRect()
    if (scrollerRect.width < RAIL_MIN_VIEWPORT_WIDTH_PX) {
      setFrame(null)
      return
    }
    const contentRect = content.getBoundingClientRect()
    const rowsRight = mountedRowsRightEdgePx(scroller)
    const composerRect = composerStackBox(scroller)
    const composerSurfaceRect = composerSurfaceBox(scroller)
    const anchorRight = Math.max(contentRect.right, rowsRight ?? 0, composerRect?.right ?? 0)
    const left = anchorRight + RAIL_GAP_PX
    const width =
      columnCount * FILTER_COLUMN_WIDTH_PX + Math.max(0, columnCount - 1) * FILTER_COLUMN_GAP_PX
    if (left + width > scrollerRect.right - 4) {
      setFrame(null)
      return
    }
    const participantRows = FILTER_MAX_ROWS
    const participantHeight =
      participantRows * FILTER_ROW_HEIGHT_PX + Math.max(0, participantRows - 1) * FILTER_ROW_GAP_PX
    const naturalHeight =
      participantHeight + (systemItem ? FILTER_SYSTEM_GAP_PX + FILTER_SYSTEM_SIZE_PX : 0)
    const centerY = composerSurfaceRect
      ? composerSurfaceRect.top + composerSurfaceRect.height / 2
      : scrollerRect.bottom - scrollerRect.height * 0.28
    const top = clamp(
      centerY - naturalHeight / 2,
      scrollerRect.top + 72,
      Math.max(scrollerRect.top + 72, scrollerRect.bottom - naturalHeight - 44)
    )
    setFrame((current) => {
      if (
        current &&
        Math.abs(current.left - left) < 0.5 &&
        Math.abs(current.top - top) < 0.5 &&
        Math.abs(current.width - width) < 0.5
      ) {
        return current
      }
      return { left, top, width }
    })
  }, [columnCount, contentRef, participantItems.length, scrollRef, systemItem])

  useLayoutEffect(() => {
    updateFrame()
    const frameIds: number[] = []
    let timeoutId: number | null = null
    let observer: ResizeObserver | null = null
    let fontsCancelled = false
    if (typeof window !== 'undefined') {
      // Nested rAF: measure next frame, then once more after it paints — catches
      // virtualized rows and composer growth that land a frame late.
      frameIds.push(
        window.requestAnimationFrame(() => {
          updateFrame()
          frameIds.push(window.requestAnimationFrame(updateFrame))
        })
      )
      // Layout-settle belt for the roster-preset expand animation / async mount.
      timeoutId = window.setTimeout(updateFrame, 160)
      window.addEventListener('resize', updateFrame)
      window.addEventListener('scroll', updateFrame, true)
    }
    // The rail's vertical centre + right edge track the composer surface and the
    // transcript column. Previously this effect had NO ResizeObserver, so an
    // ensemble roster mounting / the composer growing taller after first paint
    // never re-measured the rail — it stayed mispositioned until an incidental
    // scroll fired the capture listener above. Observe the scroller, the
    // transcript inner, and `.composer-area` so those relayouts re-clamp the
    // rail immediately (mirrors the sibling TranscriptUserMessageGutter).
    const scroller = scrollRef.current
    const content = contentRef.current
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateFrame())
      if (scroller) observer.observe(scroller)
      if (content) observer.observe(content)
      const composerArea = scroller?.closest('.app-transcript')?.querySelector('.composer-area')
      if (composerArea instanceof HTMLElement) observer.observe(composerArea)
    }
    // Web-font swap shifts the composer height (and thus the rail's centre)
    // after first paint — re-measure once fonts settle.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!fontsCancelled) updateFrame()
      })
    }
    return () => {
      fontsCancelled = true
      observer?.disconnect()
      for (const id of frameIds) window.cancelAnimationFrame(id)
      if (timeoutId !== null) window.clearTimeout(timeoutId)
      window.removeEventListener('resize', updateFrame)
      window.removeEventListener('scroll', updateFrame, true)
    }
  }, [contentRef, scrollRef, updateFrame])

  if (!currentChat || currentChat.chatKind !== 'ensemble' || participantItems.length === 0) return null

  const participantGridRowOffset =
    participantItems.length < FILTER_MAX_ROWS ? FILTER_MAX_ROWS - participantItems.length : 0

  const gridPlacementForIndex = (index: number): CSSProperties => ({
    gridRowStart: String(participantGridRowOffset + (index % FILTER_MAX_ROWS) + 1),
    gridColumnStart: String(Math.floor(index / FILTER_MAX_ROWS) + 1)
  })

  const renderFilterButton = (
    item: TranscriptParticipantFilterItem,
    gridPlacement?: CSSProperties
  ): ReactElement => {
    const active = activeFilterKeys.has(item.key)
    return (
      <button
        key={item.key}
        type="button"
        className={`transcript-participant-filter-button${
          active ? ' is-active' : ''
        }${item.kind === 'system' ? ' is-system' : ''}${
          item.provider ? ` provider-${item.provider}` : ''
        }`}
        data-filter-ordinal={item.ordinal}
        aria-pressed={active}
        aria-label={itemAccessibleLabel(item, active)}
        title={item.title}
        style={gridPlacement}
        onClick={() => onToggleFilter(item.key)}
      >
        {item.kind === 'participant' && (
          <span className="transcript-participant-filter-side-stack">
            <span className="transcript-participant-filter-index">{item.ordinal}</span>
            {item.isBossman && (
              <span className="transcript-participant-filter-authority is-boss" title="Boss">
                <BossmanCrownIcon />
              </span>
            )}
            {item.isCaptain && (
              <span className="transcript-participant-filter-authority is-captain" title="Captain">
                <CaptainHatIcon />
              </span>
            )}
          </span>
        )}
        <span className="transcript-participant-filter-icon">
          <FilterItemIcon item={item} />
        </span>
      </button>
    )
  }

  const rail = (
    <div
      className={`transcript-participant-filter-rail${frame ? '' : ' is-unmeasured'}${
        activeFilterKeys.size > 0 ? ' has-active-filter' : ''
      }`}
      style={frame ? { left: frame.left, top: frame.top, width: frame.width } : undefined}
      data-column-count={columnCount}
      role="navigation"
      aria-label="Transcript participant filters"
    >
      <div
        className="transcript-participant-filter-grid"
        data-row-offset={participantGridRowOffset}
      >
        {participantItems.map((item, index) =>
          renderFilterButton(item, gridPlacementForIndex(index))
        )}
      </div>
      {systemItem && (
        <div className="transcript-participant-filter-system-row">
          {renderFilterButton(systemItem)}
        </div>
      )}
    </div>
  )

  return typeof document === 'undefined' ? rail : createPortal(rail, document.body)
}
