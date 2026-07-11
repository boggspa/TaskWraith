import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

const readCss = (file: string): string => readRepoFile(join('src/renderer/src/assets/css', file))

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('pane divider chrome', () => {
  it('derives opaque metallic rim colors from the solid surface scale', () => {
    const theme = readRepoFile('src/renderer/src/styles/theme.css')

    expect(theme).toContain('--pane-divider-metal-base: var(--surface-2);')
    expect(theme).toContain('--pane-divider-metal-highlight: color-mix(in srgb, var(--surface-2)')
    expect(theme).toContain('--pane-divider-metal-shadow: color-mix(in srgb, var(--surface-2)')
    expect(theme).toContain('--pane-divider-metal-active: color-mix(in srgb, var(--surface-2)')
  })

  it.each([
    ['01-sidebar.css', '.workspace-sidebar-resize-handle {'],
    ['02-transcript-messages-fx.css', '.panel-resize-handle {']
  ])('overlaps the wide %s hit target so it leaves no glass gap', (file, selector) => {
    const block = cssBlockStartingAt(readCss(file), selector)

    expect(block).toContain('width: 8px;')
    expect(block).toContain('flex: 0 0 8px;')
    expect(block).toContain('margin-inline: -4px;')
  })

  it('keeps native glass from replacing the metallic seam with a translucent line', () => {
    const nativeGlass = readCss('06-component-panels-modals.css')

    expect(nativeGlass).not.toContain(
      '[data-appearance="native_glass"][data-reduce-transparency="false"] .workspace-sidebar-resize-handle::before'
    )
    expect(nativeGlass).not.toContain(
      '[data-appearance="native_glass"][data-reduce-transparency="false"] .panel-resize-handle::before'
    )
  })

  it('removes overlap while a pane handle collapses', () => {
    const block = cssBlockStartingAt(
      readCss('13-panel-transitions.css'),
      '.workspace-sidebar-resize-handle.tw-panel-collapsed,'
    )

    expect(block).toContain('width: 0;')
    expect(block).toContain('flex-basis: 0;')
    expect(block).toContain('margin-inline: 0;')
  })

  it('collapses Multiview tracks to a hairline while retaining a wide overlaid gutter', () => {
    const css = readCss('14-multiview.css')
    const grid = cssBlockStartingAt(css, '.multiview-grid {')
    const columnGutter = cssBlockStartingAt(css, '.multiview-gutter-column {')
    const columnRim = cssBlockStartingAt(css, '.multiview-gutter-column .multiview-gutter-handle {')
    const rowRim = cssBlockStartingAt(css, '.multiview-gutter-row .multiview-gutter-handle {')

    expect(grid).toContain('gap: 1px;')
    expect(columnGutter).toContain('width: 9px;')
    expect(columnGutter).toContain('margin-left: -5px;')
    expect(columnRim).toContain('width: 1px;')
    expect(columnRim).toContain('height: 100%;')
    expect(rowRim).toContain('width: 100%;')
    expect(rowRim).toContain('height: 1px;')
  })

  it('collapses the Workbench split track while retaining a wide overlaid target', () => {
    const css = readCss('03-composer-welcome-activity.css')
    const stage = cssBlockStartingAt(css, '.workbench-stage.split {')
    const resizer = cssBlockStartingAt(css, '.workbench-split-resizer {')
    const rim = cssBlockStartingAt(css, '.workbench-split-resizer > span {')

    expect(stage).toContain('1px')
    expect(stage).not.toContain('10px')
    expect(resizer).toContain('width: 9px;')
    expect(resizer).toContain('justify-self: center;')
    expect(resizer).toContain('background: transparent;')
    expect(rim).toContain('width: 1px;')
    expect(rim).toContain('height: 100%;')
    expect(rim).toContain('var(--pane-divider-metal-base)')
  })
})
