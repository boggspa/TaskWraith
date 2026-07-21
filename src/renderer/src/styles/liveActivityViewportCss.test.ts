import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/12-live-activity-viewport.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const ruleFor = (css: string, selector: string): string => {
  const start = css.indexOf(selector)
  expect(start, `selector ${selector}`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  expect(open, `open block ${selector}`).toBeGreaterThan(start)
  return css.slice(open + 1, css.indexOf('}', open))
}

describe('live activity viewport CSS', () => {
  it('keeps transcript activity rails hidden', () => {
    const css = readCss()

    expect(ruleFor(css, '.live-activity-viewport')).toContain('padding-left: 0')
    expect(ruleFor(css, '.live-activity-viewport-rail')).toContain('display: none')
    expect(css).not.toContain('live-activity-rail-pulse')
  })
})
