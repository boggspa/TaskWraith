import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord } from '../../../main/store/types'
import {
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

interface TranscriptUserMessageGutterProps {
  markers: readonly TranscriptUserGutterMarker[]
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
  onDismiss
}: {
  marker: TranscriptUserGutterMarker
  anchor: ActiveMarkerState
  frame: GutterFrame
  currentChat?: ChatRecord | null
  onJumpToMessage: (messageId: string, rowKey: string) => void
  onKeepOpen: () => void
  onDismiss: () => void
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
          onDismiss()
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
    const left = Math.max(scrollerRect.left + 8, contentRect.left - 34)
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
    const scroller = scrollRef.current
    const content = contentRef.current
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateFrame())
      if (scroller) observer.observe(scroller)
      if (content) observer.observe(content)
    }
    return () => {
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

  const cancelDismiss = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
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
    return () => cancelDismiss()
  }, [cancelDismiss])

  useEffect(() => {
    if (!activeMarker) return
    if (markers.some((marker) => marker.key === activeMarker.key)) return
    setActiveMarker(null)
  }, [activeMarker, markers])

  const activateMarker = useCallback((marker: TranscriptUserGutterMarker, button: HTMLButtonElement) => {
    cancelDismiss()
    const rect = button.getBoundingClientRect()
    setActiveMarker({
      key: marker.key,
      anchorX: rect.right,
      anchorY: rect.top + rect.height / 2
    })
  }, [cancelDismiss])

  const focusMarkerAt = useCallback(
    (index: number) => {
      const marker = markers[index]
      if (!marker) return
      markerRefs.current.get(marker.key)?.focus()
    },
    [markers]
  )

  if (markers.length < 2) return null

  const activeIndex = Math.max(
    0,
    activeMarker ? markers.findIndex((marker) => marker.key === activeMarker.key) : 0
  )

  const rail = (
    <div
      className={`transcript-user-gutter${frame ? '' : ' is-unmeasured'}`}
      style={frame ? { left: frame.left, top: frame.top, height: frame.height } : undefined}
      role="navigation"
      aria-label="User messages"
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
      {markers.map((marker, index) => (
        <button
          key={marker.key}
          ref={(element) => {
            if (element) markerRefs.current.set(marker.key, element)
            else markerRefs.current.delete(marker.key)
          }}
          type="button"
          className={`transcript-user-gutter-marker${
            activeMarker?.key === marker.key ? ' is-active' : ''
          }`}
          style={{
            top:
              markerLayoutByKey?.get(marker.key) !== undefined
                ? markerTrackTop + (markerLayoutByKey.get(marker.key) || 0)
                : `${marker.topPercent}%`
          }}
          data-message-id={marker.messageId}
          data-row-key={marker.rowKey}
          aria-label={`Jump to user message ${marker.ordinal}: ${marker.title}`}
          tabIndex={index === activeIndex ? 0 : -1}
          onMouseEnter={(event) => activateMarker(marker, event.currentTarget)}
          onMouseLeave={scheduleDismiss}
          onFocus={(event) => activateMarker(marker, event.currentTarget)}
          onBlur={(event) => {
            const related = event.relatedTarget
            const rail = event.currentTarget.closest('.transcript-user-gutter')
            if (related instanceof Node && rail?.contains(related)) return
            scheduleDismiss()
          }}
          onKeyDown={(event) => {
            const currentIndex = markers.findIndex((candidate) => candidate.key === marker.key)
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
              event.preventDefault()
              focusMarkerAt(Math.min(markers.length - 1, currentIndex + 1))
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
              event.preventDefault()
              focusMarkerAt(Math.max(0, currentIndex - 1))
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
        />
      )}
    </div>
  )

  return typeof document === 'undefined' ? rail : createPortal(rail, document.body)
}
