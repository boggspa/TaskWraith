import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/08-theme-picker-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssSectionBetween = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker)
  expect(start, `Missing CSS section start: ${startMarker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start)
  expect(end, `Missing CSS section end: ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('composer send affordance textarea inset CSS', () => {
  it('reserves text-flow space only for shells that overlay send controls inside the textarea', () => {
    const css = readCss()
    const section = cssSectionBetween(
      css,
      'Claude, Obsidian, and Alabaster place the send/stop affordance',
      '/* 3) Files-changed + diff chips'
    )

    expect(section).toContain('[data-composer-style="claude"]')
    expect(section).toContain('[data-composer-style="obsidian"]')
    expect(section).toContain('[data-composer-style="alabaster"]')
    expect(section).toContain('--composer-inline-send-affordance-inset: 62px')
    expect(section).toContain('--composer-inline-send-affordance-inset: 68px')
    expect(section).toContain('.composer-textarea')
    expect(section).toContain('padding-right: var(--composer-inline-send-affordance-inset)')

    expect(section).not.toContain('[data-composer-style="codex"]')
    expect(section).not.toContain('[data-composer-style="gemini"]')
    expect(section).not.toContain('[data-composer-style="kimi"]')
    expect(section).not.toContain('[data-composer-style="grok"]')
    expect(section).not.toContain('[data-composer-style="default"]')
  })
})
