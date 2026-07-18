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

  it('lays out semantic stages without a coordinate canvas contract', () => {
    const source = css()

    expect(source).toContain('.execution-map-stages {')
    expect(source).toContain('grid-auto-flow: column')
    expect(source).toContain('grid-auto-columns: minmax(220px, 1fr)')
    expect(source).not.toContain('cursor: grab')
    expect(source).not.toContain('touch-action: none')
  })

  it('collapses topological stages to one ordered column below 900px', () => {
    const source = css()
    const breakpoint = source.indexOf('@media (max-width: 900px) {')
    const reducedMotion = source.indexOf('@media (prefers-reduced-motion: reduce) {')
    const mobile = source.slice(breakpoint, reducedMotion)

    expect(breakpoint).toBeGreaterThan(-1)
    expect(mobile).toContain('.execution-map-body {\n    grid-template-columns: minmax(0, 1fr)')
    expect(mobile).toContain('.execution-map-stages {')
    expect(mobile).toContain('grid-auto-flow: row')
    expect(mobile).toContain('scroll-snap-type: none')
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
