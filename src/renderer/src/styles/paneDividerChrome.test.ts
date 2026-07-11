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
})
