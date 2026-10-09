import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssDir = join(process.cwd(), 'src/renderer/src/assets/css')
const readShard = (name: string): string =>
  readFileSync(join(cssDir, name), 'utf8').replace(/\r\n/g, '\n')

const SECTION_START = 'Codex shell — Codex Desktop composer parity'
const SECTION_END =
  '/* ==================== end Codex Desktop composer parity ==================== */'
const CODEX_GUARD = '[data-composer-style="codex"]'

const readParitySection = (): string => {
  const css = readShard('10-provider-shell-overrides.css')
  const title = css.indexOf(SECTION_START)
  expect(title, 'Missing Codex Desktop composer parity section').toBeGreaterThanOrEqual(0)
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

describe('Codex shell — Codex Desktop composer parity CSS', () => {
  it('sits after the Codex light block and before the ChatGPT final overrides', () => {
    const css = readShard('10-provider-shell-overrides.css')
    const lightEnd = css.indexOf('/* The compact uppercase orchestration labels')
    const chatgpt = css.indexOf('ChatGPT shell — final overrides')
    const parity = css.indexOf(SECTION_START)
    expect(lightEnd).toBeGreaterThanOrEqual(0)
    expect(parity).toBeGreaterThan(lightEnd)
    expect(chatgpt).toBeGreaterThan(parity)
  })

  it('scopes every rule to the Codex shell composer surface and names no other shell', () => {
    const section = readParitySection()
    const selectors = selectorsOf(section)
    expect(selectors.length).toBeGreaterThan(20)
    for (const selector of selectors) {
      expect(selector, selector).toContain(CODEX_GUARD)
      // Joined-stack exception: the welcome seam rules (merged above-row
      // frame above → drop the surface's transparent border-top so the
      // backdrop-filter blur cannot seam the join, and flatten the strip's
      // top corners so the pair reads as one continuous stacked tab) must
      // detect the frame, which lives as a previous sibling of the surface
      // inside .composer-primary-stack — unreachable from .composer-surface
      // by combinators. They gate on the frame with
      // `.composer-above-bar-stack:has(…) + .composer-surface` (a :has()
      // may not nest inside another :has(), so the previous primary-stack
      // detour was invalid and dropped at parse time). The rules keep the
      // codex guard (checked above) and name no other shell, so the
      // isolation intent of this contract holds.
      if (selector.includes('.composer-above-bar-stack:has(')) continue
      expect(selector, selector).toMatch(
        /\.app-transcript(\.welcome-mode|:not\(\.welcome-mode\))? \.composer-surface/
      )
    }
    for (const shell of [
      'default',
      'claude',
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

  it('makes the outer surface invisible and the inner module the four-cornered box', () => {
    const section = readParitySection()
    expect(section).toContain('background: transparent !important;')
    expect(section).toContain('box-shadow: none !important;')
    // Retain the measured 24px radius and the chosen two-step lighter dark fill.
    expect(section).toContain('--codex-cc-box-radius: 24px;')
    expect(section).toContain('--codex-cc-box-bg: #2e2e2e;')
    expect(section).toContain(
      'background: var(--codex-cc-box-bg, var(--composer-bg-solid, var(--composer-bg)));'
    )
    expect(section).toContain('.composer-inner-module {')
    expect(section).toContain('border-radius: var(--codex-cc-box-radius);')
    // The box's drop shadow is dark-family only: this section outranks the
    // light box in shard 08, so an unscoped shadow would darken the white box.
    const boxRules = section
      .split('\n}')
      .filter((rule) => rule.includes('.composer-inner-module {'))
    expect(boxRules).toHaveLength(2)
    expect(boxRules[0]).not.toContain('box-shadow')
    expect(boxRules[1]).toContain(
      ':not(\n    :is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])\n  )'
    )
    expect(boxRules[1]).toContain('box-shadow:\n    0 8px 16px rgba(0, 0, 0, 0.12),')
    // The light block's surface rule is transparent too (the strip owns the gray).
    expect(readShard('10-provider-shell-overrides.css')).toContain(
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-composer-style="codex"]\n  .app-transcript\n  .composer-surface {\n  background: transparent !important;\n}'
    )
    expect(section).toContain('--codex-cc-strip-bg: #f5f5f5;')
  })

  it('draws the strip as an inset tab: above the box on a new thread, below it once begun', () => {
    const section = readParitySection()
    expect(section).toContain('--codex-cc-strip-inset: 14px;')
    expect(section).toContain('--codex-cc-strip-radius: 12px;')
    expect(section).toContain('--codex-cc-strip-overlap: 14px;')
    expect(section).toContain('margin: 0 var(--codex-cc-strip-inset);')
    // Hairline outline shared with the merged ensemble/roster/queued frame
    // above the composer: same 1px colour-mix literal as that frame's
    // border. Dark uses the frame's white-12% hairline; the light-family
    // mirror uses the frame's light black-12% hairline (shard 09's light
    // unified-container rule). The tucked edge drops per placement below.
    expect(section).toContain(
      '--codex-cc-strip-border: 1px solid color-mix(in srgb, #ffffff 12%, transparent);'
    )
    expect(section).toContain(
      '--codex-cc-strip-border: 1px solid color-mix(in srgb, #000000 12%, transparent);'
    )
    expect(section).toContain(
      '.app-transcript.welcome-mode\n  .composer-surface\n  .composer-telemetry-row {\n  order: -1;\n  border-radius: var(--codex-cc-strip-radius) var(--codex-cc-strip-radius) 0 0;'
    )
    expect(section).toContain(
      'border-radius: var(--codex-cc-strip-radius) var(--codex-cc-strip-radius) 0 0;\n  border-bottom: 0;'
    )
    // Joined welcome stack: when the merged ensemble/roster/queued frame
    // abuts the strip from above, (1) the surface's transparent border
    // drops so the backdrop-filter blur can no longer seam the join dark
    // AND the strip's inset margins resolve against the full stack width
    // (the leftover 1px side borders would otherwise make the strip 1px
    // shy of the frame's edges per side), and (2) the strip's top corners
    // flatten so the pair reads as one continuous stacked tab; the kept
    // top border draws the single seam. The sibling-combinator gate on the
    // frame scopes both to the frame-present case — a frame-less welcome
    // keeps the rounded tucked-tab top (and the invisible border costs
    // nothing there).
    expect(section).toContain(
      '.app-transcript.welcome-mode:not(.multiview-pane-transcript)\n  .composer-above-bar-stack:has(\n    :is(\n      .ensemble-above-row,\n      .queued-messages-above-row,\n      .ensemble-roster-preset-picker.is-compact\n    )\n  )\n  + .composer-surface {\n  border: 0;'
    )
    expect(section).toContain(
      '.app-transcript.welcome-mode:not(.multiview-pane-transcript)\n  .composer-above-bar-stack:has(\n    :is(\n      .ensemble-above-row,\n      .queued-messages-above-row,\n      .ensemble-roster-preset-picker.is-compact\n    )\n  )\n  + .composer-surface\n  .composer-telemetry-row {\n  border-top-left-radius: 0;\n  border-top-right-radius: 0;'
    )
    expect(section).toContain('margin-bottom: calc(-1 * var(--codex-cc-strip-overlap));')
    expect(section).toContain(
      '.app-transcript:not(.welcome-mode)\n  .composer-surface\n  .composer-telemetry-row {\n  border-radius: 0 0 var(--codex-cc-strip-radius) var(--codex-cc-strip-radius);'
    )
    expect(section).toContain(
      'border-radius: 0 0 var(--codex-cc-strip-radius) var(--codex-cc-strip-radius);\n  border-top: 0;'
    )
    expect(section).toContain('margin-top: calc(-1 * var(--codex-cc-strip-overlap));')
    // Welcome tab order: workspace (1) · branch zone (2) · tools cluster (3), left-aligned.
    expect(section).toContain('.composer-telemetry-side--left {\n  order: 1;')
    expect(section).toContain('.composer-telemetry-side--right {\n  order: 2;')
    expect(section).toContain('.composer-telemetry-cluster {\n  order: 3;')
    expect(section).toContain('[data-composer-control="workspace"]::after {\n  content: none;')
    // A zone with nothing in it must not still spend the row's 16px gap.
    expect(section).toContain('.composer-telemetry-row\n  > :empty {\n  display: none;')
    // The linked-chat pane insets the composer itself, so the tab's own inset halves there.
    expect(section).toContain(
      '.side-chat-pane.app-transcript .composer-surface {\n  --codex-cc-strip-inset: 6px;'
    )
  })

  it('pins the permission chip (glyph + muted label, no chevron, elevated accents kept)', () => {
    const section = readParitySection()
    expect(section).toContain('[data-composer-control="permission"]::after {\n  content: none;')
    expect(section).toContain(
      '[data-composer-control="permission"]:not([data-permission-value="workspace_write"]):not(\n    [data-permission-value="full_access"]\n  ) {\n  color: var(--codex-cc-chip-muted) !important;'
    )
    expect(section).toContain(
      '.composer-permission-glyph\n  svg {\n  width: 16px;\n  height: 16px;'
    )
  })

  it('fills the send circle only in the empty-draft waveform state, and sizes only its glyph', () => {
    const section = readParitySection()
    // A full-strength circle reads as "press me". `:disabled` has five causes
    // (no chat, no workspace, empty draft, provider unavailable, Gemini trust),
    // so gate the fill on the waveform the Composer renders for the empty one.
    expect(section).toContain(
      '.composer-action-btn.run-btn:disabled:has(.composer-waveform-glyph) {\n  background: var(--codex-cc-send-bg);\n  color: var(--codex-cc-send-ink);\n  opacity: 1;'
    )
    expect(section).toContain(
      '.composer-action-btn.run-btn:disabled:not(:has(.composer-waveform-glyph)) {\n  background: color-mix(in srgb, var(--codex-cc-send-bg) 34%, transparent) !important;'
    )
    expect(section).toContain(
      '.composer-action-btn.stop-btn\n  .sf-symbol-icon\n  rect {\n  fill: currentColor;'
    )
    // 18px is the SEND glyph. The voice button lives in this same cluster on
    // the Codex shell, so the rule must not reach a bare `.composer-action-btn`.
    const sized = section.split('\n}').filter((rule) => rule.includes('width: 18px;'))
    expect(sized).toHaveLength(1)
    expect(sized[0]).toContain(
      ':is(.composer-action-btn.run-btn, .composer-action-btn.stop-btn)\n  .sf-symbol-icon'
    )
    expect(sized[0]).not.toContain('.composer-send-cluster\n  .composer-action-btn\n')
  })

  it('light family: bare "+" glyph and a black send/stop circle with white ink', () => {
    const section = readParitySection()
    expect(section).toContain('--codex-cc-send-bg: #0d0d0d;\n  --codex-cc-send-ink: #ffffff;')
    expect(section).toContain(
      '.composer-image-picker-btn {\n  background: transparent !important;\n  border-color: transparent !important;'
    )
    expect(section).toContain(
      ':is(\n    .composer-action-btn.run-btn:not(:disabled),\n    .composer-action-btn.run-btn:disabled:has(.composer-waveform-glyph),\n    .composer-action-btn.stop-btn\n  ) {\n  background: var(--codex-cc-send-bg) !important;\n  color: var(--codex-cc-send-ink) !important;'
    )
  })

  it('keeps the Advanced-FX agent aura ring off the invisible surface', () => {
    const section = readParitySection()
    expect(section).toContain('.composer-surface.fx-agent-aura.fx-status-running::after')
    expect(section).toContain(
      '.fx-status-failed::after {\n  display: none !important;\n  content: none !important;'
    )
  })

  it('retired the Codex container rules the section replaces', () => {
    const shard07 = readShard('07-composer-shells.css')
    expect(shard07).toContain(
      'Codex shell: this block moved to the "Codex Desktop composer parity"'
    )
    // Selector-level, so a reworded copy of the same rule still reds.
    for (const retired of [
      '[data-composer-style="codex"] .composer-surface {',
      '[data-composer-style="codex"] .composer-surface:focus-within {',
      '[data-composer-style="codex"] .composer-inner-module {',
      '[data-composer-style="codex"] .composer-telemetry-row {'
    ]) {
      expect(shard07, `shard 07 still declares ${retired}`).not.toContain(retired)
    }
  })
})
