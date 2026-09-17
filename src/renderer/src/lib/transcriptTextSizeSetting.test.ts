import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimatedHeightFor } from './TranscriptVirtualWindow'
import {
  transcriptLayoutEpochKeySuffix,
  transcriptLayoutScales,
  type TranscriptLayoutEpoch
} from './transcriptLayoutEpoch'
import {
  DEFAULT_TRANSCRIPT_TEXT_SIZE,
  TRANSCRIPT_FONT_SCALE_PROPERTY,
  TRANSCRIPT_TEXT_SCALES,
  resolveTranscriptTextSize,
  transcriptFontScaleStyle,
  transcriptTextScale,
  type TranscriptTextSize
} from './transcriptTextSize'
import { TRANSCRIPT_TEXT_SIZE_OPTIONS } from '../components/settings/settingsUiOptions'

/**
 * Settings → Appearance → "Transcript text size".
 *
 * TWO jobs, and the first is the reason this file is long.
 *
 * 1. THE DESYNC. A text scale is the first transcript setting that both CSS and
 *    JS have to agree on a NUMBER for: the stylesheet renders the text at it,
 *    and `TranscriptLayoutEpoch.fontScale` calibrates every height estimate,
 *    the pre-paint measure pass and every height-cache key for it. Two numbers
 *    that merely agree is the defect class the layout-epoch seam was just
 *    repaired from — a cache key carrying a MEASURED bucket while the estimate
 *    used a different one, excused by a comment claiming they were "the same
 *    number". So the guards below do not check that two numbers match; they
 *    check that there is only ever ONE number: one resolution, in one `const`,
 *    read by both consumers, with a numeric literal on either consumer line
 *    treated as the failure.
 *
 * 2. THE CHAIN. Almost every registry a new appearance key joins FAILS OPEN —
 *    `SETTINGS_PATCH_KEYS` drops an unlisted key with a bare `continue`,
 *    `rendererAppearanceSettings` returns through an `as AppSettings` cast, and
 *    both memo comparators are hand-written `unknown`-typed equality chains.
 *    Nothing enumerates any of them, so these guards are the coverage.
 *
 * No jsdom here (these suites are `renderToStaticMarkup`), so CSS is asserted by
 * reading the stylesheet and wiring by source string. Every negative sits in a
 * test that also asserts a positive over the same slice, so a renamed selector
 * or a misread file cannot pass as an empty result.
 */
const RENDERER_SRC = join(__dirname, '..')
const MAIN_SRC = join(__dirname, '../../../main')
const CSS_DIR = join(RENDERER_SRC, 'assets/css')

function renderer(relative: string): string {
  return readFileSync(join(RENDERER_SRC, relative), 'utf8')
}

function main(relative: string): string {
  return readFileSync(join(MAIN_SRC, relative), 'utf8')
}

function stripComments(css: string): string {
  // CSS comments carry the same class names and the same custom properties as
  // the rules do, so an inventory built without this counts prose as ownership.
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

type CssRule = { file: string; selector: string; body: string }

function rulesOf(file: string, css: string): CssRule[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    file,
    selector: match[1].replace(/\s+/g, ' ').trim(),
    body: match[2].replace(/\s+/g, ' ').trim()
  }))
}

/** Every renderer stylesheet — the shards plus the token sheet. */
function allCssRules(): CssRule[] {
  const rules: CssRule[] = []
  for (const name of readdirSync(CSS_DIR).sort()) {
    if (!name.endsWith('.css')) continue
    rules.push(...rulesOf(name, readFileSync(join(CSS_DIR, name), 'utf8')))
  }
  rules.push(...rulesOf('theme.css', readFileSync(join(RENDERER_SRC, 'styles/theme.css'), 'utf8')))
  return rules
}

/** The source of `const <identifier> = ...`, up to the next top-level `const`,
 * so a multi-line initialiser is read whole rather than truncated at its first
 * newline — a one-line read would silently exempt everything below it. */
function declarationOf(source: string, identifier: string): string {
  const at = source.indexOf(`const ${identifier} =`)
  expect(at, `no declaration of ${identifier}`).toBeGreaterThan(-1)
  const end = source.indexOf('\n    const ', at + 1)
  expect(end, `unterminated declaration of ${identifier}`).toBeGreaterThan(at)
  return source.slice(at, end)
}

