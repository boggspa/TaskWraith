import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('code-block and terminal chrome CSS', () => {
  it('keeps assistant code blocks free of animated accent rims', () => {
    const css = readCss('05-polish-fx-layouts.css')

    expect(css).not.toContain('.message-bubble.assistant .message-code-shell::after')
    expect(css).not.toContain('code-shell-rim-chase')
  })

  it('keeps the workspace terminal docked and free of animated rims', () => {
    const transcriptCss = readCss('02-transcript-messages-fx.css')
    const terminalCss = readCss('30-workspace-terminal-tui.css')
    const basePane = cssBlockStartingAt(transcriptCss, '.workspace-terminal-split {')
    const paneChrome = cssBlockStartingAt(
      terminalCss,
      '.workspace-terminal-split.terminal-panel--pane {'
    )
    const paneRim = cssBlockStartingAt(
      terminalCss,
      '.workspace-terminal-split.terminal-panel--pane::after {'
    )

    expect(basePane).toContain('position: absolute')
    expect(basePane).toContain('left: calc(var(--space-lg) * 2)')
    expect(basePane).toContain('right: calc(var(--space-lg) * 2)')
    expect(basePane).toContain('bottom: var(--workspace-terminal-bottom-gap)')
    expect(basePane).toContain('height: var(--workspace-terminal-height)')
    expect(paneChrome).not.toMatch(/\bposition\s*:/)
    expect(paneRim).toContain('content: none')
    expect(paneRim).toContain('display: none')
    expect(terminalCss).not.toContain('terminal-pane-rim-chase')
    expect(terminalCss).not.toContain('conic-gradient')
  })
})
