import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const mvCss = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/14-multiview.css'),
  'utf8'
)
const pickerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/TranscriptViewPicker.tsx'),
  'utf8'
)

/**
 * The composer "View" (TranscriptViewPicker) trigger once shipped with only
 * the generic hint-pill classes. This app resets no global `button` styles
 * and never sets `color-scheme` on :root, so the unstyled <button> rendered
 * as the Chromium UA light ButtonFace — a white block — with the dark-theme
 * `currentColor` glyph invisible on top of it. The fix groups the trigger
 * with the multiview/canvas bare footer-icon rules; these assertions keep it
 * grouped so the chrome cannot silently drop out again.
 */
describe('composer transcript view trigger chrome', () => {
  it('wires the picker trigger to the styled class', () => {
    expect(pickerSource).toContain('composer-transcript-view-trigger')
    expect(pickerSource).toContain('data-hint-label="View"')
  })

  it('groups the View trigger with the bare footer-icon base rule', () => {
    expect(mvCss).toMatch(
      /\.composer-multiview-trigger,\s*\n\.composer-canvas-trigger,\s*\n\.composer-transcript-view-trigger\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*transparent;/
    )
  })

  it('gives the View trigger the hover/open accent states', () => {
    expect(mvCss).toMatch(
      /\.composer-transcript-view-trigger:hover:not\(:disabled\),\s*\n\.composer-transcript-view-trigger\[aria-expanded='true'\]\s*\{[\s\S]*?color:\s*var\(--text-primary\);[\s\S]*?var\(--accent\) 8%/
    )
  })

  it('gives the View trigger the disabled and 14px icon sizing rules', () => {
    expect(mvCss).toMatch(
      /\.composer-multiview-trigger:disabled,\s*\n\.composer-canvas-trigger:disabled,\s*\n\.composer-transcript-view-trigger:disabled\s*\{/
    )
    expect(mvCss).toMatch(
      /\.composer-multiview-trigger \.composer-control-icon,\s*\n\.composer-canvas-trigger \.composer-control-icon,\s*\n\.composer-transcript-view-trigger \.composer-control-icon\s*\{[\s\S]*?width:\s*14px;[\s\S]*?height:\s*14px;/
    )
  })
})
