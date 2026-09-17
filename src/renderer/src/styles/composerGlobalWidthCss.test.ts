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

    // Codex dropped to 2: the merged ensemble/roster/queued frame no longer
    // carries the hardcoded 80px tucked width — it derives from the
    // workspace/branch telemetry strip's `--codex-cc-strip-inset` token so
    // both tucked tabs always share one width (the wider strip width). The
    // two remaining literals are the solo CX1 `.composer-above-bar` rule's
    // width + max-width. Grok still owns 4 (solo row + merged stack, each
    // width + max-width).
    expect(literalMatchCount(codexCss, tuckedWidth)).toBe(2)
    expect(literalMatchCount(grokCss, tuckedWidth)).toBe(4)
    expect(codexCss).not.toContain(staleFallback)
    expect(grokCss).not.toContain(staleFallback)
    // The merged frame's width + max-width both derive from the strip inset
    // token (14px fallback), so the frame and the telemetry strip can never
    // drift apart again. The defaults live in shard 08 at the transcript
    // level (the frame renders outside `.composer-surface`), with a
    // side-chat-pane override tracking the strip's halved inset.
    expect(
      literalMatchCount(codexCss, 'calc(100% - (2 * var(--codex-cc-strip-inset, 14px)))')
    ).toBe(2)
    expect(codexCss).toContain(
      '[data-composer-style="codex"] .app-transcript {\n  --codex-cc-strip-inset: 14px;\n}'
    )
    expect(codexCss).toContain('.side-chat-pane.app-transcript')
  })

  it('keeps the legacy narrower General Chat reading column scoped to transcript content', () => {
    const css = readCss()
    const transcriptBlock = cssBlockStartingAt(
      css,
      '.app-transcript.chat-scope-global:not(.welcome-mode) .transcript-inner {'
    )

    // 760px still, and still scoped to transcript content rather than to the
    // shared composer token — but expressed as the PANE TERM of
    // `.transcript-inner`'s single `max-width` instead of as a second
    // `max-width` declaration.
    //
    // That rewrite is the point of the assertion, not incidental to it. As a
    // declaration this rule outranked the base rule on specificity, so the
    // Transcript Width terms added to the base rule would have been inert in
    // General Chat — a shipped control doing nothing in one of the four scopes
    // a transcript renders in, with this suite green because 760px was still
    // there. The negative below is what fails if anyone restores the old shape.
    expect(literalMatchCount(transcriptBlock, '--transcript-pane-max-width: 760px')).toBe(1)
    // Comments STRIPPED before the negative. This rule's comment explains the
    // shape it is NOT allowed to use, and names it — a negative asserted over
    // the raw block is defeated by its own rationale.
    const declarations = transcriptBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '')
    // Anchored to a declaration boundary, not a bare substring: the term this
    // rule is SUPPOSED to set, `--transcript-pane-max-width`, ends in the very
    // text a `toContain('max-width:')` looks for, so the loose form can never
    // distinguish the shape it wants from the shape it forbids.
    const declaresMaxWidth = /(^|[;{])max-width:/
    expect(
      declaresMaxWidth.test(declarations),
      'the narrow reading column must be a TERM, never a second max-width'
    ).toBe(false)
    // Positive control for that negative, in two parts: the matcher really does
    // fire on the exact shape being refused (and is not merely fooled by the
    // custom property), and the stripped slice really is the rule's
    // declarations rather than an empty read that satisfies any negative.
    expect(declaresMaxWidth.test('.x{max-width:min(100%,760px);}')).toBe(true)
    expect(declaresMaxWidth.test('.x{--transcript-pane-max-width:760px;}')).toBe(false)
    expect(declarations).toContain('760px')
  })
})
