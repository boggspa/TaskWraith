import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MultiviewPaneGrid } from './MultiviewPaneGrid'

const focused = () => <div id="focused-cell" />
const viewer = (chatId: string) => <div className="viewer-cell">{chatId}</div>
const empty = (i: number) => <div className="empty-cell" data-empty-index={i} />

describe('MultiviewPaneGrid', () => {
  it('single layout renders the focused content with no grid wrapper (zero-diff)', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="single"
        paneChatIds={['a']}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).toBe('<div id="focused-cell"></div>')
    expect(out).not.toContain('multiview-grid')
  })

  it('multiview lays out a grid with pane-scoped chat cells by area', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        paneChatIds={['a', 'b']}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).toContain('multiview-grid')
    expect(out).toContain('multiview-layout-vertical-2')
    expect(out).toContain('multiview-cell-focused')
    expect(out).not.toContain('id="focused-cell"')
    expect(out).toContain('>a</div>') // viewer cell rendered chat 'a'
    expect(out).toContain('>b</div>') // viewer cell rendered chat 'b'
    expect(out).toContain('grid-area:a') // focused pane in cell area 'a'
    expect(out).toContain('grid-area:b') // viewer pane in cell area 'b'
  })

  it('marks the focused area without switching to the legacy focused renderer', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        paneChatIds={['a', 'b']}
        focusedPaneIndex={1}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    // Focused pane 'b' is still rendered through the same pane-scoped viewer.
    expect(out).toMatch(/multiview-cell-focused[^>]*style="grid-area:b"[^>]*><div class="viewer-cell">b<\/div>/)
    expect(out).not.toContain('id="focused-cell"')
  })

  it('renders the empty placeholder for null pane cells', () => {
    const renderEmpty = vi.fn(empty)
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="vertical-2"
        paneChatIds={['a', null]}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
        renderEmptyCell={renderEmpty}
      />
    )
    expect(out).toContain('empty-cell')
    expect(renderEmpty).toHaveBeenCalledWith(1)
  })

  it('quad layout renders four cells', () => {
    const out = renderToStaticMarkup(
      <MultiviewPaneGrid
        layout="quad"
        paneChatIds={['a', 'b', 'c', 'd']}
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
        paneChatIds={['a', 'b']}
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
        paneChatIds={['a', 'b']}
        focusedPaneIndex={0}
        renderFocusedCell={focused}
        renderViewerCell={viewer}
      />
    )
    expect(out).not.toContain('multiview-pane-close')
  })
})
