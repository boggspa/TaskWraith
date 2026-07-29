import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMPOSER_MARKDOWN_FLAGS } from '../lib/composerMarkdownHighlight'

/**
 * 1.0.5 — machine-checked half of the overlay styling contract.
 *
 * The composer highlight overlay paints spans over glyphs the
 * textarea has already laid out. Any property that changes a glyph's
 * advance width or a line's wrap point desyncs the visible text from
 * the caret — the exact bug class 1.0.4 closed. Prose comments
 * didn't stop `font-weight: 700` from being reintroduced once, so
 * this lint scans the actual CSS: every rule that targets an overlay
 * span class may only use metric-safe paint properties (color,
 * opacity, text-shadow, text-decoration, background, border-radius,
 * filter, …). See the rule block above `.composer-md-marker` in
 * `03-composer-welcome-activity.css`.
 */

const CSS_FILES = [
  '../assets/css/03-composer-welcome-activity.css',
  '../assets/css/09-ensemble-work-session.css',
  '../assets/css/10-provider-shell-overrides.css'
]

/** Span-level classes rendered inside `.composer-textarea-highlight-content`. */
const SPAN_CLASS_MARKERS = [
  '.composer-md-',
  '.composer-mention-token',
  '.composer-ghost-suggestion'
]

/**
 * Everything that moves glyphs or boxes. `border` is banned except
 * `border-radius` / `border-color` (paint-only); `text-decoration*`,
 * `text-shadow`, `text-underline-offset`, `background*`, `color`,
 * `opacity`, and `filter` are allowed by omission.
 */
const BANNED_PROPERTY =
  /(?:^|[;\s])(font(?:-[a-z-]+)?|line-height|letter-spacing|word-spacing|white-space|word-break|line-break|overflow-wrap|hyphens|tab-size|text-indent|text-align|text-transform|text-orientation|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|border(?:-(?!radius\b|color\b)[a-z-]+)?|width|min-width|max-width|height|min-height|max-height|display|position|inset|top|right|bottom|left|float|clear|transform|zoom|rotate|translate|scale|vertical-align|direction|writing-mode|box-sizing|flex(?:-[a-z-]+)?|grid(?:-[a-z-]+)?|gap|content)\s*:/

interface CssRule {
  selector: string
  body: string
  file: string
}

/** Tiny brace-walking extractor; @media wrappers become outer frames
 * whose own (empty) bodies are skipped, leaf rules keep their
 * selectors. Declaration values in this codebase never contain
 * braces, which keeps this honest. */
function extractLeafRules(css: string, file: string): CssRule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  const selectorStack: string[] = []
  let buffer = ''
  for (const ch of stripped) {
    if (ch === '{') {
      selectorStack.push(buffer.trim())
      buffer = ''
    } else if (ch === '}') {
      const selector = selectorStack.pop()
      if (selector && buffer.trim()) rules.push({ selector, body: buffer.trim(), file })
      buffer = ''
    } else {
      buffer += ch
    }
  }
  return rules
}

function loadOverlaySpanRules(): CssRule[] {
  const rules: CssRule[] = []
  for (const relative of CSS_FILES) {
    const css = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    for (const rule of extractLeafRules(css, relative)) {
      if (SPAN_CLASS_MARKERS.some((marker) => rule.selector.includes(marker))) {
        rules.push(rule)
      }
    }
  }
  return rules
}

describe('composer overlay span CSS metric safety', () => {
  const rules = loadOverlaySpanRules()

  it('actually finds the overlay span rules (lint must never be vacuous)', () => {
    expect(rules.length).toBeGreaterThanOrEqual(10)
    const selectors = rules.map((rule) => rule.selector).join('\n')
    expect(selectors).toContain('.composer-md-bold')
    expect(selectors).toContain('.composer-mention-token')
  })

  it('styles every markdown flag the segmenter can emit', () => {
    const selectors = rules.map((rule) => rule.selector).join('\n')
    for (const flag of COMPOSER_MARKDOWN_FLAGS) {
      expect(selectors, `missing CSS for composer-${flag}`).toContain(`composer-${flag}`)
    }
  })

  it('uses only metric-safe paint properties in overlay span rules', () => {
    for (const rule of rules) {
      const match = BANNED_PROPERTY.exec(rule.body)
      expect(
        match,
        `metric-UNSAFE property "${match?.[1]}" in ${rule.file} rule "${rule.selector}" — ` +
          'overlay spans may only use paint properties (color/opacity/text-shadow/' +
          'text-decoration/background/border-radius/filter); anything that shifts ' +
          'advance widths desyncs the caret. See the metric rule in 03-composer CSS.'
      ).toBeNull()
    }
  })
})
