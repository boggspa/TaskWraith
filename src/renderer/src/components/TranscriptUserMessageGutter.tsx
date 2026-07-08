import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord } from '../../../main/store/types'
import {
  GUTTER_BULGE_MAX_SCALE,
  gutterBulgeRadiusPx,
  layoutGutterLens,
  layoutTranscriptUserGutterMarkers,
  type TranscriptUserGutterMarker
} from '../lib/TranscriptUserMessageGutter'
import { collectMessageMediaRefs } from './ChatMediaPanel'
import { FileTypeIcon } from './FileTypeIcon'

interface GutterFrame {
  left: number
  top: number
  right: number
  bottom: number
  height: number
}

interface ActiveMarkerState {
  key: string
  anchorX: number
  anchorY: number
}

const EDGE_CONTROL_SLOT_PX = 24
const EDGE_CONTROL_GAP_PX = 22
const GUTTER_VERTICAL_OFFSET_PX = 35
const GUTTER_RAIL_WIDTH_PX = 34
const GUTTER_COMPOSER_CLEARANCE_PX = 6
const MAX_RENDERED_GUTTER_MARKERS = 420
const GUTTER_RENDER_CONTEXT_MARKERS = 24

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

/**
 * Bounding box of the pane's floating composer stack (surface + any above-bar
 * rows), in viewport px. The rail's bottom third runs alongside the composer's
 * vertical band, so the frame must keep the WHOLE rail left of this box —
 * with the workspace sidebar collapsed the pane widens and the composer's
 * left edge can otherwise cross the rail's x-position (bleed-under). Children
 * are measured individually because the `.composer-area` wrapper itself spans
 * the full pane width; its centred children are the visible furniture.
 */
function composerStackBox(scroller: HTMLElement): { left: number } | null {
  const composerArea = scroller.closest('.app-transcript')?.querySelector('.composer-area')
  if (!composerArea) return null
  let left = Number.POSITIVE_INFINITY
  for (const child of visibleComposerChildren(composerArea)) {
    const rect = child.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    left = Math.min(left, rect.left)
  }
  return Number.isFinite(left) ? { left } : null
}

/**
 * Left edge of the widest MOUNTED transcript row, in viewport px. Belt for the
 * X anchor: rows are the furniture the rail must visually flank, and anchoring
 * off the row rect (not just `.transcript-inner`, which can be measured
 * mid-relayout) keeps the rail honest even when the inner's rect is briefly
 * stale during a sidebar collapse/expand reflow.
 */
function mountedRowsLeftEdgePx(scroller: HTMLElement): number | null {
  const rows = scroller.querySelectorAll<HTMLElement>('[data-vrow-id]')
  let left = Number.POSITIVE_INFINITY
  let sampled = 0
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    left = Math.min(left, rect.left)
    if (++sampled >= 8) break
  }
  return Number.isFinite(left) ? left : null
}

