import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readCss(file: string): string {
  return readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8')
}

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  expect(open).toBeGreaterThan(start)
  expect(close).toBeGreaterThan(open)
  return css.slice(open + 1, close)
}

describe('editable mention-overlay selection CSS', () => {
  it.each([
    ['03-composer-welcome-activity.css', '.composer-textarea.has-mention-overlay::selection'],
    ['09-ensemble-work-session.css', '.ensemble-brief-textarea.has-mention-overlay::selection']
  ])('keeps the native glyph copy transparent in %s', (file, selector) => {
    const body = ruleBody(readCss(file), selector)

    expect(body).toContain('color: transparent;')
    expect(body).toContain('-webkit-text-fill-color: transparent;')
    expect(body).toContain('background: color-mix(')
  })
})
