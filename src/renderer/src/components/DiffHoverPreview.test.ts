import { describe, expect, it } from 'vitest'
import {
  canShowDiffHoverPreview,
  diffHoverPreviewRole,
  diffHoverPreviewSourceLabel,
  getDiffHoverPreviewLayout,
  prepareDiffHoverPreviewText
} from './DiffHoverPreview'

const rect = (
  input: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top' | 'width'>
): Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top' | 'width'> => input

describe('DiffHoverPreview layout', () => {
  it('uses a composer-width bubble centered inside a wide transcript boundary', () => {
    const layout = getDiffHoverPreviewLayout({
      anchor: rect({ bottom: 532, left: 820, right: 900, top: 500, width: 80 }),
      boundary: rect({ bottom: 720, left: 40, right: 1240, top: 80, width: 1200 }),
      viewportHeight: 800,
      viewportWidth: 1280
    })

    expect(layout.width).toBe(1040)
    expect(layout.left).toBe(120)
    expect(layout.maxHeight).toBe(360)
    expect(layout.top).toBe(130)
  })

  it('positions short measured previews directly above the hovered row', () => {
    const layout = getDiffHoverPreviewLayout({
      anchor: rect({ bottom: 780, left: 820, right: 900, top: 748, width: 80 }),
      boundary: rect({ bottom: 820, left: 48, right: 964, top: 60, width: 916 }),
      previewHeight: 112,
      viewportHeight: 900,
      viewportWidth: 1024
    })

    expect(layout.maxHeight).toBe(360)
    expect(layout.top).toBe(626)
  })

  it('clamps to narrow viewports without overflowing the boundary', () => {
    const layout = getDiffHoverPreviewLayout({
      anchor: rect({ bottom: 126, left: 120, right: 280, top: 94, width: 160 }),
      boundary: rect({ bottom: 520, left: 20, right: 400, top: 20, width: 380 }),
      viewportHeight: 560,
      viewportWidth: 420
    })

    expect(layout.width).toBe(380)
    expect(layout.left).toBe(20)
    expect(layout.top).toBe(136)
  })
})

describe('DiffHoverPreview text bounds', () => {
  it('caps raw diff text by line count before parsing', () => {
    const diffText = Array.from({ length: 260 }, (_, index) => `+line ${index}`).join('\n')
    const prepared = prepareDiffHoverPreviewText(diffText)

    expect(prepared.capped).toBe(true)
    expect(prepared.text).toContain('+line 239')
    expect(prepared.text).not.toContain('+line 250')
  })

  it('caps raw diff text by character count', () => {
    const prepared = prepareDiffHoverPreviewText('x'.repeat(40_100))

    expect(prepared.capped).toBe(true)
    expect(prepared.text).toHaveLength(40_000)
  })
})

describe('DiffHoverPreview source labels', () => {
  it('labels Task Complete and tool-call hover contexts distinctly', () => {
    expect(diffHoverPreviewSourceLabel('run-summary')).toBe('Task complete')
    expect(diffHoverPreviewSourceLabel('tool-call')).toBe('Tool edit')
    expect(diffHoverPreviewSourceLabel()).toBe('Diff preview')
  })
})

describe('DiffHoverPreview semantics', () => {
  it('uses dialog semantics only when the preview contains an action', () => {
    expect(diffHoverPreviewRole(true)).toBe('dialog')
    expect(diffHoverPreviewRole(false)).toBe('tooltip')
  })

  it('can show action-only previews for stats-only Workbench rows', () => {
    expect(canShowDiffHoverPreview({ diffText: undefined }, false)).toBe(false)
    expect(canShowDiffHoverPreview({ diffText: '' }, true)).toBe(true)
    expect(canShowDiffHoverPreview({ diffText: '@@ -1 +1 @@\n-old\n+new' }, false)).toBe(true)
  })
})
