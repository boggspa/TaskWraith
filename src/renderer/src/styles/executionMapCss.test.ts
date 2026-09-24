import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/23-execution-map.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const mainCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

describe('Execution Map CSS contract', () => {
  it('loads the Execution Map stylesheet from the renderer entrypoint exactly once', () => {
    const imports = mainCss().match(/@import url\('\.\/css\/23-execution-map\.css'\);/g) ?? []

    expect(imports).toHaveLength(1)
  })

  it('lays out stages top-to-bottom with wrapping step grids, never a sideways scroll', () => {
    const source = css()

    expect(source).toContain('.execution-map-stages {')
    expect(source).toContain('grid-auto-flow: row')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('repeat(auto-fill, minmax(300px, 1fr))')
    expect(source).not.toContain('grid-auto-flow: column')
    expect(source).not.toContain('scroll-snap-type: x')
    expect(source).not.toContain('cursor: grab')
    expect(source).not.toContain('touch-action: none')
  })

  it('gives step cards the orchestration-card chassis anatomy', () => {
    const source = css()

    expect(source).toContain('.execution-map-node-glyph {')
    expect(source).toContain('.execution-map-node-meter {')
    expect(source).toContain('.execution-map-stage-header {')
    expect(source).toContain(
      '.execution-map-node {\n  position: relative;\n  display: grid;\n  gap: 10px;'
    )
  })

  it('collapses the inspector split and step grid to one column below 900px', () => {
    const source = css()
    const breakpoint = source.indexOf('@media (max-width: 900px) {')
    const reducedMotion = source.indexOf('@media (prefers-reduced-motion: reduce) {')
    const mobile = source.slice(breakpoint, reducedMotion)

    expect(breakpoint).toBeGreaterThan(-1)
    expect(mobile).toContain('.execution-map-body {\n    grid-template-columns: minmax(0, 1fr)')
    expect(mobile).toContain(
      '.execution-map-stage-steps {\n    grid-template-columns: minmax(0, 1fr)'
    )
  })

  /* The original stylesheet referenced tokens that do not exist anywhere in
   * theme.css, so every theme silently rendered the hard-coded dark fallbacks.
   * Chrome must come from the shared surface scale — and the pane itself must
   * paint the content slab chain, because --app-bg alone goes transparent
   * under native glass and rendered the whole Map see-through. */
  it('draws chrome from the shared theme scale instead of phantom tokens', () => {
    const source = css()

    expect(source).not.toContain('var(--surface-raised')
    expect(source).not.toContain('var(--border-subtle')
    expect(source).not.toContain('var(--background-primary')
    expect(source).toContain('var(--surface-2)')
    expect(source).toContain('var(--panel-border)')
    expect(source).toContain(
      'background: var(--main-pane-opacity-override-bg, var(--content-bg, var(--app-bg)));'
    )
    expect(source).toContain('font-family: var(--transcript-font-family, var(--font-sans));')
  })

  it('styles the run actions as app buttons — accent resume, quiet-danger cancel', () => {
    const source = css()

    expect(source).toContain('.execution-map-resume-run,\n.execution-map-cancel-run {')
    expect(source).toMatch(
      /\.execution-map-resume-run \{\n {2}border: 1px solid color-mix\(in srgb, var\(--accent\)/
    )
    expect(source).toMatch(
      /\.execution-map-cancel-run \{\n {2}border: 1px solid color-mix\(in srgb, var\(--danger\)/
    )
    expect(source).toContain('.execution-map-resume-run:focus-visible')
    expect(source).toContain('.execution-map-cancel-run:focus-visible')
  })

  it('keeps status, keyboard focus, and reduced-motion states visible', () => {
    const source = css()

    expect(source).toContain('.execution-status-token.tone-active')
    expect(source).toContain('.execution-status-token.tone-attention')
    expect(source).toContain('.execution-status-token.tone-failure')
    expect(source).toContain('.execution-map-node:focus-visible {')
    expect(source).toContain('outline: 2px solid var(--accent, #7c9cff)')
    expect(source).toContain('@media (prefers-reduced-motion: reduce) {')
    expect(source).toContain('.execution-map-node:hover {\n    transform: none;')
  })
})
