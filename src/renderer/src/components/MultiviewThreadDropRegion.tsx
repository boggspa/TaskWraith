import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { fractionsToTrackList, getMultiviewLayoutSpec } from '../../../shared/multiviewLayouts'
import type { UseMultiviewStateResult } from '../hooks/useMultiviewState'
import {
  multiviewDropZoneAt,
  multiviewPlacementTracks,
  type MultiviewThreadPlacement
} from '../lib/multiviewThreadPlacement'
import { sidebarThreadDragSession } from '../lib/sidebarThreadDragSession'
import { parseSidebarThreadDragPayload, SIDEBAR_THREAD_DRAG_MIME } from '../lib/sidebarThreadOrder'
import './MultiviewThreadDropRegion.css'

export interface MultiviewThreadDropRegionProps {
  children: ReactNode
  multiview: Pick<
    UseMultiviewStateResult,
    'layout' | 'panes' | 'previewThreadDrop' | 'commitThreadDrop'
  >
  visibleChatId: string | null
  /** Null means the thread has disappeared and cannot be placed. */
  resolveThreadTitle: (chatId: string) => string | null
  onOpenSingleThread: (chatId: string) => void
}

/** Capture thread drops before nested composers can consume them as attachments. */
export function MultiviewThreadDropRegion({
  children,
  multiview,
  visibleChatId,
  resolveThreadTitle,
  onOpenSingleThread
}: MultiviewThreadDropRegionProps) {
  const [preview, setPreview] = useState<MultiviewThreadPlacement | null>(null)
  const previewRef = useRef<MultiviewThreadPlacement | null>(null)
  const showPreview = (next: MultiviewThreadPlacement | null) => {
    previewRef.current = next
    setPreview(next)
  }

  useEffect(() => {
    const clear = () => {
      previewRef.current = null
      setPreview(null)
    }
    const cancel = () => {
      sidebarThreadDragSession.cancel()
      clear()
    }
    const end = () => {
      sidebarThreadDragSession.end()
      clear()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }
    const dropped = () => {
      const generation = sidebarThreadDragSession.getSnapshot()?.generation
      if (generation === undefined) return
      // Native event dispatch can run microtasks between document capture and
      // React's root listener. Keep the latch until the whole event has ended.
      // An older drop cannot end a newer drag session.
      window.setTimeout(() => sidebarThreadDragSession.end(generation), 0)
    }
    const unsubscribe = sidebarThreadDragSession.subscribe(() => {
      const session = sidebarThreadDragSession.getSnapshot()
      if (!session || session.cancelled) clear()
    })
    document.addEventListener('dragend', end, true)
    document.addEventListener('drop', dropped, true)
    document.addEventListener('keydown', keydown, true)
    window.addEventListener('blur', cancel)
    return () => {
      unsubscribe()
      document.removeEventListener('dragend', end, true)
      document.removeEventListener('drop', dropped, true)
      document.removeEventListener('keydown', keydown, true)
      window.removeEventListener('blur', cancel)
      sidebarThreadDragSession.cancel()
    }
  }, [])

  const locateRequest = (event: DragEvent<HTMLDivElement>) => {
    const session = sidebarThreadDragSession.getSnapshot()
    if (!session || !sidebarThreadDragSession.accepts(event.dataTransfer)) return null
    if (resolveThreadTitle(session.chatId) === null) return null
    const cell =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.multiview-cell[data-pane-id]')
        : null
    if (multiview.layout !== 'single' && (!cell || !event.currentTarget.contains(cell))) {
      return null
    }
    const rect = (cell ?? event.currentTarget).getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const targetPaneId = cell?.dataset.paneId ?? multiview.panes[0]?.id
    if (!targetPaneId) return null
    return {
      chatId: session.chatId,
      targetPaneId,
      zone: multiviewDropZoneAt(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height
      ),
      visibleChatId
    }
  }

  const hover = (event: DragEvent<HTMLDivElement>) => {
    const session = sidebarThreadDragSession.getSnapshot()
    if (!session || !event.dataTransfer.types.includes(SIDEBAR_THREAD_DRAG_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    sidebarThreadDragSession.enterMultiview()
    const request = locateRequest(event)
    if (!request) {
      event.dataTransfer.dropEffect = 'none'
      showPreview(null)
      return
    }
    const next = multiview.previewThreadDrop(request)
    event.dataTransfer.dropEffect = next.next ? 'move' : 'none'
    const current = previewRef.current
    // Native dragover is frequent. Keep both the overlay and pane subtrees
    // stable when the hovered placement and source state have not changed.
    if (
      current?.base === next.base &&
      current.request.chatId === request.chatId &&
      current.request.targetPaneId === request.targetPaneId &&
      current.request.zone === request.zone &&
      current.request.visibleChatId === request.visibleChatId
    ) {
      return
    }
    showPreview(next)
  }

  const drop = (event: DragEvent<HTMLDivElement>) => {
    const session = sidebarThreadDragSession.getSnapshot()
    if (!session || !event.dataTransfer.types.includes(SIDEBAR_THREAD_DRAG_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    const placement = previewRef.current
    const request = locateRequest(event)
    const payload = parseSidebarThreadDragPayload(
      event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_MIME)
    )
    if (
      placement?.next &&
      request &&
      payload?.chatId === session.chatId &&
      payload.listId === session.listId &&
      placement.request.chatId === request.chatId &&
      placement.request.targetPaneId === request.targetPaneId &&
      placement.request.zone === request.zone &&
      placement.request.visibleChatId === request.visibleChatId &&
      multiview.commitThreadDrop(placement)
    ) {
      // Single-view Thread Home still uses the legacy host's navigation.
      if (placement.next.layout === 'single') onOpenSingleThread(request.chatId)
    }
    sidebarThreadDragSession.end(session.generation)
    showPreview(null)
  }

  const next = preview?.next
  const spec = next ? getMultiviewLayoutSpec(next.layout) : null
  const tracks = next ? multiviewPlacementTracks(next, next.layout) : null
  return (
    <div
      className="chat-split-main multiview-thread-drop-region"
      onDragEnterCapture={hover}
      onDragOverCapture={hover}
      onDropCapture={drop}
      onDragLeaveCapture={(event) => {
        if (!sidebarThreadDragSession.getSnapshot()) return
        const related = event.relatedTarget
        if (related instanceof Node && event.currentTarget.contains(related)) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX <= rect.left ||
          event.clientX >= rect.right ||
          event.clientY <= rect.top ||
          event.clientY >= rect.bottom ||
          (related instanceof Node && !event.currentTarget.contains(related))
        ) {
          showPreview(null)
        }
      }}
    >
      {children}
      {preview && (
        <div className="multiview-thread-drop-preview" aria-hidden="true">
          {next && spec && tracks && (
            <div
              className={`multiview-thread-drop-plan${next.layout === 'single' ? ' is-single' : ''}`}
              style={{
                gridTemplateAreas: spec.gridTemplateAreas,
                gridTemplateColumns: fractionsToTrackList(tracks.columns),
                gridTemplateRows: fractionsToTrackList(tracks.rows)
              }}
            >
              {next.panes.map((pane, index) => (
                <div
                  key={pane.id}
                  className={`multiview-thread-drop-cell${index === preview.destinationIndex ? ' is-destination' : ''}`}
                  style={{ gridArea: spec.cellAreas[index] }}
                >
                  <span>
                    {pane.chatId
                      ? (resolveThreadTitle(pane.chatId) ?? 'Thread')
                      : pane.canvasId
                        ? 'Canvas preview'
                        : (pane.mediaRef?.name ?? 'Empty view')}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className={`multiview-thread-drop-label${next ? '' : ' is-blocked'}`}>
            <strong>{preview.label}</strong>
            <span>Return to sidebar or press Esc to cancel</span>
          </div>
        </div>
      )}
    </div>
  )
}
