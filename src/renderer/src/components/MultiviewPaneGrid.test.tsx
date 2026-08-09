import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MultiviewPaneGrid } from './MultiviewPaneGrid'
import type {
  MultiviewPaneMediaRef,
  MultiviewPaneRecord
} from '../../../shared/multiviewLayouts'

const focused = () => <div id="focused-cell" />
const viewer = (chatId: string) => <div className="viewer-cell">{chatId}</div>
const empty = (i: number) => <div className="empty-cell" data-empty-index={i} />

/** Build pane records (stable ids `p0`, `p1`, …) from a chatId-per-cell list. */
const makePanes = (chatIds: (string | null)[]): MultiviewPaneRecord[] =>
  chatIds.map((chatId, i) => ({ id: `p${i}`, chatId }))

describe('MultiviewPaneGrid', () => {
  it('single layout renders the focused content with no grid wrapper (zero-diff)', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="single"
        panes={makePanes(['a'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).toBe('<div id="focused-cell"></div>')
    expect(out).not.toContain('multiview-grid')
  })

  it('renders no shared ambient backdrop — FX are now per-pane (single layout)', () => {
    // The shared backdrop was removed: each pane paints its OWN sky/ghost/living
    // INLINE (focused cell via App, viewer cells via ChatViewPane), so the grid
    // never mounts a `.multiview-ambient-backdrop` and the single layout is a
    // byte-identical fragment passthrough.
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="single"
        panes={makePanes(['a'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).toBe('<div id="focused-cell"></div>')
    expect(out).not.toContain('multiview-ambient-backdrop')
  })

  it('renders a canvas cell for a pane with a canvasId (not the chat viewer)', () => {
    const canvas = vi.fn((canvasId: string) => <div className="canvas-cell">{canvasId}</div>)
    const viewerFn = vi.fn(viewer)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={[
          { id: 'p0', chatId: 'a' },
          { id: 'p1', chatId: null, canvasId: 'cv1' }
        ]}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewerFn}
        renderCanvasCell={canvas}
      />
    )
    expect(out).toContain('canvas-cell')
    expect(out).toContain('cv1')
    expect(canvas).toHaveBeenCalledWith('cv1', 1)
    expect(viewerFn).not.toHaveBeenCalled() // canvas pane does not fall through to chat
  })

  it('renders a media cell for a pane with a mediaRef (not the chat viewer)', () => {
    const m: MultiviewPaneMediaRef = { id: 'm1', kind: 'video', name: 'clip.mp4' }
    const media = vi.fn((mediaRef: MultiviewPaneMediaRef) => (
      <div className="media-cell">{mediaRef.name}</div>
    ))
    const viewerFn = vi.fn(viewer)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={[
          { id: 'p0', chatId: 'a' },
          { id: 'p1', chatId: null, mediaRef: m }
        ]}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewerFn}
        renderMediaCell={media}
      />
    )
    expect(out).toContain('media-cell')
    expect(out).toContain('clip.mp4')
    expect(media).toHaveBeenCalledWith(m, 1)
    expect(viewerFn).not.toHaveBeenCalled() // media pane does not fall through to chat
  })

  it('media takes precedence over canvas when both renderers are supplied', () => {
    // Defense-in-depth: even if a record somehow carried both, the media branch
    // (checked first) wins and the canvas renderer is never invoked.
    const m: MultiviewPaneMediaRef = { id: 'm1', kind: 'audio', name: 'voice.wav' }
    const media = vi.fn(() => <div className="media-cell" />)
    const canvas = vi.fn(() => <div className="canvas-cell" />)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={[
          { id: 'p0', chatId: 'a' },
          { id: 'p1', chatId: null, canvasId: 'cv1', mediaRef: m }
        ]}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        renderCanvasCell={canvas}
        renderMediaCell={media}
      />
    )
    expect(out).toContain('media-cell')
    expect(media).toHaveBeenCalledWith(m, 1)
    expect(canvas).not.toHaveBeenCalled()
  })

  it('renders no shared ambient backdrop in a split layout (per-pane inline FX)', () => {
    // The focused cell is the FIRST grid child (no backdrop layer precedes it),
    // and no `.multiview-ambient-backdrop` is emitted anywhere.
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="quad"
        panes={makePanes(['a', 'b', 'c', 'd'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).not.toContain('multiview-ambient-backdrop')
    // The first grid child is a cell (the focused one), not a backdrop wrapper.
    expect(out).toMatch(/multiview-grid[^>]*><div class="multiview-cell/)
  })

  it('multiview lays out a grid with the focused cell + viewer cells by area', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).toContain('multiview-grid')
    expect(out).toContain('multiview-layout-vertical-2')
    expect(out).toContain('multiview-cell-focused')
    expect(out).toContain('id="focused-cell"')
    expect(out).toContain('>b</div>') // viewer cell rendered chat 'b'
    expect(out).toContain('grid-area:a') // focused pane in cell area 'a'
    expect(out).toContain('grid-area:b') // viewer pane in cell area 'b'
  })

  it('keeps the focused chat on the pane-owned renderer when the host opts in', () => {
    const focusedChat = vi.fn((chatId: string) => (
      <div className="focused-pane-runtime">{chatId}</div>
    ))
    const focusedHost = vi.fn(focused)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={1}
        renderFocusedCell={focusedHost}
        renderFocusedChatCell={focusedChat}
        renderViewerCell={viewer}
      />
    )

    expect(out).toContain('focused-pane-runtime')
    expect(out).toContain('multiview-pane-runtime-stack is-focused')
    expect((out.match(/multiview-pane-runtime-stack/g) || []).length).toBe(2)
    expect(out).toContain('>b</div>')
    expect(focusedChat).toHaveBeenCalledWith('b', 1)
    expect(focusedHost).not.toHaveBeenCalled()
    expect(out).toContain('>a</div>')
  })

  it('keeps the pane runtime mounted under a legacy focused takeover', () => {
    const focusedChat = vi.fn((chatId: string) => (
      <div className="focused-pane-runtime">{chatId}</div>
    ))
    const focusedHost = vi.fn(focused)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={0}
        renderFocusedCell={focusedHost}
        renderFocusedChatCell={focusedChat}
        showFocusedHostOverlay
        renderViewerCell={viewer}
      />
    )

    expect(focusedChat).toHaveBeenCalledWith('a', 0)
    expect(focusedHost).toHaveBeenCalledOnce()
    expect(out).toContain('multiview-pane-runtime is-suspended')
    expect(out).toContain('aria-hidden="true"')
    expect(out).toContain('id="focused-cell"')
  })

  it('tags each cell with its stable pane id (data-pane-id) in cell order', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={[
          { id: 'pane-7', chatId: 'a' },
          { id: 'pane-3', chatId: 'b' }
        ]}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    // The grid surfaces the pane records' stable ids for styling/diagnostics,
    // independent of the (still index-based) data-pane-index.
    expect(out).toContain('data-pane-id="pane-7"')
    expect(out).toContain('data-pane-id="pane-3"')
  })

  it('renders the focused cell in whichever area the focused index maps to', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={1}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    // Focused content sits in cell area 'b'; the viewer for 'a' in area 'a'.
    expect(out).toMatch(/grid-area:b[^>]*><div id="focused-cell">/)
  })

  it('renders the empty placeholder for null pane cells', () => {
    const renderEmpty = vi.fn(empty)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', null])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        renderEmptyCell={renderEmpty}
      />
    )
    expect(out).toContain('empty-cell')
    expect(renderEmpty).toHaveBeenCalledWith(1)
  })

  it('keeps a focused empty pane on its placeholder instead of mounting the singleton host', () => {
    const renderEmpty = vi.fn(empty)
    const focusedHost = vi.fn(focused)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', null])}
        focusedPaneIndex={1}
        renderFocusedCell={focusedHost}
        renderFocusedChatCell={viewer}
        renderViewerCell={viewer}
        renderEmptyCell={renderEmpty}
      />
    )
    expect(out).toContain('empty-cell')
    expect(out).not.toContain('focused-cell')
    expect(renderEmpty).toHaveBeenCalledWith(1)
    expect(focusedHost).not.toHaveBeenCalled()
  })

  it('quad layout renders four cells', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="quad"
        panes={makePanes(['a', 'b', 'c', 'd'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect((out.match(/data-pane-index=/g) || []).length).toBe(4)
    for (const area of ['a', 'b', 'c', 'd']) {
      expect(out).toContain(`grid-area:${area}`)
    }
  })

  it('renders a close button on non-focused cells only when onClosePane is given', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        onClosePane={vi.fn()}
      />
    )
    // Only the non-focused cell (index 1) gets a close button; focused has none.
    expect((out.match(/multiview-pane-close/g) || []).length).toBe(1)
  })

  it('omits close buttons when onClosePane is not provided', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).not.toContain('multiview-pane-close')
  })

  it('un-dragged split layout renders byte-identical to today (no fraction override)', () => {
    // Without columnFractions/rowFractions the grid must apply the spec strings
    // verbatim, so existing renders are unchanged.
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="quad"
        panes={makePanes(['a', 'b', 'c', 'd'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).toContain('grid-template-columns:1fr 1fr')
    expect(out).toContain('grid-template-rows:1fr 1fr')
    // No gutters without an onResizeTrack handler.
    expect(out).not.toContain('multiview-gutter')
  })

  it('applies stateful track fractions over the spec when provided', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        columnFractions={[1.2, 0.8]}
        rowFractions={[1]}
      />
    )
    expect(out).toContain('grid-template-columns:1.2fr 0.8fr')
  })

  it('renders draggable gutters for a split layout when resizable', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        panes={makePanes(['a', 'b'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        columnFractions={[1, 1]}
        rowFractions={[1]}
        onResizeTrack={() => {}}
        onResetTracks={() => {}}
      />
    )
    // vertical-2 has exactly one internal column boundary -> one column gutter.
    expect((out.match(/multiview-gutter /g) || []).length).toBe(1)
    expect(out).toContain('multiview-gutter-column')
    expect(out).toContain('role="separator"')
    expect(out).toContain('tabindex="0"')
    expect(out).toContain('aria-orientation="vertical"')
    expect(out).toContain('aria-label="Resize panes"')
    expect(out).not.toContain('aria-valuenow=')
    expect(out).toContain('Drag or use arrow keys to resize panes')
    expect(out).toContain('grid-column:2')
  })

  it('renders no gutters in the single layout (fragment passthrough)', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="single"
        panes={makePanes(['a'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        columnFractions={[1]}
        rowFractions={[1]}
        onResizeTrack={() => {}}
        onResetTracks={() => {}}
      />
    )
    expect(out).toBe('<div id="focused-cell"></div>')
    expect(out).not.toContain('multiview-gutter')
  })

  it('renders no gutters when onResizeTrack is absent (non-resizable grid)', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="quad"
        panes={makePanes(['a', 'b', 'c', 'd'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        columnFractions={[1, 1]}
        rowFractions={[1, 1]}
      />
    )
    expect(out).not.toContain('multiview-gutter')
  })

  it('renders area-aware partial gutters for the 1-left-2-right layout', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="one-left-two-right"
        panes={makePanes(['a', 'b', 'c'])}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        columnFractions={[1, 1]}
        rowFractions={[1, 1]}
        onResizeTrack={() => {}}
      />
    )
    // Full-height column gutter + a row gutter confined to the right column.
    expect((out.match(/multiview-gutter-column/g) || []).length).toBe(1)
    expect((out.match(/multiview-gutter-row/g) || []).length).toBe(1)
    // The column gutter spans both rows; the row gutter only the right column.
    // (Component sets gridColumn before gridRow, so that's the serialised order.)
    expect(out).toMatch(/grid-column:2;grid-row:1 \/ 3/)
    expect(out).toMatch(/grid-column:2 \/ 3;grid-row:2/)
  })
})
