import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
const diffStudioCodeCss = readFileSync(
  new URL('../assets/css/45-diff-studio-code.css', import.meta.url),
  'utf8'
)

describe('Diff Studio Codex-like source presentation', () => {
  it('loads after the shared Diff Studio shards and keeps editor syntax colours', () => {
    expect(mainCss).toContain("@import url('./css/45-diff-studio-code.css');")
    expect(diffStudioCodeCss).toContain('.diff-line-marker')
    expect(diffStudioCodeCss).toContain('--diff-gutter-width')
    expect(diffStudioCodeCss).toContain('font-family: var(--font-mono)')
    expect(diffStudioCodeCss).toContain('font-size: 13px')
    expect(diffStudioCodeCss).toContain('color: inherit')
    expect(diffStudioCodeCss).toContain('var(--diff-add-bar)')
    expect(diffStudioCodeCss).toContain('var(--diff-del-bar)')
    expect(diffStudioCodeCss).toContain("data-popout-family='workspace'")
    expect(diffStudioCodeCss).not.toContain('color: var(--diff-add-text)')
    expect(diffStudioCodeCss).not.toContain('color: var(--diff-del-text)')
  })
})
