import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
const diffStatsCss = readFileSync(
  new URL('../assets/css/36-markdown-inline-diff-stats.css', import.meta.url),
  'utf8'
)

describe('Markdown inline diff-stat colours', () => {
  it('loads after the shared theme shards and follows the live Appearance variables', () => {
    expect(mainCss).toContain("@import url('./css/36-markdown-inline-diff-stats.css');")
    expect(diffStatsCss).toContain('.message-markdown-pro .markdown-inline-diff-stat.is-addition')
    expect(diffStatsCss).toContain('color: var(--diff-stat-add-color, #2db777)')
    expect(diffStatsCss).toContain('.message-markdown-pro .markdown-inline-diff-stat.is-deletion')
    expect(diffStatsCss).toContain('color: var(--diff-stat-del-color, #ec3d35)')
  })

  it('tints check-result accents from the same live variables', () => {
    expect(diffStatsCss).toContain('.message-markdown-pro .markdown-inline-check-outcome.is-pass')
    expect(diffStatsCss).toContain('.message-markdown-pro .markdown-inline-check-outcome.is-fail')
    expect(diffStatsCss).toContain('.message-markdown-pro .markdown-inline-check-outcome.is-skip')
    expect(diffStatsCss).toContain('color: var(--warning, #f5a623)')
  })
})
