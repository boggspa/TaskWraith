import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const readClaudeLightSection = (): string => {
  const css = readCss()
  const marker = "/* Claude light shell — match the real app's gray above-row family"
  const start = css.indexOf(marker)
  expect(start, 'Missing Claude light shell sign-off').toBeGreaterThanOrEqual(0)
  return css.slice(start)
}

describe('Claude composer light chrome', () => {
  it('paints every requested detached above-row with the reference gray', () => {
    const section = readClaudeLightSection()

    expect(section).toContain(
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-composer-style="claude"]'
    )
    expect(section).toContain('.composer-workspace-above-row,')
    expect(section).toContain('.ensemble-above-row,')
    expect(section).toContain('.queued-messages-above-row,')
    expect(section).toContain('.ensemble-roster-preset-picker.is-compact')
    expect(section).toContain('background: #f4f4f3 !important;')
  })

  it('gives the textarea/send frame a light-mode rim and subtle shadow', () => {
    const section = readClaudeLightSection()

    expect(section).toContain('background: #ffffff !important;')
    expect(section).toContain('border-color: rgba(29, 29, 31, 0.14) !important;')
    expect(section).toContain('0 1px 2px rgba(18, 21, 27, 0.06),')
    expect(section).toContain('0 4px 14px rgba(18, 21, 27, 0.05) !important;')
    expect(section).toContain('.composer-surface:focus-within\n  .composer-textarea {')
    expect(section).toContain('border-color: rgba(29, 29, 31, 0.25) !important;')
  })

  it('darkens orchestration labels across light composer shells', () => {
    const section = readClaudeLightSection()

    expect(section).toContain('.composer-ensemble-orchestration-row')
    expect(section).toContain('.composer-orchestration-cell-label {')
    expect(section).toContain('color: var(--text-secondary);')
  })
})
