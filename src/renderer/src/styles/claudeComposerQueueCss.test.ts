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
  it('keeps the Queue/Steer above-row corners aligned with Claude row chrome', () => {
    const css = readCss()

    const shellBlock = cssBlockStartingAt(
      css,
      '[data-composer-style="claude"] .queued-messages-above-row {'
    )
    const itemBlock = cssBlockStartingAt(
      css,
      '[data-composer-style="claude"] .queued-messages-row {'
    )

    expect(shellBlock).toContain('border-radius: 12px;')
    expect(itemBlock).toContain('border-radius: 8px;')
    expect(shellBlock).not.toContain('calc(var(--radius-lg) * 1.6)')
    expect(itemBlock).not.toContain('border-radius: 999px')
  })
})
