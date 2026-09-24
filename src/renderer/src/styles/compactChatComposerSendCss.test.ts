import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/renderer/src/components/CompactChatComposer.css', 'utf8')

function blockStartingAt(selector: string): string {
  const start = css.indexOf(selector)
  expect(start, `missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end + 1)
}

describe('Compact Companion send and stop glyphs', () => {
  it('pins the arrow stroke instead of trusting inherited SVG chrome', () => {
    const block = blockStartingAt('.compact-chat-attach svg,')

    expect(block).toContain('stroke: currentColor !important')
    expect(block).toContain('opacity: 1')
  })

  it('keeps an empty-composer send arrow visible inside its disabled circle', () => {
    const block = blockStartingAt('.compact-chat-send:disabled {')

    expect(block).toContain('background: color-mix(')
    expect(block).toContain('color: var(--text-primary) !important')
    expect(block).toContain('opacity: 1')
  })

  it('renders the stop square in a high-contrast foreground', () => {
    const button = blockStartingAt('.compact-chat-send.is-stop {')
    const symbol = blockStartingAt('.compact-chat-stop-symbol {')

    expect(button).toContain('color: rgb(255 255 255 / 0.96) !important')
    expect(symbol).toContain('background: currentColor !important')
  })
})
