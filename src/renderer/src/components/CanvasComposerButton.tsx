// Composer telemetry-row button that opens Canvas surfaces in the right dock
// (the one-click entry point — vs. the multiview empty-pane launcher, or
// asking an agent to canvas_open). It mirrors the other footer icons (Multiview /
// Screen Watch / Goal): a bare icon-only trigger (composer-canvas-trigger) with a
// hover/focus hint pill (composer-hint-pill + data-hint-label), and a portaled
// picker popover (so the composer-surface's overflow:hidden can't clip it).
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { resolveComposerSurfacePopoverPosition } from '../lib/composerSurfacePopover'
import {
  MESH_CANVAS_NEEDS_SAVED_CHAT,
  hasMeshCanvasChatAuthority,
  meshCanvasIssueMessage
} from '../lib/meshCanvasAvailability'
import { requestMeshCanvasOpen } from '../lib/meshCanvasLaunch'
import { requestSimulatorCanvasOpen } from '../lib/simulatorCanvasLaunch'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'
import { PillButton } from './PillButton'

export interface CanvasComposerButtonProps {
  disabled?: boolean
  chatId?: string | null
  composerStyle?: string
  /** Slash-command open request — see `lib/composerSurfaceRequest`. Each new
   * positive value opens the popover once; 0 is inert. */
  openSignal?: number
}

/**
 * One popover section: title + description on the left, the action pill beside
 * them on the right. `minmax(0, 1fr)` lets the description shrink instead of
 * forcing the popover wider, and `center` keeps a single-line pill optically
 * level with a two-line text block.
 */
const CANVAS_SECTION_ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  columnGap: 10,
  alignItems: 'center'
}

const CANVAS_SECTION_TEXT: CSSProperties = { display: 'grid', gap: 4, minWidth: 0 }

/** A user-facing hint for the common embed failures (no server / bad url). */
export function friendlyCanvasError(raw: string | undefined): string {
  const msg = raw || 'Could not open the canvas.'
  if (/CONNECTION_REFUSED|ERR_|NAME_NOT_RESOLVED|timed out/i.test(msg)) {
    return "Couldn't load that URL — is a dev server running there?"
  }
  return msg
}

function CanvasGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function sketchBridgeAvailable(): boolean {
  return typeof window === 'undefined' ? true : Boolean(window.api.canvas?.openSketchEmbedded)
}

