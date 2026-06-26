import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/08-theme-picker-overrides.css'),
    'utf8'
  )

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('composer slash menu CSS', () => {
  it('allows the portaled menu to use its measured composer width', () => {
    const rootBlock = cssBlockStartingAt(readCss(), '.composer-slash-menu {')

    expect(rootBlock).toContain('box-sizing: border-box')
    expect(rootBlock).not.toContain('max-width: 440px')
    expect(rootBlock).not.toContain('min-width: 320px')
  })

  it('keeps an icon slot and compact title row for slash command rows', () => {
    const css = readCss()

    expect(cssBlockStartingAt(css, '.composer-slash-menu-icon {')).toContain('flex: 0 0 24px')
    expect(cssBlockStartingAt(css, '.composer-slash-menu-title-row {')).toContain(
      'align-items: baseline'
    )
  })
})