/** Executable source only. A negative about what a function DOES must not be
 * satisfiable — or defeated — by what its comments SAY. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const PANEL = renderer('components/TranscriptPanel.tsx')
const PANEL_CODE = withoutComments(PANEL)

describe('one size name, one number', () => {
  it('resolves absence and junk to the size everything was calibrated at', () => {
    expect(resolveTranscriptTextSize(undefined)).toBe(DEFAULT_TRANSCRIPT_TEXT_SIZE)
    expect(resolveTranscriptTextSize(null)).toBe(DEFAULT_TRANSCRIPT_TEXT_SIZE)
    expect(resolveTranscriptTextSize('huge')).toBe(DEFAULT_TRANSCRIPT_TEXT_SIZE)
    expect(resolveTranscriptTextSize(1.25)).toBe(DEFAULT_TRANSCRIPT_TEXT_SIZE)
    expect(resolveTranscriptTextSize('small')).toBe('small')
    expect(resolveTranscriptTextSize('large')).toBe('large')
  })

  it('keeps the three scales the user decided, as exact literals', () => {
    // Literal, and not re-derived from the record under test. A percentage, a
    // `100 / 100` or a parsed string could land on 0.9999999999, and Default
    // stops being byte-identical the moment `fontScale === 1` is false.
    expect(transcriptTextScale('small')).toBe(0.85)
    expect(transcriptTextScale('default')).toBe(1)
    expect(transcriptTextScale('large')).toBe(1.25)
    expect(Object.is(transcriptTextScale(undefined), 1)).toBe(true)
  })

  it('offers exactly the three sizes, each naming its own scale', () => {
    // The per-array roster assertion the discovery suite cannot write for us:
    // it only enforces unique values and non-empty labels.
    expect(TRANSCRIPT_TEXT_SIZE_OPTIONS.map((option) => option.value)).toEqual([
      'small',
      'default',
      'large'
    ])
    for (const option of TRANSCRIPT_TEXT_SIZE_OPTIONS) {
      expect(option.scale, option.value).toBe(transcriptTextScale(option.value))
      expect(option.helper.length).toBeGreaterThan(0)
    }
  })
})

describe('the CSS number and the epoch number are the same number', () => {
  it('resolves the size exactly once in the panel, and never to a literal', () => {
    // THE structural guard. Both consumers read one local; a second resolution,
    // or a number typed on either consumer's line, is what a desync looks like
    // before it looks like anything else.
    expect(PANEL.split('transcriptTextScale(').length - 1).toBe(1)

    const scaleSource = declarationOf(PANEL, 'transcriptLayoutFontScale')
    expect(scaleSource).toContain('transcriptTextScale(transcriptTextSize)')
    expect(scaleSource, 'the scale must come from the catalogue, not a literal').not.toMatch(
      /[0-9]/
    )

    const styleSource = declarationOf(PANEL, 'transcriptFontScaleVariables')
    expect(styleSource).toContain('transcriptFontScaleStyle(transcriptLayoutFontScale)')
    expect(styleSource, 'the stamped scale must be the epoch scale, not a literal').not.toMatch(
      /[0-9]/
    )

    // And the epoch is minted from that same local. (Its memoisation is pinned
    // separately, by TranscriptLayoutEpochPlumbing.test.ts.)
    const mintAt = PANEL.indexOf('const transcriptLayoutEpoch = useMemo<TranscriptLayoutEpoch>(')
    expect(mintAt).toBeGreaterThan(-1)
    // COMMENT-STRIPPED. Read from the raw file, `valueOf` below lands on a
    // comment that merely mentions `fontScale:` and returns the identifier from
    // the prose while the real mint does arithmetic — the exactness this block
    // is named for, defeated by a one-line decoy.
    const mint = PANEL_CODE.slice(
      PANEL_CODE.indexOf('const transcriptLayoutEpoch = useMemo<TranscriptLayoutEpoch>('),
      PANEL_CODE.indexOf('const projectedRows =')
    )

    // EXACT, not `toContain`. A containment check on `fontScale:
    // transcriptLayoutFontScale` is a strict PREFIX of every arithmetic form —
    // `* 0.96`, `+ osAccessibilityBump`, `* transcriptLayoutFontScale` — so it
    // passes while the epoch carries a different number from the one the CSS
    // stamps. That is the whole invariant this describe() block is named for,
    // and it is the one consumer that reaches estimatedHeightFor,
    // measurementKey and geometryKey. A digit guard alone is not enough
    // either: squaring the identifier is digit-free and reads like a fix,
    // because the epoch module documents `content` as fontScale squared.
    const valueOf = (key: string): string => {
      const at = mint.indexOf(`${key}:`)
      expect(at, `the epoch must mint a ${key}`).toBeGreaterThan(-1)
      const rest = mint.slice(at + key.length + 1)
      const end = Math.min(
        ...[',', '}'].map((token) => {
          const index = rest.indexOf(token)
          return index === -1 ? rest.length : index
        })
      )
      return rest.slice(0, end).trim()
    }
    expect(valueOf('fontScale'), 'the epoch fontScale must be the panel local, untouched').toBe(
      'transcriptLayoutFontScale'
    )
    expect(valueOf('widthBucket'), 'the epoch widthBucket must be the panel local, untouched').toBe(
      'transcriptLayoutWidthBucket'
    )
  })

  it('stamps that local on the element the transcript stylesheets scope to', () => {
    const at = PANEL.indexOf('className={`transcript-inner${')
    expect(at).toBeGreaterThan(-1)
    // Anchored to the element's own attribute list, not searched loose over a
    // ~7,700-line file: an unanchored match passes with the style prop moved to
    // any other element, which is the bug shape the Default-view slice shipped.
    const element = PANEL.slice(at, PANEL.indexOf('>', at))
    expect(element).toContain('style={transcriptFontScaleVariables}')
    expect(element).toContain('ref={contentRef}')
  })

  it('emits no style attribute at Default, and the exact scale otherwise', () => {
    // `undefined` is what keeps the markup byte-identical: React writes no
    // attribute at all, and `var(--transcript-font-scale, 1)` falls back.
    expect(transcriptFontScaleStyle(transcriptTextScale('default'))).toBeUndefined()
    for (const size of ['small', 'large'] as const) {
      const style = transcriptFontScaleStyle(transcriptTextScale(size))
      expect(style, size).not.toBeUndefined()
      expect((style as Record<string, string>)[TRANSCRIPT_FONT_SCALE_PROPERTY], size).toBe(
        String(transcriptTextScale(size))
      )
    }
  })

  it('renders at the very number the estimator is calibrated for', () => {
    // The invariant stated as arithmetic: whatever string CSS is handed, parsed
    // back, IS the chrome multiplier the epoch resolves to. Table-driven over
    // the catalogue so a fourth size inherits it.
    for (const option of TRANSCRIPT_TEXT_SIZE_OPTIONS) {
      const scale = transcriptTextScale(option.value)
      const epoch: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: scale }
      const style = transcriptFontScaleStyle(scale) as Record<string, string> | undefined
      const rendered = style ? Number(style[TRANSCRIPT_FONT_SCALE_PROPERTY]) : 1
      expect(rendered, option.value).toBe(transcriptLayoutScales(epoch).chrome)
      expect(rendered, option.value).toBe(scale)
    }
    // Positive control: the sizes really are different, so the equality above
    // is three distinct agreements and not one number compared with itself.
    expect(new Set(TRANSCRIPT_TEXT_SIZE_OPTIONS.map((option) => option.scale)).size).toBe(3)
  })

  it('is NOT delivered through applyToDocument, which is the main window only', () => {
    // A `:root` stamp is the anti-pattern here: it puts the number the DOM
    // renders at in a different module and a different call stack from the
    // number the estimator uses, and it never reaches a popped-out chat.
    const hook = renderer('hooks/useAppearance.ts')
    const at = hook.indexOf('const applyToDocument = useCallback(')
    expect(at).toBeGreaterThan(-1)
    const body = withoutComments(hook.slice(at, hook.indexOf('\n  }, [])', at)))
    // Positive control: this really is the stamping function, and it really
    // does stamp the OTHER transcript typography setting.
    expect(body).toContain(
      "root.style.setProperty('--transcript-font-family', transcriptFontFamily)"
    )
    expect(body).not.toContain(TRANSCRIPT_FONT_SCALE_PROPERTY)
    expect(body).not.toContain('transcriptTextSize')
  })

  it('has the stylesheet read the property name the module exports', () => {
    // Renaming one side of a custom property is invisible to TypeScript and to
    // the browser alike: the `, 1` fallback makes every size look right at
    // Default and frozen everywhere else.
    const transcript = readFileSync(join(CSS_DIR, '02-transcript-messages-fx.css'), 'utf8')
    expect(transcript).toContain(`var(${TRANSCRIPT_FONT_SCALE_PROPERTY}, 1)`)
  })
})

describe('the scale is scoped to transcript message text', () => {
  it('redefines the four size tokens on .transcript-inner and nowhere else', () => {
    const scaled = allCssRules().filter((rule) =>
      rule.body.includes(`--font-size-md: calc(var(--font-size-md-base) * var(`)
    )
    // The owning selector, named — not merely "the string appears in the file".
    expect(scaled.map((rule) => `${rule.file} ${rule.selector}`)).toEqual([
      '02-transcript-messages-fx.css .transcript-inner'
    ])
    const owner = scaled[0]
    for (const token of ['xs', 'sm', 'md', 'lg']) {
      const declaration = `--font-size-${token}: calc(var(--font-size-${token}-base) * var(${TRANSCRIPT_FONT_SCALE_PROPERTY}, 1))`
      expect(owner.body, token).toContain(declaration)
      // EXACTLY ONCE, and it must be the only declaration of that token in the
      // rule. CSS is last-wins within a block, so appending a second
      // `--font-size-md: …* 1.1` below the correct one silently overrides it at
      // EVERY size — including Default, which voids the byte-identity
      // guarantee — while a `toContain` check keeps matching the first,
      // still-present, no-longer-effective declaration.
      expect(
        owner.body.split(`--font-size-${token}:`).length - 1,
        `--font-size-${token} must be declared exactly once; CSS is last-wins`
      ).toBe(1)
    }
    // Positive control: this is the real capped column rule, not a decoy.
    //
    // Whitespace-collapsed and matched EXACTLY rather than by containment, and
    // asserted to be the rule's ONLY `max-width`. Transcript Width turned this
    // single declaration into a three-term fallback chain (choice -> pane
    // ceiling -> composer cap), and the way that goes wrong is a SECOND
    // `max-width` appended by a more specific rule while a `toContain` keeps
    // matching this one. Whose terms they are and what each resolves to belongs
    // to `transcriptWidthSetting.test.ts`; all this control claims is that the
    // rule carrying the four scaled font tokens is the same rule that caps the
    // column.
    const squashed = owner.body.replace(/\s+/g, '')
    expect(squashed).toContain(
      'max-width:min(100%,var(--transcript-column-max-width,var(--transcript-pane-max-width,var(--composer-content-max-width))));'
    )
    expect(
      squashed.split('max-width:').length - 1,
      'the column rule must declare max-width exactly once; CSS is last-wins'
    ).toBe(1)
  })

  it('keeps it off the pane wrapper, the scroller and the root', () => {
    // `.app-transcript` CONTAINS the composer (Composer.tsx closes on it), so a
    // scale there would move the user's own text box and the reserved height
    // the transcript pads against. `.transcript-scroll` would take the
    // external-provider import banner. `:root` would resize Settings, every
    // popover and every modal while leaving the sidebar — which re-declares
    // these four tokens against its own literals — untouched.
    const reading = allCssRules().filter((rule) =>
      rule.body.includes(TRANSCRIPT_FONT_SCALE_PROPERTY)
    )
    // Positive control: the inventory is populated before the negative means
    // anything, and it is the transcript column plus the markdown headings.
    expect(reading.length).toBeGreaterThan(1)
    expect(reading.map((rule) => rule.selector)).toContain('.transcript-inner')
    for (const rule of reading) {
      for (const forbidden of [
        '.app-transcript',
        '.transcript-scroll',
        ':root {',
        '.app-sidebar'
      ]) {
        expect(`${rule.selector} {`.includes(forbidden), `${rule.file} ${rule.selector}`).toBe(
          false
        )
      }
    }
    // Nothing may DECLARE the property in CSS: its only writer is the panel's
    // inline style, which is what makes it the same number as the epoch's.
    //
    // Whitespace-tolerant. CSS permits `--transcript-font-scale : 1.1`, and a
    // literal `PROPERTY:` filter misses that spelling entirely — a hard-pinned
    // scale on any selector outside the forbidden list above would then be
    // invisible to the whole suite while every message rendered at a size the
    // estimator knows nothing about.
    const declarers = allCssRules().filter((rule) =>
      new RegExp(`${TRANSCRIPT_FONT_SCALE_PROPERTY}\\s*:`).test(rule.body)
    )
    expect(declarers.map((rule) => `${rule.file} ${rule.selector}`)).toEqual([])
    // Positive control for the regex itself: it must match the ordinary
    // spelling, or the emptiness above means only that nothing was tested.
    expect(
      new RegExp(`${TRANSCRIPT_FONT_SCALE_PROPERTY}\\s*:`).test(
        `.x { ${TRANSCRIPT_FONT_SCALE_PROPERTY}: 1.1 }`
      )
    ).toBe(true)
    expect(
      new RegExp(`${TRANSCRIPT_FONT_SCALE_PROPERTY}\\s*:`).test(
        `.x { ${TRANSCRIPT_FONT_SCALE_PROPERTY} : 1.1 }`
      )
    ).toBe(true)
  })

  it('leaves :root composing the four tokens at exactly 1', () => {
    const theme = allCssRules().filter(
      (rule) => rule.file === 'theme.css' && rule.selector === ':root'
    )
    expect(theme.length).toBeGreaterThan(0)
    const body = theme.map((rule) => rule.body).join(' ')
    for (const [token, base] of [
      ['xs', '0.936rem'],
      ['sm', '1.066rem'],
      ['md', '1.196rem'],
      ['lg', '1.365rem']
    ]) {
      expect(body, token).toContain(`--font-size-${token}-base: ${base};`)
      // `* 1`, byte for byte what these declarations always carried, so every
      // computed value outside the transcript is unchanged by the extraction.
      expect(body, token).toContain(
        `--font-size-${token}: calc(var(--font-size-${token}-base) * 1)`
      )
    }
  })

  it('scales markdown headings with the body, so Large cannot invert them', () => {
    // These six are bare rem and load AFTER the token-based heading rule, so
    // they win inside a message body. Unscaled, `--font-size-md` at 1.25 is
    // 1.495rem and an assistant reply's H1 (1.42rem) renders SMALLER than its
    // own paragraphs — the one visible defect of this setting.
    const polish = readFileSync(join(CSS_DIR, '05-polish-fx-layouts.css'), 'utf8')
    const headings = rulesOf('05-polish-fx-layouts.css', polish).filter(
      (rule) =>
        rule.selector.includes('.message-markdown-pro h') && rule.body.includes('font-size:')
    )
    expect(headings.map((rule) => rule.selector)).toEqual([
      '.message-markdown-pro h1',
      '.message-markdown-pro h2',
      '.message-markdown-pro h3',
      '.message-markdown-pro h4, .message-markdown-pro h5, .message-markdown-pro h6'
    ])
    const bases: number[] = []
    for (const rule of headings) {
      const match = /font-size: calc\(([0-9.]+)rem \* var\(--transcript-font-scale, 1\)\);/.exec(
        rule.body
      )
      expect(match, rule.selector).not.toBeNull()
      bases.push(Number((match as RegExpExecArray)[1]))
    }
    // Every heading carries the SAME multiplier as the body text, so today's
    // hierarchy — h1 above body, h3/h4-h6 already below it — is preserved at
    // every size rather than re-ranked by one of them.
    expect(bases).toEqual([1.42, 1.22, 1.08, 1])
    expect(bases[0]).toBeGreaterThan(1.196)
  })
})

describe('Default stays byte-identical', () => {
  it('produces the identity scales and an EMPTY cache-key suffix', () => {
    const epoch: TranscriptLayoutEpoch = {
      widthBucket: 0,
      fontScale: transcriptTextScale(DEFAULT_TRANSCRIPT_TEXT_SIZE)
    }
    expect(transcriptLayoutScales(epoch)).toEqual({ content: 1, chrome: 1 })
    // Empty means every `measurementKey` / `geometryKey` in the app is the same
    // string it was before this setting existed.
    expect(transcriptLayoutEpochKeySuffix(epoch)).toBe('')
    // Control: a size that is NOT Default does move the suffix, so the empty
    // string above is a property of Default rather than of the function.
    expect(
      transcriptLayoutEpochKeySuffix({ widthBucket: 0, fontScale: transcriptTextScale('large') })
    ).toBe('|w0f1.25')
  })

  it('leaves every estimate at its pre-setting value', () => {
    // Literals, from the goldens' provenance — nothing here re-derives an
    // expectation from the constants it is pinning.
    const epoch: TranscriptLayoutEpoch = {
      widthBucket: 0,
      fontScale: transcriptTextScale(DEFAULT_TRANSCRIPT_TEXT_SIZE)
    }
    expect(estimatedHeightFor('assistant', false, 2000, false, epoch)).toBe(840)
    expect(estimatedHeightFor('fanoutResult', false, 100000, false, epoch)).toBe(360)
    expect(estimatedHeightFor('user', true, 0, false, epoch)).toBe(
      estimatedHeightFor('user', true, 0)
    )
  })
})

describe('Large is the first size that exercises the clamped-furniture floor', () => {
  it('lets a clamped row estimate above the 360 ceiling, but only to its furniture', () => {
    // `fanoutResult` (320) and `threadMessage` (300) both scale PAST the
    // viewport-clamped ceiling at 1.25; `return` (280 -> 350) does not. Before
    // the floor, `Math.min(360, ...)` returned a flat 360 for all three at every
    // content length — chrome scaling silently dead and the estimate pinned
    // BELOW the row's own header. Large is the first shipped setting that
    // reaches that, so these three numbers are the end-to-end proof the repair
    // is live rather than dormant.
    const large: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: transcriptTextScale('large') }
    const atLarge = (rowType: 'fanoutResult' | 'threadMessage' | 'return'): number =>
      estimatedHeightFor(rowType, false, 100000, false, large)
    expect(atLarge('fanoutResult')).toBe(400)
    expect(atLarge('threadMessage')).toBe(375)
    expect(atLarge('return')).toBe(360)
    // The SHAPE a bare ceiling cannot produce: under `Math.min(360, ...)` all
    // three collapse to the same 360, so THREE distinct values is the assertion
    // the pre-repair estimator cannot satisfy at any content length.
    expect(
      new Set([atLarge('fanoutResult'), atLarge('threadMessage'), atLarge('return')]).size
    ).toBe(3)
    expect(atLarge('fanoutResult')).toBeGreaterThan(
      estimatedHeightFor('fanoutResult', false, 100000)
    )
  })

  it('does not claim Small covers it', () => {
    // 320 * 0.85 = 272, under the ceiling, so every clamped type is unchanged.
    // Worth pinning: "we shipped three sizes" is not "three sizes exercise the
    // fix", and only Large does.
    const small: TranscriptLayoutEpoch = { widthBucket: 0, fontScale: transcriptTextScale('small') }
    for (const rowType of ['fanoutResult', 'threadMessage', 'return'] as const) {
      expect(estimatedHeightFor(rowType, false, 100000, false, small), rowType).toBe(360)
    }
  })
})

describe('the size reaches every transcript', () => {
  it('is threaded into the panel by a prop that carries the NAME', () => {
    expect(PANEL).toContain('transcriptTextSize?: TranscriptTextSize')
    expect(PANEL).toContain('\n    transcriptTextSize,\n')
  })

  it('reaches the main pane, the side chat and the settings panel', () => {
    const layout = renderer('app/views/MainAppLayout.tsx')
    expect(layout.split('transcriptTextSize={appearance.transcriptTextSize}').length - 1).toBe(3)
  })

  it('reaches a multiview pane through the builder and the pane props', () => {
    const app = renderer('App.tsx')
    // Anchored to the tag. Unanchored, this passes with the prop moved to any
    // other element in a ~32,000-line file while every multiview pane renders
    // the wrong size — and the comparator cannot catch that either, because it
    // compares two undefineds equal.
    const paneAt = app.indexOf('<ChatViewPane')
    expect(paneAt).toBeGreaterThan(-1)
    const paneTag = app.slice(paneAt, app.indexOf('/>', paneAt))
    expect(paneTag).toContain('transcriptTextSize={appearance.transcriptTextSize}')
    const builder = renderer('lib/buildChatViewProps.ts')
    expect(builder).toContain("transcriptTextSize?: TranscriptPanelProps['transcriptTextSize']")
    // The output forward is the silent half: the target prop is optional, so
    // declaring the input field alone compiles and drops the value.
    //
    // Comments STRIPPED and the value matched EXACTLY. `toContain` over the raw
    // file passes when the line is merely commented out — the prop is optional,
    // so typecheck stays silent too, and every Multiview pane quietly falls
    // back to Default while the main pane resizes. Deleting the line reds;
    // disabling it did not. An exact match also rejects the inert
    // `transcriptTextSize: undefined` spelling.
    const forward = withoutComments(builder)
    const forwardAt = forward.indexOf('transcriptTextSize:')
    expect(forwardAt, 'the builder must forward the size').toBeGreaterThan(-1)
    const forwarded = forward.slice(forwardAt + 'transcriptTextSize:'.length)
    expect(forwarded.slice(0, forwarded.indexOf(',')).trim()).toBe('input.transcriptTextSize')
  })

  it('is compared by BOTH hand-written memo chains', () => {
    // Neither is compile-caught: the panel comparable is structurally
    // `unknown`, and the pane prop is inherited from the builder's input type.
    const memo = renderer('lib/transcriptPanelMemoProps.ts')
    expect(memo).toContain('transcriptTextSize?: unknown')
    expect(memo).toContain('previous.transcriptTextSize === next.transcriptTextSize &&')
    const pane = renderer('components/ChatViewPane.tsx')
    expect(pane).toContain('a.transcriptTextSize === b.transcriptTextSize &&')
  })

  it('is declared on the appearance union MainAppLayout picks from', () => {
    const types = renderer('app/views/MainAppLayout.types.ts')
    expect(types).toContain("| 'transcriptTextSize'\n")
  })
})

describe('the write path persists the choice', () => {
  it('gives the key its own block in handleSettingsChange', () => {
    // No spread in that function: every key is its own `if`, and a missing one
    // compiles and simply never persists.
    const app = renderer('App.tsx')
    const at = app.indexOf('if (next.transcriptTextSize !== undefined) {')
    expect(at).toBeGreaterThan(-1)
    const block = app.slice(at, app.indexOf('\n    }', at))
    // Newline terminator: the bare assignment is a PREFIX of longer forms, and
    // the prefix-only form shipped as a real bug in an earlier slice here.
    expect(withoutComments(block)).toContain(
      'settingsPatch.transcriptTextSize = next.transcriptTextSize\n'
    )
    expect(block).toContain('appearance.update({ transcriptTextSize: next.transcriptTextSize })')
  })

  it('is declared on the update type App actually receives', () => {
    // SettingsPanel's own `onChange` literal is a separate hand-written copy, so
    // adding the key there alone compiles while the value never reaches App.
    expect(renderer('lib/settingsPanelUpdate.ts')).toContain(
      "transcriptTextSize?: AppSettings['transcriptTextSize']"
    )
  })

  it('joins all four useAppearance lists it has to join', () => {
    const hook = renderer('hooks/useAppearance.ts')
    // Interface + initial state are compile-caught (the field is REQUIRED on
    // AppearanceState); hydrate and persist are silent when missed.
    expect(hook).toContain('transcriptTextSize: TranscriptTextSize\n')
    expect(hook).toContain('transcriptTextSize: DEFAULT_TRANSCRIPT_TEXT_SIZE,')
    // Hydrate: missed, `...prev` retains the mount default and the stored size
    // never loads — "works until I restart the app". Comments stripped: with
    // the raw file, commenting this line out leaves the guard green and
    // produces exactly that symptom.
    expect(withoutComments(hook)).toContain(
      'transcriptTextSize: resolveTranscriptTextSize(settings.transcriptTextSize),'
    )
    // Persist: anchored on the literal's FIRST key, because the hydrate path
    // issues its own one-key `updateSettings` earlier in the file.
    const persistAt = hook.indexOf('.updateSettings({\n            appearanceMode: next.mode,')
    expect(persistAt).toBeGreaterThan(-1)
    const persistEnd = hook.indexOf('\n          })', persistAt)
    expect(persistEnd).toBeGreaterThan(persistAt)
    expect(withoutComments(hook.slice(persistAt, persistEnd))).toContain(
      'transcriptTextSize: next.transcriptTextSize,'
    )
  })
})

describe('the Appearance control', () => {
  it('sits after Default transcript view and reads the shared catalogue', () => {
    const panel = renderer('components/SettingsPanel.tsx')
    const viewAt = panel.indexOf(
      '<span className="settings-field-label">Default transcript view</span>'
    )
    const sizeAt = panel.indexOf(
      '<span className="settings-field-label">Transcript text size</span>'
    )
    expect(viewAt).toBeGreaterThan(-1)
    expect(sizeAt).toBeGreaterThan(viewAt)
    // Adjacent, extending the Fan-out lanes -> Default transcript view chain the
    // sibling suite pins, rather than merely "somewhere below".
    expect(panel.slice(viewAt + 1, sizeAt)).not.toContain('<span className="settings-field-label">')
    const control = panel.slice(sizeAt, panel.indexOf('</label>', sizeAt))
    expect(control).toContain('value={resolveTranscriptTextSize(transcriptTextSize)}')
    expect(control).toContain(
      'onChange({ transcriptTextSize: e.target.value as TranscriptTextSize })'
    )
    expect(control).toContain('TRANSCRIPT_TEXT_SIZE_OPTIONS.map(')
    // The catalogue exists so the control cannot describe a size the transcript
    // does not render at; the positive above proves it is referenced.
    expect(control).not.toContain('Fits more of the conversation')
  })

  it('declares the prop on BOTH hand-written prop shapes in that file', () => {
    // The read path (interface) and the write path (the separate `onChange`
    // literal) are independent copies: one alone compiles green.
    const panel = renderer('components/SettingsPanel.tsx')
    expect(panel).toContain('\n  transcriptTextSize?: TranscriptTextSize\n')
    expect(panel).toContain('\n    transcriptTextSize?: TranscriptTextSize\n')
    expect(panel).toContain('\n  transcriptTextSize,\n')
  })
})

describe('the main-process half', () => {
  it('declares the field optional and leaves it out of defaultSettings', () => {
    // Absence IS the contract: a value in defaultSettings would give every
    // install an explicit pin that beats a later user choice.
    const types = main('store/types.ts')
    expect(types).toContain('transcriptTextSize?: TranscriptTextSize\n')
    const store = main('store/index.ts')
    const at = store.indexOf('const defaultSettings: AppSettings = {')
    expect(at).toBeGreaterThan(-1)
    const literal = store.slice(at, store.indexOf('\n}', at))
    // Control: this really is the defaults literal, and it really is populated.
    expect(literal).toContain("promptSurfaceStyle: 'liquid_glass',")
    expect(literal).not.toContain('transcriptTextSize')
  })

  it('is allowlisted for persistence, the only gate there is', () => {
    // Unlisted, `sanitizeSettingsPatch` drops it with a bare `continue` — and
    // it is a `Set<keyof AppSettings>`, so a missing entry is not a type error.
    expect(main('settings/MainSanitizers.ts')).toContain("'transcriptTextSize',")
  })

  it('is forwarded by the only projection popouts and utility windows have', () => {
    // The `as AppSettings` cast at the end of this function is why an omission
    // here never type-errors — a popped-out chat would simply render at another
    // size from the main window, with no error anywhere.
    const handlers = main('ipc/settingsHandlers.ts')
    const at = handlers.indexOf('function rendererAppearanceSettings(')
    expect(at).toBeGreaterThan(-1)
    const projection = handlers.slice(at, handlers.indexOf('} as AppSettings', at))
    expect(projection).toContain('transcriptTextSize: settings.transcriptTextSize,')
    // Control: the projection really is the populated one.
    expect(projection).toContain('defaultTranscriptView: settings.defaultTranscriptView,')
  })
})

describe('the types stay narrow', () => {
  it('names exactly three sizes', () => {
    const sizes: TranscriptTextSize[] = ['small', 'default', 'large']
    expect(Object.keys(TRANSCRIPT_TEXT_SCALES).sort()).toEqual([...sizes].sort())
  })
})
