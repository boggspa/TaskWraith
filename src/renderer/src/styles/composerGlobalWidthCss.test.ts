import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (cssPath = 'src/renderer/src/assets/css/02-transcript-messages-fx.css'): string =>
  readFileSync(
    join(process.cwd(), cssPath),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

const literalMatchCount = (source: string, literal: string): number => {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return Array.from(source.matchAll(new RegExp(escaped, 'g'))).length
}

describe('General Chat composer width CSS', () => {
  it('keeps started General Chat composer shells on the modern width', () => {
    const css = readCss()
    const rootBlock = cssBlockStartingAt(css, '.app-transcript {')
    const globalStartedBlock = cssBlockStartingAt(
      css,
      '.app-transcript.chat-scope-global:not(.welcome-mode) {'
    )

    expect(rootBlock).toContain('--composer-content-max-width: 850px')
    expect(globalStartedBlock).not.toContain('--composer-content-max-width')
  })

  it('keeps popout and multiview composer shells on the same cap', () => {
    const popoutCss = readCss('src/renderer/src/assets/css/03-composer-welcome-activity.css')
    const multiviewCss = readCss('src/renderer/src/assets/css/14-multiview.css')

    expect(popoutCss).toContain('--composer-content-max-width: min(850px, calc(100vw - 32px))')
    expect(multiviewCss).toContain('--composer-content-max-width: min(850px, calc(100% - 28px))')
  })

  it('keeps Codex and Grok tucked rows narrower than the composer cap', () => {
    // Settings' composer preview no longer mirrors the tucked-tab width in its
    // own CSS: it renders a first-class composer preview reusing the real
    // composer/transcript (which carries the cap), so 04-settings-controls.css
    // dropped its bespoke `tuckedWidth` block. This test now covers only the
    // live Codex + Grok tucked rows.
    const codexCss = readCss('src/renderer/src/assets/css/08-theme-picker-overrides.css')
    const grokCss = readCss('src/renderer/src/assets/css/10-provider-shell-overrides.css')
    const tuckedWidth = 'min(calc(100% - 80px), calc(var(--composer-content-max-width, 850px) - 80px))'
    const staleFallback = 'calc(var(--composer-content-max-width, 980px) - 80px)'

    expect(literalMatchCount(codexCss, tuckedWidth)).toBe(4)
    expect(literalMatchCount(grokCss, tuckedWidth)).toBe(4)
    expect(codexCss).not.toContain(staleFallback)
    expect(grokCss).not.toContain(staleFallback)
  })

  it('keeps the legacy narrower General Chat reading column scoped to transcript content', () => {
    const css = readCss()
    const transcriptBlock = cssBlockStartingAt(
      css,
      '.app-transcript.chat-scope-global:not(.welcome-mode) .transcript-inner {'
    )

    expect(transcriptBlock).toContain('max-width: min(100%, 760px)')
  })
})