interface TranscriptUserMessageGutterProps {
  markers: readonly TranscriptUserGutterMarker[]
  /**
   * Scroll-spy: the `key` of the user-message marker the reader is currently
   * inside (derived from the virtualiser's anchor row in TranscriptPanel).
   * Drives the persistent `.is-in-view` / `aria-current` reading-position
   * highlight, kept DISTINCT from the transient hover/focus `activeMarker` so
   * the two never fight for the same hook.
   */
  activeScrollRowKey?: string | null
  /**
   * Overall scroll-progress fraction (0..1) — drives the reading lens's travel
   * and the spent-tick threshold. Driven from TranscriptPanel because the
   * body-portaled rail is not a descendant of the scroller (so a CSS `scroll()`
   * timeline can't bind).
   */
  scrollProgress?: number
  /**
   * Fraction (0..1) of the transcript's content height visible in the viewport.
   * Sizes the skeuomorphic reading-lens carriage (slide-rule-cursor metaphor):
   * lens height = visible share of the thread, lens position = scrollProgress.
   * Omitted / 0 / >=1 hides the lens (unmeasured, or everything fits).
   */
  scrollViewportFraction?: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  currentChat?: ChatRecord | null
  onJumpToMessage: (messageId: string, rowKey: string) => void
  onJumpToStart: () => void
  onJumpToEnd: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function markerMediaKindLabel(kind: string): string {
  if (kind === 'folder') return 'Folder'
  if (kind === 'image') return 'Image'
  if (kind === 'audio') return 'Audio'
  if (kind === 'video') return 'Video'
  return 'File'
}

function TranscriptUserGutterPreview({
  marker,
  anchor,
  frame,
  currentChat,
  onJumpToMessage,
  onKeepOpen,
  onDismiss,
  onEscape
}: {
  marker: TranscriptUserGutterMarker
  anchor: ActiveMarkerState
  frame: GutterFrame
  currentChat?: ChatRecord | null
  onJumpToMessage: (messageId: string, rowKey: string) => void
  onKeepOpen: () => void
  onDismiss: () => void
  onEscape: () => void
}): React.JSX.Element {
  const mediaRefs = collectMessageMediaRefs(marker.message)
  const visibleMediaRefs = mediaRefs.slice(0, 3)
  const moreCount = Math.max(0, mediaRefs.length - visibleMediaRefs.length)
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
  const previewWidth = 360
  const previewHeight = 190
  const bounds = {
    left: clamp(frame.left - 10, 10, viewportWidth - 20),
    right: clamp(frame.right - 10, 20, viewportWidth - 10),
    top: clamp(frame.top - 14, 10, viewportHeight - 20),
    bottom: clamp(frame.bottom + 14, 20, viewportHeight - 10)
  }
  const opensRight = anchor.anchorX + 12 + previewWidth <= bounds.right
  const left = opensRight
    ? clamp(anchor.anchorX + 12, bounds.left, bounds.right - previewWidth)
    : clamp(anchor.anchorX - previewWidth - 12, bounds.left, bounds.right - previewWidth)
  const top = clamp(anchor.anchorY - previewHeight / 2, bounds.top, bounds.bottom - previewHeight)
  const jumpToMarker = () => onJumpToMessage(marker.messageId, marker.rowKey)

  return (
    <div
      className="transcript-user-gutter-preview"
      style={{ left, top }}
      role="button"
      tabIndex={0}
      aria-label={`Jump to user message ${marker.ordinal}: ${marker.title}`}
      onMouseEnter={onKeepOpen}
      onMouseLeave={onDismiss}
      onFocus={onKeepOpen}
      onClick={jumpToMarker}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          // Return focus to the originating marker (never drop to <body>) before
          // the preview unmounts, so keyboard tab-order context survives.
          onEscape()
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          jumpToMarker()
        }
      }}
    >
      <div className="transcript-user-gutter-preview-title">{marker.title}</div>
      {marker.preview && <div className="transcript-user-gutter-preview-body">{marker.preview}</div>}
      {visibleMediaRefs.length > 0 && (
        <div className="transcript-user-gutter-preview-attachments" aria-label="Attachments">
          {visibleMediaRefs.map((ref) => (
            <span
              key={ref.id}
              className="transcript-user-gutter-preview-attachment"
              title={`${markerMediaKindLabel(ref.kind)}: ${ref.name}`}
            >
              <FileTypeIcon
                path={ref.path || ref.name}
                size={12}
                workspacePath={currentChat?.workspacePath}
              />
              <span>{ref.name}</span>
            </span>
          ))}
          {moreCount > 0 && (
            <span className="transcript-user-gutter-preview-attachment is-overflow">
              +{moreCount}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function TranscriptUserMessageGutter({
  markers,
  activeScrollRowKey,
  scrollProgress,
  scrollViewportFraction,
  scrollRef,
  contentRef,
  currentChat,
  onJumpToMessage,
  onJumpToStart,
  onJumpToEnd
}: TranscriptUserMessageGutterProps): React.JSX.Element | null {
  const [frame, setFrame] = useState<GutterFrame | null>(null)
  const [activeMarker, setActiveMarker] = useState<ActiveMarkerState | null>(null)
  const markerRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const dismissTimerRef = useRef<number | null>(null)
  // Preview open-delay (pointer only): a short dwell before the popover commits,
  // so dragging the cursor down a dense compact rail doesn't strobe a preview per
  // marker passed over. Keyboard focus opens immediately (no dwell).
  const openTimerRef = useRef<number | null>(null)
  // Dock/fisheye bulge plumbing. All per-frame work is direct-DOM (transform
  // writes via markerRefs), never React state — a pointermove must not re-render.
  const railRef = useRef<HTMLDivElement | null>(null)
  const pointerYRef = useRef<number | null>(null)
  const railTopRef = useRef(0)
  const bulgeRafRef = useRef<number | null>(null)
  // Cached per-marker centre Y within the rail (markerTrackTop + layout topPx),
  // refreshed each render so the bulge never reads getBoundingClientRect per frame.
  const markerCentersRef = useRef<Map<string, number>>(new Map())
  const bulgeConfigRef = useRef<{ radius: number; maxScale: number }>({
    radius: gutterBulgeRadiusPx(markers.length),
    maxScale: GUTTER_BULGE_MAX_SCALE
  })
  // Reduced-motion / coarse-pointer gate: when off, the bulge is skipped entirely
  // and the CSS width-grow fallback (see .is-bulging gate) drives hover instead.
  const bulgeEnabledRef = useRef(true)

  const updateFrame = useCallback(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    // Self-hide when the scroller isn't laid out — `offsetParent` is null when
    // the element or an ancestor is `display:none` (the transcript is hidden for
    // Settings / a board takeover). The scroller is a normal block (never
    // position:fixed), so this only ever means "not visible". Belt to the
    // `html.tw-settings-active` CSS suppressor for any non-settings takeover.
    if (scroller.offsetParent === null) {
      setFrame(null)
      return
    }
    const scrollerRect = scroller.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const gapLeft = contentRect.left - scrollerRect.left
    if (markers.length < 2 || scrollerRect.width < 720 || gapLeft < 34) {
      setFrame(null)
      return
    }
    // X anchor: the rail flanks the leftmost of (a) the transcript inner, (b)
    // the widest MOUNTED row, and (c) the floating composer stack. (b) guards
    // against a stale/mid-reflow inner rect (sidebar collapse animates the
    // pane width); (c) keeps the rail fully LEFT of the composer, whose
    // max-width can exceed the column's on a wide pane — anchoring off the
    // content edge alone let the rail bleed under the composer/roster.
    const composerBox = composerStackBox(scroller)
    const rowsLeft = mountedRowsLeftEdgePx(scroller)
    let anchorLeft = contentRect.left
    if (rowsLeft !== null) anchorLeft = Math.min(anchorLeft, rowsLeft)
    if (composerBox) {
      anchorLeft = Math.min(anchorLeft, composerBox.left - GUTTER_COMPOSER_CLEARANCE_PX)
    }
    // Hard floor at the settled Sidebar's right edge. The rail is a body-portaled
    // position:fixed element at z-index 10030 — it paints ABOVE the sidebar, so a
    // stale/mid-reflow scrollerRect (which can briefly read near the pane's left
    // edge during a roster/composer/sidebar relayout) would drop the rail over the
    // bottom-left footer pills (Devices/Shares/Approvals/Settings). The sidebar
    // settles early and is stable, so its right edge is a reliable guard even
    // before the transcript column has finished laying out.
    const sidebarEl = scroller.closest('.app-main')?.querySelector('.app-sidebar')
    const sidebarRight =
      sidebarEl instanceof HTMLElement ? sidebarEl.getBoundingClientRect().right : 0
    const left = Math.max(
      scrollerRect.left + 4,
      sidebarRight + 4,
      anchorLeft - GUTTER_RAIL_WIDTH_PX
    )
    // No lane left of the composer → hide rather than overlap.
    if (composerBox && left + GUTTER_RAIL_WIDTH_PX > composerBox.left + 1) {
      setFrame(null)
      return
    }
    const topInset = clamp(scrollerRect.height * 0.12, 64, 104)
    const bottomInset = clamp(scrollerRect.height * 0.08, 56, 96)
    const top = scrollerRect.top + topInset + GUTTER_VERTICAL_OFFSET_PX
    const right = Math.min(scrollerRect.right - 8, contentRect.left + 420)
    const bottom = scrollerRect.bottom - bottomInset + GUTTER_VERTICAL_OFFSET_PX
    const height = Math.max(120, scrollerRect.height - topInset - bottomInset)
    setFrame((current) => {
      if (
        current &&
        Math.abs(current.left - left) < 0.5 &&
        Math.abs(current.top - top) < 0.5 &&
        Math.abs(current.right - right) < 0.5 &&
        Math.abs(current.bottom - bottom) < 0.5 &&
        Math.abs(current.height - height) < 0.5
      ) {
        return current
      }
      return { left, top, right, bottom, height }
    })
  }, [contentRef, markers.length, scrollRef])

  useLayoutEffect(() => {
    updateFrame()
    const frameIds: number[] = []
    let timeoutId: number | null = null
    if (typeof window !== 'undefined') {
      const scheduleFrame = () => {
        frameIds.push(window.requestAnimationFrame(updateFrame))
      }
      frameIds.push(
        window.requestAnimationFrame(() => {
          updateFrame()
          scheduleFrame()
        })
      )
      timeoutId = window.setTimeout(updateFrame, 160)
    }
    let observer: ResizeObserver | null = null
    let fontsCancelled = false
    const scroller = scrollRef.current
    const content = contentRef.current
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateFrame())
      if (scroller) observer.observe(scroller)
      if (content) observer.observe(content)
      // The composer clamp (composerStackBox) depends on the composer
      // stack's size — observe it too so an ensemble roster mounting or a
      // composer-style swap re-clamps the rail without a window resize.
      const composerArea = scroller?.closest('.app-transcript')?.querySelector('.composer-area')
      if (composerArea instanceof HTMLElement) observer.observe(composerArea)
    }
    // Web-font swap reflows the transcript/composer after first paint; the rAF +
    // 160ms belts can land before fonts settle, leaving the rail offset until an
    // incidental scroll. One more measure on fonts.ready closes that gap.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!fontsCancelled) updateFrame()
      })
    }
    return () => {
      fontsCancelled = true
      observer?.disconnect()
      for (const frameId of frameIds) window.cancelAnimationFrame(frameId)
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [contentRef, scrollRef, updateFrame])

  useEffect(() => {
    const handleResize = () => updateFrame()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [updateFrame])

  // Layout-settle belt: the sidebar collapse/expand and dock open/close are
  // 260ms width/transform transitions. ResizeObserver fires while they run,
  // but the FINAL settled geometry can land between observer ticks — one more
  // measure at transitionend guarantees the rail's fixed frame matches the
  // resting layout. Filtered to geometry-affecting properties and to events
  // outside the rail itself (marker width/background transitions would
  // otherwise re-measure on every hover). setFrame's <0.5px bail makes the
  // no-change case free.
  useEffect(() => {
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (!/^(width|left|right|transform|flex-basis|margin-left)$/.test(event.propertyName)) return
      if (event.target instanceof Node && railRef.current?.contains(event.target)) return
      updateFrame()
    }
    document.addEventListener('transitionend', handleTransitionEnd, true)
    return () => document.removeEventListener('transitionend', handleTransitionEnd, true)
  }, [updateFrame])

  const activeMarkerModel = useMemo(
    () => markers.find((marker) => marker.key === activeMarker?.key) || null,
    [activeMarker?.key, markers]
  )
  const markerTrackTop = frame ? EDGE_CONTROL_SLOT_PX : 0
  const markerTrackHeight = frame ? Math.max(60, frame.height - EDGE_CONTROL_SLOT_PX * 2) : 0
  const markerLayout = useMemo(() => {
    if (!frame) return null
    return layoutTranscriptUserGutterMarkers(markers, markerTrackHeight)
  }, [frame, markerTrackHeight, markers])
  const markerLayoutByKey = useMemo(() => {
    if (!markerLayout) return null
    return new Map(markerLayout.map((layout) => [layout.key, layout.topPx]))
  }, [markerLayout])
  const markerStackBounds = useMemo(() => {
    if (!frame || !markerLayout || markerLayout.length === 0) return null
    const markerCenters = markerLayout.map((layout) => markerTrackTop + layout.topPx)
    const first = Math.min(...markerCenters)
    const last = Math.max(...markerCenters)
    return {
      first,
      last,
      topEdge: clamp(first - EDGE_CONTROL_GAP_PX, 0, frame.height),
      bottomEdge: clamp(last + EDGE_CONTROL_GAP_PX, 0, frame.height)
    }
  }, [frame, markerLayout, markerTrackTop])

  // Cache each marker's centre Y (rail-relative) so the bulge rAF is pure
  // arithmetic — zero getBoundingClientRect per frame. Refreshed every render.
  const markerCenters = useMemo(() => {
    const centers = new Map<string, number>()
    if (markerLayout) {
      for (const layout of markerLayout) centers.set(layout.key, markerTrackTop + layout.topPx)
    }
    return centers
  }, [markerLayout, markerTrackTop])

  // Publish the bulge's geometry to refs AFTER render (not during) — the rAF only
  // reads them on pointer events, so a layout-effect update is correctly timed and
  // avoids updating refs mid-render.
  useLayoutEffect(() => {
    markerCentersRef.current = markerCenters
    bulgeConfigRef.current = {
      radius: gutterBulgeRadiusPx(markers.length),
      maxScale: GUTTER_BULGE_MAX_SCALE
    }
  }, [markerCenters, markers.length])

  // React keys: prefer the stable `messageId` so a mid-transcript delete/insert
  // (which reindexes every later `rowKey = id#index`) reconciles in place —
  // preserving hover state, dismiss/open timers, and in-flight bulge transforms
  // instead of remounting. Fall back to the collision-proof `rowKey` ONLY for the
  // rare duplicate message id (historical/imported data), so keys stay unique.
  const duplicateMessageIds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const marker of markers) {
      counts.set(marker.messageId, (counts.get(marker.messageId) || 0) + 1)
    }
    const dupes = new Set<string>()
    for (const [id, count] of counts) if (count > 1) dupes.add(id)
    return dupes
  }, [markers])
  const markerReactKey = useCallback(
    (marker: TranscriptUserGutterMarker): string =>
      duplicateMessageIds.has(marker.messageId) ? marker.rowKey : marker.messageId,
    [duplicateMessageIds]
  )

  // One rAF-coalesced pass: write each marker line's scaleX from its distance to
  // the cursor via a raised-cosine falloff (continuous derivative → no "pop" as
  // markers cross the influence edge, which matters at 5px compact spacing).
  // pointerY === null (pointer left) resets every line to its CSS transform.
  const applyBulge = useCallback(() => {
    bulgeRafRef.current = null
    const pointerY = pointerYRef.current
    const centers = markerCentersRef.current
    const { radius, maxScale } = bulgeConfigRef.current
    for (const [key, button] of markerRefs.current) {
      const line = button.firstElementChild as HTMLElement | null
      if (!line) continue
      const center = centers.get(key)
      if (pointerY === null || center === undefined) {
        line.style.transform = ''
        continue
      }
      const t = clamp((pointerY - center) / radius, -1, 1)
      const falloff = (1 + Math.cos(t * Math.PI)) / 2
      const scale = 1 + (maxScale - 1) * falloff
      line.style.transform = `translateY(-50%) scaleX(${scale.toFixed(3)})`
    }
  }, [])

  const scheduleBulge = useCallback(() => {
    if (bulgeRafRef.current !== null) return
    bulgeRafRef.current = window.requestAnimationFrame(applyBulge)
  }, [applyBulge])

  const handleRailPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // `bulgeEnabledRef` covers OS reduced-motion + coarse pointer (media-driven);
      // also honour the app's own `data-reduce-motion` toggle live here so flipping
      // it mid-session disables the bulge without waiting for a media change.
      if (
        !bulgeEnabledRef.current ||
        (typeof document !== 'undefined' &&
          document.documentElement.getAttribute('data-reduce-motion') === 'true')
      ) {
        return
      }
      const rail = railRef.current
      if (!rail) return
      if (!rail.classList.contains('is-bulging')) rail.classList.add('is-bulging')
      // Re-read the rail's viewport top on every real pointermove (input-rate, not
      // per-rAF-frame, so it doesn't reintroduce a per-frame layout read). This keeps
      // the bulge aligned if the rail's fixed `top` shifts mid-hover — a window
      // resize / sidebar collapse moves frame.top while the pointer stays on the
      // strip, and the cached marker centres stay frame.top-independent, so a stale
      // rail top would otherwise offset the bulge peak for the rest of the hover.
      railTopRef.current = rail.getBoundingClientRect().top
      pointerYRef.current = event.clientY - railTopRef.current
      scheduleBulge()
    },
    [scheduleBulge]
  )

  const handleRailPointerLeave = useCallback(() => {
    pointerYRef.current = null
    railRef.current?.classList.remove('is-bulging')
    scheduleBulge()
  }, [scheduleBulge])

  // Resolve the reduced-motion / coarse-pointer gate on mount + on OS changes.
  // The app's own `data-reduce-motion` attribute is also honoured live in the
  // move handler path via this ref (recomputed here on the media signals).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const coarseQuery = window.matchMedia('(pointer: coarse)')
    const compute = (): void => {
      const attrReduce =
        typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-reduce-motion') === 'true'
      bulgeEnabledRef.current = !reduceQuery.matches && !attrReduce && !coarseQuery.matches
    }
    compute()
    reduceQuery.addEventListener('change', compute)
    coarseQuery.addEventListener('change', compute)
    return () => {
      reduceQuery.removeEventListener('change', compute)
      coarseQuery.removeEventListener('change', compute)
    }
  }, [])

  // Cancel any in-flight bulge frame on unmount.
  useEffect(() => {
    return () => {
      if (bulgeRafRef.current !== null) window.cancelAnimationFrame(bulgeRafRef.current)
    }
  }, [])

  const cancelDismiss = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }, [])

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
  }, [])

  const scheduleDismiss = useCallback(() => {
    cancelDismiss()
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null
      setActiveMarker(null)
    }, 120)
  }, [cancelDismiss])

  useEffect(() => {
    return () => {
      cancelDismiss()
      cancelOpen()
    }
  }, [cancelDismiss, cancelOpen])

  useEffect(() => {
    if (!activeMarker) return
    if (markers.some((marker) => marker.key === activeMarker.key)) return
    setActiveMarker(null)
  }, [activeMarker, markers])

  const activateMarker = useCallback(
    (marker: TranscriptUserGutterMarker, button: HTMLButtonElement, immediate: boolean) => {
      cancelDismiss()
      cancelOpen()
      const commit = (): void => {
        openTimerRef.current = null
        // If the marker's row was removed during the dwell, the button unmounts;
        // skip so we don't read a detached (zero) rect or set a dangling activeMarker.
        if (!button.isConnected) return
        const rect = button.getBoundingClientRect()
        setActiveMarker({
          key: marker.key,
          anchorX: rect.right,
          anchorY: rect.top + rect.height / 2
        })
      }
      // Focus (keyboard) opens at once; pointer hover waits out a brief dwell so a
      // fast traversal across a dense rail doesn't spawn a preview per marker.
      if (immediate) commit()
      else openTimerRef.current = window.setTimeout(commit, 110)
    },
    [cancelDismiss, cancelOpen]
  )

  // Roving-tabindex default: prefer the hovered/focused marker, then fall back
  // to the scroll-spy in-view marker, so Tab-into-rail lands on the reader's
  // current position rather than always the oldest message. Finally 0.
  const activeIndex = (() => {
    if (activeMarker) {
      const hovered = markers.findIndex((marker) => marker.key === activeMarker.key)
      if (hovered >= 0) return hovered
    }
    if (activeScrollRowKey) {
      const inView = markers.findIndex((marker) => marker.key === activeScrollRowKey)
      if (inView >= 0) return inView
    }
    return 0
  })()

  const renderedMarkerIndexes = useMemo(() => {
    if (markers.length <= MAX_RENDERED_GUTTER_MARKERS) {
      return markers.map((_, index) => index)
    }
    const keep = new Set<number>([0, markers.length - 1, activeIndex])
    const contextStart = Math.max(0, activeIndex - GUTTER_RENDER_CONTEXT_MARKERS)
    const contextEnd = Math.min(markers.length - 1, activeIndex + GUTTER_RENDER_CONTEXT_MARKERS)
    for (let index = contextStart; index <= contextEnd; index += 1) keep.add(index)
    const remaining = Math.max(0, MAX_RENDERED_GUTTER_MARKERS - keep.size)
    if (remaining > 0) {
      const step = (markers.length - 1) / Math.max(1, remaining - 1)
      for (let i = 0; i < remaining; i += 1) {
        keep.add(Math.round(i * step))
      }
    }
    return Array.from(keep)
      .filter((index) => index >= 0 && index < markers.length)
      .sort((a, b) => a - b)
  }, [activeIndex, markers])

  const renderedMarkers = useMemo(
    () =>
      renderedMarkerIndexes
        .map((index) => {
          const marker = markers[index]
          return marker ? { marker, index } : null
        })
        .filter((item): item is { marker: TranscriptUserGutterMarker; index: number } =>
          Boolean(item)
        ),
    [markers, renderedMarkerIndexes]
  )

  const focusMarkerAt = useCallback(
    (index: number) => {
      if (markers.length === 0) return
      const clamped = Math.max(0, Math.min(markers.length - 1, index))
      const direct = markers[clamped]
      const directRef = direct ? markerRefs.current.get(direct.key) : null
      if (directRef) {
        directRef.focus()
        return
      }
      let nearest = renderedMarkerIndexes[0] ?? clamped
      let nearestDistance = Math.abs(nearest - clamped)
      for (const candidate of renderedMarkerIndexes) {
        const distance = Math.abs(candidate - clamped)
        if (distance >= nearestDistance) continue
        nearest = candidate
        nearestDistance = distance
      }
      const marker = markers[nearest]
      if (!marker) return
      markerRefs.current.get(marker.key)?.focus()
    },
    [markers, renderedMarkerIndexes]
  )

  const focusRenderedMarkerFrom = useCallback(
    (index: number, direction: -1 | 1) => {
      const renderedIndex = renderedMarkerIndexes.indexOf(index)
      if (renderedIndex < 0) {
        focusMarkerAt(index + direction)
        return
      }
      const nextRenderedIndex = Math.max(
        0,
        Math.min(renderedMarkerIndexes.length - 1, renderedIndex + direction)
      )
      focusMarkerAt(renderedMarkerIndexes[nextRenderedIndex])
    },
    [focusMarkerAt, renderedMarkerIndexes]
  )

  if (markers.length < 2) return null

  const progressFraction = Math.max(
    0,
    Math.min(1, Number.isFinite(scrollProgress) ? (scrollProgress as number) : 0)
  )

  // Skeuomorphic reading lens: a slide-rule-cursor carriage riding the stack.
  // Geometry (height = visible share, position = scroll progress) is THE
  // scroll-position channel now that the vertical spine/fill is gone.
  const lensLayout = markerStackBounds
    ? layoutGutterLens(
        markerStackBounds.first,
        markerStackBounds.last,
        progressFraction,
        Number.isFinite(scrollViewportFraction) ? (scrollViewportFraction as number) : 0
      )
    : null

  // "Spent ticks": the rail pixel the read position has reached (progress
  // mapped across the stack span). Markers whose centre sits at/above it get
  // `.is-read` — passed ticks visibly settle, a second geometry-side cue.
  const readFillPx = markerStackBounds
    ? markerStackBounds.first +
      (markerStackBounds.last - markerStackBounds.first) * progressFraction
    : null

  const rail = (
    <div
      ref={railRef}
      className={`transcript-user-gutter${frame ? '' : ' is-unmeasured'}`}
      style={frame ? { left: frame.left, top: frame.top, height: frame.height } : undefined}
      role="navigation"
      aria-label="User messages"
      onPointerMove={handleRailPointerMove}
      onPointerLeave={handleRailPointerLeave}
    >
      <button
        type="button"
        className="transcript-user-gutter-edge transcript-user-gutter-edge--top"
        style={markerStackBounds ? { top: markerStackBounds.topEdge } : undefined}
        onClick={onJumpToStart}
        aria-label="Jump to beginning of thread"
        title="Jump to beginning"
      >
        <span aria-hidden="true">↑</span>
      </button>
      {lensLayout && (
        <div
          className="transcript-user-gutter-lens"
          aria-hidden="true"
          style={{ top: lensLayout.topPx, height: lensLayout.heightPx }}
        />
      )}
      {renderedMarkers.map(({ marker, index }) => (
        <button
          key={markerReactKey(marker)}
          ref={(element) => {
            if (element) markerRefs.current.set(marker.key, element)
            else markerRefs.current.delete(marker.key)
          }}
          type="button"
          className={`transcript-user-gutter-marker${
            activeMarker?.key === marker.key ? ' is-active' : ''
          }${activeScrollRowKey === marker.key ? ' is-in-view' : ''}${
            readFillPx !== null && (markerCenters.get(marker.key) ?? Infinity) <= readFillPx + 0.5
              ? ' is-read'
              : ''
          }`}
          style={{
            top:
              markerLayoutByKey?.get(marker.key) !== undefined
                ? markerTrackTop + (markerLayoutByKey.get(marker.key) || 0)
                : `${marker.topPercent}%`
          }}
          data-message-id={marker.messageId}
          data-row-key={marker.rowKey}
          aria-current={activeScrollRowKey === marker.key ? 'true' : undefined}
          aria-label={`Jump to user message ${marker.ordinal}: ${marker.title}`}
          tabIndex={index === activeIndex ? 0 : -1}
          onMouseEnter={(event) => activateMarker(marker, event.currentTarget, false)}
          onMouseLeave={() => {
            cancelOpen()
            scheduleDismiss()
          }}
          onFocus={(event) => activateMarker(marker, event.currentTarget, true)}
          onBlur={(event) => {
            const related = event.relatedTarget
            const rail = event.currentTarget.closest('.transcript-user-gutter')
            if (related instanceof Node && rail?.contains(related)) return
            cancelOpen()
            scheduleDismiss()
          }}
          onKeyDown={(event) => {
            const currentIndex = index
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
              event.preventDefault()
              focusRenderedMarkerFrom(currentIndex, 1)
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
              event.preventDefault()
              focusRenderedMarkerFrom(currentIndex, -1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              focusMarkerAt(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              focusMarkerAt(markers.length - 1)
            }
          }}
          onClick={() => onJumpToMessage(marker.messageId, marker.rowKey)}
        >
          <span className="transcript-user-gutter-line" aria-hidden />
        </button>
      ))}
      <button
        type="button"
        className="transcript-user-gutter-edge transcript-user-gutter-edge--bottom"
        style={markerStackBounds ? { top: markerStackBounds.bottomEdge } : undefined}
        onClick={onJumpToEnd}
        aria-label="Jump to latest message"
        title="Jump to latest"
      >
        <span aria-hidden="true">↓</span>
      </button>
      {activeMarker && activeMarkerModel && frame && (
        <TranscriptUserGutterPreview
          marker={activeMarkerModel}
          anchor={activeMarker}
          frame={frame}
          currentChat={currentChat}
          onJumpToMessage={(messageId, rowKey) => {
            onJumpToMessage(messageId, rowKey)
            setActiveMarker(null)
          }}
          onKeepOpen={cancelDismiss}
          onDismiss={scheduleDismiss}
          onEscape={() => {
            cancelDismiss()
            cancelOpen()
            markerRefs.current.get(activeMarkerModel.key)?.focus()
            setActiveMarker(null)
          }}
        />
      )}
    </div>
  )

  return typeof document === 'undefined' ? rail : createPortal(rail, document.body)
}
