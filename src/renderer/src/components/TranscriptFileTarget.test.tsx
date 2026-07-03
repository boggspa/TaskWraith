import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TranscriptFileTarget, getFileCardLayout } from './TranscriptFileTarget'

describe('getFileCardLayout', () => {
  const viewport = { viewportWidth: 1200, viewportHeight: 800 }

  it('places the card below the anchor when there is room', () => {
    const layout = getFileCardLayout({
      anchor: { top: 100, bottom: 116, left: 200, right: 320, width: 120 },
      cardHeight: 120,
      ...viewport
    })
    expect(layout.placement).toBe('below')
    expect(layout.top).toBe(116 + 6)
    expect(layout.left).toBe(200)
  })

  it('flips the card above the anchor when it would overflow the bottom edge', () => {
    const layout = getFileCardLayout({
      anchor: { top: 760, bottom: 776, left: 200, right: 320, width: 120 },
      cardHeight: 120,
      ...viewport
    })
    expect(layout.placement).toBe('above')
    expect(layout.top).toBe(760 - 6 - 120)
  })

  it('clamps the card horizontally inside the viewport', () => {
    const layout = getFileCardLayout({
      anchor: { top: 100, bottom: 116, left: 1190, right: 1200, width: 10 },
      cardHeight: 120,
      ...viewport
    })
    // width caps at 460; left must keep it fully on-screen with a 10px margin.
    expect(layout.left).toBe(1200 - 460 - 10)
  })
})

describe('TranscriptFileTarget static render', () => {
  it('renders a link-styled button carrying the label, companion class and full-path title', () => {
    const html = renderToStaticMarkup(
      <TranscriptFileTarget
        filePath="src/foo.ts"
        label="foo.ts"
        workspacePath="/repo"
        className="activity-file-name"
      />
    )
    expect(html).toContain('class="transcript-file-target activity-file-name"')
    expect(html).toContain('>foo.ts</button>')
    // Relative path resolved against the workspace for the hover title.
    expect(html).toContain('title="/repo/src/foo.ts"')
    // The hover card is not in the initial (SSR) markup — it mounts on hover.
    expect(html).not.toContain('transcript-file-card')
  })

  it('still advertises a dialog popup by default but not when suppressed', () => {
    const withCard = renderToStaticMarkup(
      <TranscriptFileTarget filePath="/repo/foo.ts" label="foo.ts" />
    )
    expect(withCard).toContain('aria-haspopup="dialog"')

    const suppressed = renderToStaticMarkup(
      <TranscriptFileTarget filePath="/repo/foo.ts" label="foo.ts" showHoverCard={false} />
    )
    expect(suppressed).not.toContain('aria-haspopup')
  })
})
