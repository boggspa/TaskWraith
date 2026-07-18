import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/04-settings-controls.css'),
  'utf8'
).replace(/\r\n/g, '\n')

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `Missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('\n}', start)
  expect(end, `Unterminated CSS rule: ${selector}`).toBeGreaterThan(start)
  return css.slice(start, end)
}

describe('identity icon color fields CSS', () => {
  it('allows the Hex and RGB columns to shrink inside narrow project cards', () => {
    expect(rule('.agent-pool-color-fields')).toContain(
      'grid-template-columns: 18px minmax(0, 0.85fr) minmax(0, 1fr);'
    )
    expect(rule('.agent-pool-color-field')).toContain('min-width: 0;')
    expect(rule('.agent-pool-color-field input')).toContain('min-width: 0;')
  })
})
