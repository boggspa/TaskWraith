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
