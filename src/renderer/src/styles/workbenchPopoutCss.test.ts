import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readWorkbenchCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/03-composer-welcome-activity.css'),
    'utf8'
  )

const cssBlockStartingAt = (source: string, selector: string, fromIndex = 0): string => {
  const start = source.indexOf(selector, fromIndex)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + 2)
}

describe('Workbench popout CSS', () => {
  it('uses solid workspace popout chrome instead of transparent glass roots', () => {
    const css = readWorkbenchCss()

    expect(
      cssBlockStartingAt(css, '.popout-root[data-popout-family="workspace"] {')
    ).toContain('background: var(--app-bg)')
    expect(
      cssBlockStartingAt(css, '.popout-root[data-popout-family="workspace"] .popout-header {')
    ).toContain('background: var(--panel-bg-solid, var(--app-bg-elevated))')
    expect(
      cssBlockStartingAt(css, '.popout-root[data-popout-family="workspace"] .popout-body {')
    ).toContain('background: var(--app-bg)')
  })

  it('keeps workspace editor and diff popout bodies opaque', () => {
    const css = readWorkbenchCss()
    const editorBlock = cssBlockStartingAt(css, '.popout-body .app-file-editor {')
    const diffBlock = cssBlockStartingAt(css, '.popout-diff-studio {')
    const diffRootBlock = cssBlockStartingAt(
      css,
      '.popout-diff-studio > div {',
      css.indexOf(diffBlock) + diffBlock.length
    )

    expect(editorBlock).toContain('background: var(--panel-bg-solid, var(--panel-bg))')
    expect(editorBlock).not.toContain('background: transparent')
    expect(diffBlock).toContain('background: var(--panel-bg-solid, var(--panel-bg))')
    expect(diffBlock).not.toContain('background: transparent')
    expect(diffRootBlock).toContain('background: var(--panel-bg-solid, var(--panel-bg))')
  })

  it('drops fixed split-pane minimums at narrow popout widths', () => {
    const css = readWorkbenchCss()
    const mediaStart = css.indexOf('@media (max-width: 640px) {')
    expect(mediaStart).toBeGreaterThanOrEqual(0)
    const narrowSplitBlock = cssBlockStartingAt(
      css,
      '.workbench-stage.split {',
      mediaStart
    )

    expect(narrowSplitBlock).toContain('minmax(0, var(--workbench-editor-split, 52%))')
    expect(narrowSplitBlock).toContain('minmax(0, 1fr)')
    expect(narrowSplitBlock).not.toContain('260px')
    expect(narrowSplitBlock).not.toContain('280px')
  })

  it('tightens nested editor and diff rails for narrow split mode', () => {
    const css = readWorkbenchCss()
    const mediaStart = css.indexOf('@media (max-width: 640px) {')
    expect(mediaStart).toBeGreaterThanOrEqual(0)

    expect(
      cssBlockStartingAt(css, '.workbench-stage.split .app-file-editor {', mediaStart)
    ).toContain('minmax(110px, 42%) minmax(0, 1fr)')
    expect(
      cssBlockStartingAt(css, '.workbench-stage.split .popout-diff-studio > div {', mediaStart)
    ).toContain('minmax(110px, 42%) minmax(0, 1fr)')
  })
})
