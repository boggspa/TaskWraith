import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssDir = join(process.cwd(), 'src/renderer/src/assets/css')
const readShard = (name: string): string =>
  readFileSync(join(cssDir, name), 'utf8').replace(/\r\n/g, '\n')

const SECTION_START = 'Claude shell — Claude Desktop composer parity (comfortable density)'
const SECTION_END =
  '/* ==================== end Claude Desktop composer parity ==================== */'
const CLAUDE_GUARD = '[data-composer-style="claude"]'
const SURFACE_GUARD = '.composer-surface:not(.side-chat-composer)'

const readParitySection = (): string => {
  const css = readShard('10-provider-shell-overrides.css')
  const title = css.indexOf(SECTION_START)
  expect(title, 'Missing Claude Desktop composer parity section').toBeGreaterThanOrEqual(0)
  // Back up to the comment opener so the header comment is a whole comment
  // (the selector parser strips complete comments only).
  const start = css.lastIndexOf('/*', title)
  const end = css.indexOf(SECTION_END, title)
  expect(end, 'Missing parity section end marker').toBeGreaterThan(title)
  return css.slice(start, end)
}

/** Split a selector list on the commas outside `:is(...)` / `:not(...)`. */
const splitTopLevel = (list: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/** Every selector list in the section, one entry per top-level selector. */
const selectorsOf = (section: string): string[] => {
  const withoutComments = section.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors: string[] = []
  for (const rule of withoutComments.split('}')) {
    const brace = rule.indexOf('{')
    if (brace < 0) continue
    for (const selector of splitTopLevel(rule.slice(0, brace))) {
      const trimmed = selector.replace(/\s+/g, ' ').trim()
      if (trimmed) selectors.push(trimmed)
    }
  }
  return selectors
}

describe('Claude shell — Claude Desktop composer parity CSS', () => {
  it('sits after the Claude light shell block, inside the slice its light-chrome test reads', () => {
    const css = readShard('10-provider-shell-overrides.css')
    const lightMarker = css.indexOf(
      "/* Claude light shell — match the real app's gray above-row family"
    )
    const signOff = css.indexOf('Shell sign-off')
    const parity = css.indexOf(SECTION_START)
    expect(lightMarker).toBeGreaterThanOrEqual(0)
    expect(signOff).toBeGreaterThanOrEqual(0)
    expect(parity).toBeGreaterThan(lightMarker)
    expect(parity).toBeGreaterThan(signOff)
  })

  it('scopes every rule to the Claude shell and outside the side-chat composer', () => {
    const selectors = selectorsOf(readParitySection())
    expect(selectors.length).toBeGreaterThan(30)
    for (const selector of selectors) {
      expect(selector, selector).toContain(CLAUDE_GUARD)
      expect(selector, selector).toContain('.app-transcript ' + SURFACE_GUARD)
    }
    // No other shell id anywhere in the section, comments included.
    const section = readParitySection()
    for (const shell of [
      'default',
      'codex',
      'chatgpt',
      'cursor',
      'grok',
      'gemini',
      'kimi',
      'modular',
      'terminal',
      'stub',
      'satellite',
      'obsidian',
      'alabaster'
    ]) {
      expect(section).not.toContain(`[data-composer-style="${shell}"]`)
    }
  })

  it('pins the box: #20201f fill, 8% inset ring, 14px radius, 13px/8px text inset, 16px/22px type, 48px single line', () => {
    const section = readParitySection()
    expect(section).toContain('--claude-cc-box-bg: #20201f;')
    expect(section).toContain('--claude-cc-box-ring: rgba(255, 255, 255, 0.08);')
    expect(section).toContain('--claude-cc-box-ring-focus: rgba(255, 255, 255, 0.16);')
    expect(section).toContain('--claude-cc-box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);')
    expect(section).toContain('--claude-cc-text: #f0efec;')
    expect(section).toContain('--claude-cc-text-muted: #898781;')
    expect(section).toContain('border-radius: 14px !important;')
    expect(section).toContain('inset 0 0 0 1px var(--claude-cc-box-ring),')
    expect(section).toContain(
      'padding: 13px var(--composer-inline-send-affordance-inset, 40px) 13px 8px;'
    )
    expect(section).toContain('min-height: 48px !important;')
    expect(section).toContain('font-size: 16px;')
    expect(section).toContain('line-height: 22px;')
    expect(section).toContain('display: block;')
  })

  it('anchors a 32px ghost send/stop cluster 8px inside the box bottom-right, above the chin', () => {
    const section = readParitySection()
    expect(section).toContain('.composer-control-footer {\n  position: relative;')
    expect(section).toContain('bottom: calc(100% + 16px);')
    expect(section).toContain('right: 8px;')
    expect(section).toContain('width: 32px;\n  height: 32px;\n  min-width: 32px;')
    expect(section).toContain('border-radius: 8px;')
    expect(section).toContain('opacity: 0.4;')
    expect(section).toContain('--claude-cc-hover: rgba(255, 255, 255, 0.075);')
  })

  it('pins the chin: 24px row, 4px gaps, 13px type, 24px ghost plus/mic/permission, 12px ring', () => {
    const section = readParitySection()
    expect(section).toContain('min-height: 24px;\n  align-items: center;')
    expect(section).toContain('gap: 4px;')
    expect(section).toContain('padding: 0 8px;')
    expect(section).toContain(
      '.composer-combined-picker-trigger {\n  height: 24px;\n  min-height: 24px;\n  font-size: 13px;'
    )
    expect(section).toContain('.composer-image-picker-btn {\n  width: 24px;\n  height: 24px;')
    expect(section).toContain('.composer-action-btn.voice-btn {\n  width: 24px;\n  height: 24px;')
    expect(section).toContain('.composer-voice-chevron {\n  width: 12px;\n  height: 24px;')
    expect(section).toContain('[data-composer-control="permission"] {\n  height: 24px;')
    expect(section).toContain('font-weight: 400;')
    expect(section).toContain('.context-wheel\n  svg {\n  width: 12px;\n  height: 12px;')
    expect(section).toContain('--claude-cc-ring-track: rgba(255, 255, 255, 0.1);')
    expect(readShard('08-theme-picker-overrides.css')).toContain(
      '[data-composer-style="claude"] .context-wheel {\n  color: #2a78d6;\n}'
    )
  })

  it('leaves the model chip its own chrome: the section only sizes the shared trigger', () => {
    const section = readParitySection()
    const triggerRule = section.slice(
      section.indexOf('.composer-combined-picker-trigger {'),
      section.indexOf('}', section.indexOf('.composer-combined-picker-trigger {'))
    )
    expect(triggerRule).toContain('height: 24px;')
    expect(triggerRule).toContain('font-size: 13px;')
    expect(triggerRule).not.toContain('color')
    expect(triggerRule).not.toContain('font-weight')
    expect(triggerRule).not.toContain('background')
    expect(section).not.toContain('[data-composer-control="model"]')
  })

  it('retired the pre-parity hacks the section replaces', () => {
    const shard07 = readShard('07-composer-shells.css')
    const shard08 = readShard('08-theme-picker-overrides.css')
    const shard10 = readShard('10-provider-shell-overrides.css')

    // Glyph scale + absolute top-right send placement (shard 07).
    expect(shard07).not.toContain('--claude-send-glyph-scale')
    expect(shard07).not.toContain('--claude-stop-glyph-scale')
    expect(shard07).not.toContain('#ffb36c 82%')
    expect(shard07).not.toContain(
      '[data-composer-style="claude"] .composer-textarea {\n  background: #151515 !important;'
    )
    // Hard-coded footer-height send offset + rimmed fills (shard 08).
    expect(shard08).not.toContain('background: #1e1e1e !important')
    expect(shard08).not.toContain('calc(82px +')
    expect(shard08).not.toContain('--claude-send-cluster-lift')
    // The dark above-row fill family no longer paints the textarea (shard 10).
    expect(shard10).not.toContain('    .composer-textarea,\n    .composer-above-bar,')
    // ...but the family itself is intact for the above rows.
    expect(shard10).toContain(
      '    .composer-above-bar,\n    .ensemble-above-row,\n    .queued-messages-above-row,\n    .composer-create-pr-row,\n    .ensemble-roster-preset-picker.is-compact\n  ) {\n  /* The textarea box'
    )
    // Chin order: attach and mic lead the permission chip.
    expect(shard07).toContain(
      '[data-composer-style="claude"] [data-composer-control="permission"] { order: 0; }'
    )
    expect(shard07).toContain(
      '[data-composer-style="claude"] [data-composer-control="voice"] { order: -1; }'
    )
    expect(shard07).toContain(
      '[data-composer-style="claude"] [data-composer-control="attach"]    { order: -2; }'
    )
  })
})
