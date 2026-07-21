import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCodexLightSection = (): string => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const marker = "/* Codex light shell — mirror the real Codex app's pure-white editor"
  const endMarker = '/* The compact uppercase orchestration labels'
  const start = css.indexOf(marker)
  const end = css.indexOf(endMarker, start)
  expect(start, 'Missing Codex light shell sign-off').toBeGreaterThanOrEqual(0)
  expect(end, 'Missing Codex light shell end marker').toBeGreaterThan(start)
  return css.slice(start, end)
}

describe('Codex composer light chrome', () => {
  it('paints the editor module pure white only for light-family themes', () => {
    const section = readCodexLightSection()

    expect(section).toContain(
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-composer-style="codex"]'
    )
    expect(section).toContain('.composer-inner-module {')
    expect(section).toContain('background: #ffffff !important;')
    expect(section).toContain('background-image: none !important;')
    expect(section).not.toContain('[data-theme="dark"]')
  })

  it('makes solo and unified above rows white without changing their joined geometry', () => {
    const section = readCodexLightSection()

    expect(section).toContain(
      '.composer-above-bar-stack:has(:is(.ensemble-above-row, .queued-messages-above-row))'
    )
    expect(section).toContain('.composer-workspace-above-row,')
    expect(section).toContain('.ensemble-above-row,')
    expect(section).toContain('.queued-messages-above-row,')
    expect(section).toContain('.composer-create-pr-row,')
    expect(section).toContain('.ensemble-roster-preset-picker.is-compact')
    expect(section).toContain('background: transparent !important;')
  })

  it('recolors only the exposed utility bed to the official Codex gray', () => {
    const section = readCodexLightSection()
    const rules = section.replace(/\/\*[\s\S]*?\*\//g, '')
    const surfaceRule = rules.match(/\.composer-surface \{\n([\s\S]*?)\n\}/)

    expect(surfaceRule?.[1].trim()).toBe('background: #f5f5f5 !important;')
    expect(rules).not.toContain('.composer-bottom-controls')
    expect(rules).not.toContain('.composer-telemetry-row')
  })
})
