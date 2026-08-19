import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n')

/**
 * Attachments used to stack on `.composer-surface`, ABOVE the input container.
 * In the capsule shells (cursor / chatgpt / gemini) that surface is a
 * transparent vertical shell and the visible box IS `.composer-textarea-wrap`,
 * so the thumbnails read as floating outside the composer entirely. They now
 * stack at the TOP of that box, above the draft text.
 */
describe('composer attachment tray placement', () => {
  const composer = readSource('src/renderer/src/components/Composer.tsx')

  it('renders the tray inside the textarea container, above the text', () => {
    const wrapIndex = composer.indexOf('composer-textarea-wrap${')
    const trayIndex = composer.indexOf('<ComposerAttachmentTray')
    const textareaIndex = composer.indexOf('className={`composer-textarea${')

    expect(wrapIndex).toBeGreaterThanOrEqual(0)
    expect(trayIndex).toBeGreaterThan(wrapIndex)
    expect(textareaIndex).toBeGreaterThan(trayIndex)
  })

  it('no longer parks the tray on the outer surface frame', () => {
    const innerModuleIndex = composer.indexOf('<div className="composer-inner-module">')
    expect(innerModuleIndex).toBeGreaterThanOrEqual(0)
    expect(composer.indexOf('<ComposerAttachmentTray')).toBeGreaterThan(innerModuleIndex)
  })

  it('keeps the highlight overlay anchored to the textarea, not the tray', () => {
    // `.composer-textarea-highlight` is `position: absolute; inset: 0`. Left
    // alone it would mirror the whole wrap and paint every glyph one
    // tray-height above the real caret. Giving it the textarea's grid area
    // makes that area its containing block instead.
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')

    expect(css).toContain(
      '.composer-textarea-wrap.composer-textarea-wrap:has(> .composer-attachment-tray) {'
    )
    expect(css).toContain('grid-template-rows: auto auto;')
    expect(css).toContain('.composer-textarea-wrap > .composer-attachment-tray {')
    expect(css).toContain(
      '.composer-textarea-wrap:has(> .composer-attachment-tray) > .composer-textarea,\n' +
        '.composer-textarea-wrap:has(> .composer-attachment-tray) > .composer-textarea-highlight {\n' +
        '  grid-row: 2;'
    )
    // The voice waveform must keep mirroring the wrap's padding box.
    expect(css).not.toContain('.composer-voice-overlay {\n  grid-row')
  })

  it('still collapses with the other above-rows when the composer is minimised', () => {
    const css = readSource('src/renderer/src/assets/css/17-composer-hint-pills.css')

    expect(css).not.toMatch(/\.composer-surface\s*>\s*:is\(\.composer-chips/)
    expect(
      css.match(
        /:is\(\.composer-surface, \.composer-textarea-wrap\)\s*>\s*:is\(\.composer-chips/g
      )
    ).toHaveLength(4)
  })
})
