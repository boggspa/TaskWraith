import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
const commitReferencesCss = readFileSync(
  new URL('../assets/css/38-markdown-commit-references.css', import.meta.url),
  'utf8'
)

describe('Markdown commit-reference styling', () => {
  it('loads the commit-reference stylesheet and keeps the hash visibly interactive', () => {
    expect(mainCss).toContain("@import url('./css/38-markdown-commit-references.css');")
    expect(commitReferencesCss).toContain('.markdown-commit-reference')
    expect(commitReferencesCss).toContain('cursor: help')
    expect(commitReferencesCss).toContain('font-family: var(--font-mono)')
    expect(commitReferencesCss).toContain(':focus-visible')
  })
})
