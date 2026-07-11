import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSideChatCss = (): string =>
  readFileSync(new URL('../assets/css/11-side-chat.css', import.meta.url), 'utf8')

const readApp = (): string => readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('main-pane action popover CSS', () => {
  it('keeps top-right positioning separate from legacy menu chrome', () => {
    const css = readSideChatCss()
    const layout = cssBlockStartingAt(css, '.side-chat-layout-menu {')
    const legacyChrome = cssBlockStartingAt(
      css,
      '.side-chat-layout-menu:not(.composer-combined-picker-popover) {'
    )

    expect(layout).toContain('position: absolute')
    expect(layout).not.toContain('background:')
    expect(layout).not.toContain('box-shadow:')
    expect(legacyChrome).toContain('background:')
    expect(legacyChrome).toContain('box-shadow:')
  })

  it('does not override shared glass fallbacks for the migrated menus', () => {
    const css = readSideChatCss()

    expect(css).toContain(
      '.side-chat-layout-menu.chat-corner-picker-menu:not(.composer-combined-picker-popover)'
    )
  })

  it('routes the Run preview-target menu through the shared glass chrome', () => {
    const app = readApp()

    expect(app).toContain(
      'className="side-chat-layout-menu composer-combined-picker-popover pane-preview-menu"'
    )
  })
})
