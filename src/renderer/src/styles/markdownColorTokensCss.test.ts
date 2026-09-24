import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
const colorTokensCss = readFileSync(
  new URL('../assets/css/40-markdown-color-tokens.css', import.meta.url),
  'utf8'
)

describe('Markdown color-token styling', () => {
  it('loads the scoped stylesheet and previews alpha colours over a checkerboard', () => {
    expect(mainCss).toContain("@import url('./css/40-markdown-color-tokens.css');")
    expect(colorTokensCss).toContain('.message-markdown-pro .markdown-color-token')
    expect(colorTokensCss).toContain('var(--markdown-color-token)')
    expect(colorTokensCss).toContain('conic-gradient(')
    expect(colorTokensCss).toContain('user-select: none')
    expect(colorTokensCss).toContain('forced-color-adjust: none')
  })
})
