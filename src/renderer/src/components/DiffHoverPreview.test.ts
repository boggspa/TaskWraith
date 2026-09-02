import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { diffLineDisplayText } from '../lib/unifiedDiffParser'
import {
  canShowDiffHoverPreview,
  diffHoverPreviewEmptyMessage,
  diffHoverPreviewRole,
  diffHoverPreviewSourceLabel,
  DiffHoverPreviewLine,
  DIFF_HOVER_PREVIEW_FILE_INITIAL_LIMIT,
  DIFF_HOVER_PREVIEW_FILE_MAX_VISIBLE,
  getDiffHoverPreviewFileWindow,
  getDiffHoverPreviewLayout,
  getDiffHoverPreviewStats,
  prepareDiffHoverPreviewText
} from './DiffHoverPreview'
import { editorHighlightStyleRules, highlightCodeToLineSpans } from './highlightCodeLines'

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

describe('DiffHoverPreview file-list bounds', () => {
  const files = Array.from({ length: 42 }, (_, index) => ({
    path: `src/file-${index + 1}.ts`,
    additions: index + 1,
    deletions: index
  }))

  it('shows eight commit files first and offers one bounded expansion', () => {
    const window = getDiffHoverPreviewFileWindow(files)

    expect(window.files).toHaveLength(DIFF_HOVER_PREVIEW_FILE_INITIAL_LIMIT)
    expect(window.canShowMore).toBe(true)
    expect(window.nextShowCount).toBe(22)
    expect(window.hiddenAfterCap).toBe(12)
  })

  it('never mounts more than thirty commit files after expansion', () => {
    const window = getDiffHoverPreviewFileWindow(files.slice(0, 30), true, files.length)

    expect(window.files).toHaveLength(DIFF_HOVER_PREVIEW_FILE_MAX_VISIBLE)
    expect(window.files.at(-1)?.path).toBe('src/file-30.ts')
    expect(window.canShowMore).toBe(false)
    expect(window.hiddenAfterCap).toBe(12)
  })
})

describe('DiffHoverPreview source labels', () => {
  it('labels Task Complete and tool-call hover contexts distinctly', () => {
    expect(diffHoverPreviewSourceLabel('commit-reference')).toBe('Commit')
    expect(diffHoverPreviewSourceLabel('run-summary')).toBe('Task complete')
    expect(diffHoverPreviewSourceLabel('tool-call')).toBe('Tool edit')
    expect(diffHoverPreviewSourceLabel()).toBe('Diff preview')
  })
})

describe('DiffHoverPreview semantics', () => {
  it('uses a caller-provided empty-state message for async commit previews', () => {
    expect(
      diffHoverPreviewEmptyMessage({ emptyMessage: 'Loading files changed by this commit…' }, false)
    ).toBe('Loading files changed by this commit…')
    expect(diffHoverPreviewEmptyMessage({}, false)).toBe('No inline diff captured.')
  })

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

describe('DiffHoverPreview stats', () => {
  it('formats additions and deletions as separate satellites', () => {
    expect(getDiffHoverPreviewStats({ additions: 3, deletions: 2 })).toEqual([
      { kind: 'add', label: '+3', ariaLabel: '3 additions' },
      { kind: 'delete', label: '-2', ariaLabel: '2 deletions' }
    ])
  })

  it('does not invent an exact zero for unknown stat sides', () => {
    expect(getDiffHoverPreviewStats({ additions: undefined, deletions: 4 })).toEqual([
      { kind: 'delete', label: '-4', ariaLabel: '4 deletions' }
    ])
    expect(getDiffHoverPreviewStats({ additions: 0, deletions: undefined })).toEqual([
      { kind: 'add', label: '+0', ariaLabel: '0 additions' }
    ])
  })
})

describe('DiffHoverPreview editor-style presentation', () => {
  it('hides the leading diff marker and syntax-highlights the source', () => {
    const rules = editorHighlightStyleRules()
    const keywordClass = rules.match(/\.([\wͰ-Ͽ]+)\s*\{[^}]*color:\s*var\(--cm-keyword\)/)?.[1]
    expect(keywordClass).toBeTruthy()

    const line = { kind: 'add' as const, oldLine: null, newLine: 3, text: '+const added = "ok"' }
    const spans = highlightCodeToLineSpans(diffLineDisplayText(line), 'typescript')[0]
    const html = renderToStaticMarkup(createElement(DiffHoverPreviewLine, { line, spans }))

    expect(html).not.toContain('+const added')
    expect(html.replace(/<[^>]+>/g, '')).toContain('const added')
    expect(html).toContain(`class="${keywordClass}">const</span>`)
  })
})