export function CanvasComposerButton({
  disabled,
  chatId,
  composerStyle = 'default',
  openSignal
}: CanvasComposerButtonProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyMode, setBusyMode] = useState<'web' | 'sketch' | 'mesh' | 'simulator' | null>(null)
  const canOpenSketch = sketchBridgeAvailable()

  // Clear any stale error when the popover closes, so reopening starts fresh.
  useEffect(() => {
    if (!open) setError(null)
  }, [open])

  // `/canvas` opens the same picker the icon does. `disabled` is read at fire
  // time so a later disabling re-render can't retroactively re-open it.
  useEffect(() => {
    if (!openSignal || disabled) return
    setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal])

  const handleOpen = async (): Promise<void> => {
    setError(null)
    setBusyMode('web')
    try {
      if (!chatId) throw new Error('Canvas requires an active chat.')
      const result = await window.api.canvas?.openEmbedded({
        chatId,
        presentation: 'dock'
      })
      if (result?.ok) {
        setOpen(false)
      } else {
        setError(friendlyCanvasError(result?.error))
      }
    } catch (err) {
      setError(friendlyCanvasError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusyMode(null)
    }
  }

  const handleOpenSketch = async (): Promise<void> => {
    setError(null)
    const openSketchEmbedded = window.api.canvas?.openSketchEmbedded
    if (!openSketchEmbedded) {
      setError('Sketch Canvas needs the updated preload bridge. Restart TaskWraith and try again.')
      return
    }
    if (!chatId) {
      setError('Canvas requires an active chat.')
      return
    }
    setBusyMode('sketch')
    try {
      const result = await openSketchEmbedded({ chatId, presentation: 'dock' })
      if (result?.ok) {
        setOpen(false)
      } else {
        setError(friendlyCanvasError(result?.error))
      }
    } catch (err) {
      setError(friendlyCanvasError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusyMode(null)
    }
  }

  const handleOpenMesh = async (): Promise<void> => {
    setError(null)
    if (!chatId) {
      setError(MESH_CANVAS_NEEDS_SAVED_CHAT)
      return
    }
    setBusyMode('mesh')
    try {
      // The renderer can briefly retain a just-reaped welcome draft after a
      // reload. Check main's canonical chat store before requesting a
      // chat-scoped canvas; never turn that stale renderer id into authority.
      if (!(await hasMeshCanvasChatAuthority(chatId))) {
        setError(MESH_CANVAS_NEEDS_SAVED_CHAT)
        return
      }
      requestMeshCanvasOpen(chatId)
      setOpen(false)
    } catch (error) {
      setError(meshCanvasIssueMessage(error, 'Mesh Canvas could not be opened.'))
    } finally {
      setBusyMode(null)
    }
  }

  const handleOpenSimulator = async (): Promise<void> => {
    setError(null)
    if (!chatId) {
      setError('Simulator Canvas requires an active chat.')
      return
    }
    setBusyMode('simulator')
    try {
      // Same cheap main getChat soft-check as Mesh — renderer draft ids can
      // briefly outlive a reaped welcome chat after reload.
      if (!(await hasMeshCanvasChatAuthority(chatId))) {
        setError('Simulator Canvas requires an active chat.')
        return
      }
      requestSimulatorCanvasOpen(chatId)
      setOpen(false)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Simulator Canvas could not be opened.')
    } finally {
      setBusyMode(null)
    }
  }

  // Anchor the popover above the trigger (mirrors ComposerPlusPicker), clamped
  // into the viewport so it never overflows at narrow widths / in split panes.
  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const surface = trigger.closest('.composer-surface') as HTMLElement | null
    const surfaceRect = surface?.getBoundingClientRect() ?? rect
    setPosition(
      resolveComposerSurfacePopoverPosition({
        triggerRect: rect,
        surfaceRect,
        viewportWidth: window.innerWidth
      })
    )
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const popover =
    open && position
      ? createPortal(
          <div
            ref={popoverRef}
            // Reuse the Model/Reasoning/Provider picker's frosted-glass popover
            // (opaque panel-elevated bg + backdrop blur, light-theme variant
            // included) so it's readable; override only its row layout — our
            // content is a vertical form, not the pickers' multi-column grid.
            className={`composer-combined-picker-popover composer-plus-picker-popover canvas-composer-popover shell-${composerStyle}`}
            role="dialog"
            aria-label="Open Canvas"
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              width: `${position.width}px`,
              maxWidth: 'calc(100vw - 16px)',
              transform: 'translateY(-100%)',
              flexDirection: 'column',
              gap: 8,
              minWidth: 0,
              padding: 10
            }}
          >
            <div style={{ font: '12px/1.35 system-ui, sans-serif', fontWeight: 600 }}>
              Canvas
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {/* Text block and action share one row — the pill sits beside the
                title/description rather than claiming a third line. Width and
                alignment come from `.canvas-composer-popover
                .segmented-control-action` (shard 03), which lines all three
                Canvas actions up as one right-hand column at a shared width. */}
              <div style={CANVAS_SECTION_ROW}>
                <div style={CANVAS_SECTION_TEXT}>
                  <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.74 }}>
                    Mesh Canvas
                  </div>
                  <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.58 }}>
                    Import a local GLB/glTF scene or OBJ model into this chat.
                  </div>
                </div>
                <PillButton
                  onClick={() => void handleOpenMesh()}
                  disabled={busyMode !== null || !chatId}
                >
                  {busyMode === 'mesh' ? 'Opening Mesh Canvas…' : 'Open Mesh Canvas'}
                </PillButton>
              </div>
              <div
                style={{
                  height: 1,
                  background: 'var(--border-subtle, rgba(127,127,127,0.22))'
                }}
              />
              <div style={CANVAS_SECTION_ROW}>
                <div style={CANVAS_SECTION_TEXT}>
                  <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.74 }}>
                    Simulator Canvas
                  </div>
                  <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.58 }}>
                    Preview an iOS Simulator in this chat.
                  </div>
                </div>
                <PillButton
                  onClick={() => void handleOpenSimulator()}
                  disabled={busyMode !== null || !chatId}
                >
                  {busyMode === 'simulator' ? 'Opening Simulator Canvas…' : 'Open Simulator Canvas'}
                </PillButton>
              </div>
              <div
                style={{
                  height: 1,
                  background: 'var(--border-subtle, rgba(127,127,127,0.22))'
                }}
              />
              <div
                style={{
                  display: 'grid',
                  gap: 6,
                  paddingTop: 2
                }}
              >
                <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.74 }}>
                  Browser
                </div>
                <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.58 }}>
                  Open an empty browser, then navigate from its address bar.
                </div>
                <CanvasPaneLauncher onOpen={() => void handleOpen()} />
              </div>
              <div
                style={{
                  height: 1,
                  background: 'var(--border-subtle, rgba(127,127,127,0.22))'
                }}
              />
              <div style={CANVAS_SECTION_ROW}>
                <div style={CANVAS_SECTION_TEXT}>
                  <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.74 }}>
                    Sketch Canvas
                  </div>
                  <div style={{ font: '11px/1.35 system-ui, sans-serif', opacity: 0.58 }}>
                    {canOpenSketch
                      ? 'Quick shapes, freehand marks, arrows, and text.'
                      : 'Restart TaskWraith to load the Sketch Canvas bridge.'}
                  </div>
                </div>
                <PillButton
                  onClick={() => void handleOpenSketch()}
                  disabled={busyMode !== null || !canOpenSketch}
                >
                  Open sketch canvas
                </PillButton>
              </div>
            </div>
            {error ? (
              <div
                role="alert"
                style={{
                  marginTop: 6,
                  font: '11px/1.35 system-ui, sans-serif',
                  color: 'var(--status-failed, #e5484d)'
                }}
              >
                {error}
              </div>
            ) : busyMode ? (
              <div style={{ marginTop: 6, font: '11px/1.35 system-ui, sans-serif', opacity: 0.6 }}>
                Opening…
              </div>
            ) : null}
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-canvas-trigger composer-hint-pill composer-hint-pill--left"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Open Canvas"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-hint-label="Canvas"
        data-composer-control="canvas"
      >
        <span className="composer-control-icon" aria-hidden="true">
          <CanvasGlyph />
        </span>
      </button>
      {popover}
    </>
  )
}
