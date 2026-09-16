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
  it('paints every requested detached above-row with crisp reference-gray chrome', () => {
    const section = readClaudeLightSection()

    expect(section).toContain(
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-composer-style="claude"]'
    )
    expect(section).toContain('.composer-workspace-above-row,')
    expect(section).toContain('.ensemble-above-row,')
    expect(section).toContain('.queued-messages-above-row,')
    expect(section).toContain('.ensemble-roster-preset-picker.is-compact')
    expect(section).toContain('background: #f4f4f3 !important;')
    expect(section).toContain('border-color: transparent !important;')
    expect(section).toContain('box-shadow: none !important;')
    expect(section).toContain('-webkit-backdrop-filter: none !important;')
    expect(section).toContain('backdrop-filter: none !important;')
  })

  it('gives the textarea/send frame the Claude Desktop light palette: white fill, black 10% inset ring, 25% on focus', () => {
    const section = readClaudeLightSection()

    // The light frame is the light palette block of the Claude Desktop parity
    // section (same shard, below the above-row family), consumed by the
    // shared box rule through Claude-local custom properties.
    const lightPalette = section.slice(section.indexOf('/* Palette — light family */'))
    expect(lightPalette).toContain(
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-composer-style="claude"]\n  .app-transcript\n  .composer-surface:not(.side-chat-composer) {'
    )
    expect(lightPalette).toContain('--claude-cc-box-bg: #ffffff;')
    expect(lightPalette).toContain('--claude-cc-box-ring: rgba(0, 0, 0, 0.1);')
    expect(lightPalette).toContain('--claude-cc-box-ring-focus: rgba(0, 0, 0, 0.25);')
    expect(lightPalette).toContain('--claude-cc-box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);')
    expect(lightPalette).toContain('--claude-cc-text: #0b0b0b;')
    expect(lightPalette).toContain('--claude-cc-text-secondary: #52514e;')
    expect(lightPalette).toContain('--claude-cc-text-muted: #898781;')

    expect(section).toContain('background: var(--claude-cc-box-bg) !important;')
    expect(section).toContain('inset 0 0 0 1px var(--claude-cc-box-ring),')
    expect(section).toContain(
      '.composer-surface:not(.side-chat-composer):focus-within\n  .composer-textarea {'
    )
    expect(section).toContain('inset 0 0 0 1px var(--claude-cc-box-ring-focus),')

    // The pre-parity light frame (rimmed border + two-layer drop shadow) is gone.
    expect(section).not.toContain('border-color: rgba(29, 29, 31, 0.14) !important;')
    expect(section).not.toContain('0 4px 14px rgba(18, 21, 27, 0.05) !important;')
  })

  it('darkens orchestration labels across light composer shells', () => {
    const section = readClaudeLightSection()

    expect(section).toContain('.composer-ensemble-orchestration-row')
    expect(section).toContain('.composer-orchestration-cell-label {')
    expect(section).toContain('color: var(--text-secondary);')
  })
})
