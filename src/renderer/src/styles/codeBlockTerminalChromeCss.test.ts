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
    expect(basePane).toContain('bottom: var(--workspace-terminal-bottom-gap)')
    expect(basePane).toContain('height: var(--workspace-terminal-height)')
    expect(paneChrome).not.toMatch(/\bposition\s*:/)
    expect(paneRim).toContain('content: none')
    expect(paneRim).toContain('display: none')
    expect(terminalCss).not.toContain('terminal-pane-rim-chase')
    expect(terminalCss).not.toContain('conic-gradient')
  })

  it('keeps the workspace terminal and its drag divider on one inset token', () => {
    const transcriptCss = readCss('02-transcript-messages-fx.css')
    const basePane = cssBlockStartingAt(transcriptCss, '.workspace-terminal-split {')
    const divider = cssBlockStartingAt(transcriptCss, '.workspace-terminal-resize-divider {')

    const inset = 'var(--workspace-terminal-inline-inset, calc(var(--space-lg) * 2))'
    for (const block of [basePane, divider]) {
      expect(block).toContain(`left: ${inset}`)
      expect(block).toContain(`right: ${inset}`)
      expect(block).toContain('max-width: var(--composer-content-max-width, none)')
      expect(block).toMatch(/margin(-inline)?: (0 )?auto;/)
      expect(block).not.toMatch(/(left|right):\s*calc\(var\(--space-lg\) \* 2\)/)
    }

    expect(transcriptCss).toContain('--workspace-terminal-inline-inset: var(--space-lg);')
    expect(transcriptCss).toContain('--workspace-terminal-inline-inset: var(--space-md);')
  })
})
