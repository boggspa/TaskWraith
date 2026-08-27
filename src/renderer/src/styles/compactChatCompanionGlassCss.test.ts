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

describe('Compact Companion glass material', () => {
  it('overrides the pane appearance with the canonical picker material', () => {
    const block = blockStartingAt(
      ':root:has(.chat-compact-companion-window) .chat-compact-companion-window .app-transcript,'
    )

    expect(block).toContain('background: var(--tw-popover-glass-bg) !important')
    expect(block).toContain('box-shadow: var(--tw-popover-material-shadow) !important')
    expect(block).toContain('backdrop-filter: var(--tw-popover-material-backdrop) !important')
  })

  it('retains the established solid accessibility fallback', () => {
    const block = blockStartingAt(
      ":root[data-reduce-transparency='true']:has(.chat-compact-companion-window)"
    )

    expect(block).toContain('background: var(--tw-glass-solid) !important')
    expect(block).toContain('backdrop-filter: none !important')
  })
})
