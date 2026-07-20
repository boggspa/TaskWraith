import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/09-ensemble-work-session.css'),
    'utf8'
  )

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('Claude composer queued message CSS', () => {
  it('keeps the Queue/Steer above-row shell chrome without nested item capsules', () => {
    const css = readCss()

    const shellBlock = cssBlockStartingAt(
      css,
      '[data-composer-style="claude"] .queued-messages-above-row {'
    )
    const itemBlock = cssBlockStartingAt(
      css,
      '[data-composer-style="claude"] .queued-messages-row {'
    )
    const baseItemBlock = cssBlockStartingAt(css, '.queued-messages-row {')

    expect(shellBlock).toContain('border-radius: 14px;')
    expect(shellBlock).not.toContain('calc(var(--radius-lg) * 1.6)')
    // Shell-native container carries chrome; queue items stay flat satellites.
    expect(baseItemBlock).toContain('background: transparent;')
    expect(baseItemBlock).toContain('border-radius: 0;')
    expect(baseItemBlock).not.toContain('border-radius: 999px')
    expect(itemBlock).toContain('background: transparent;')
    expect(itemBlock).not.toContain('border-radius: 999px')
  })

  it('gives Gemini queue the same blue shell chrome as ensemble above-rows', () => {
    const css = readCss()
    // Prefer the dark shell block (line-start selector), not a light-theme
    // rule that merely contains the same class substring mid-selector.
    const geminiBlockStart = css.search(
      /^\[data-composer-style="gemini"\] \.ensemble-above-row,/m
    )
    expect(geminiBlockStart).toBeGreaterThanOrEqual(0)
    const geminiBlock = css.slice(geminiBlockStart, geminiBlockStart + 600)
    expect(geminiBlock).toContain('[data-composer-style="gemini"] .queued-messages-above-row,')
    expect(geminiBlock).toContain('var(--provider-gemini-color)')
  })
})
