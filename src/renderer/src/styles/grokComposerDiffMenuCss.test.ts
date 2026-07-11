import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
  'utf8'
).replace(/\r\n/g, '\n')

describe('Grok composer diff menu stacking', () => {
  it('unclips and elevates only the Grok tucked stack while the inline menu is open', () => {
    const selector =
      '[data-composer-style="grok"]\n  .composer-above-bar-stack:has(.composer-diff-action-menu) {'
    const start = css.indexOf(selector)
    const end = css.indexOf('}', start)
    const block = css.slice(start, end + 1)

    expect(start).toBeGreaterThan(-1)
    expect(block).toContain('overflow: visible')
    expect(block).toContain('z-index: 10')
    expect(block).not.toContain('data-composer-style="codex"')
  })
})
