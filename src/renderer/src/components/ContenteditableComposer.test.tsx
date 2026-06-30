import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { ContenteditableComposer } from './ContenteditableComposer'

/**
 * 1.0.5-C5 — Server-rendered smoke tests for the composer. The
 * component is mostly DOM-side behaviour (selection
 * preservation, paste handling, IME) — those paths need a real
 * browser environment (vitest runs in Node) and are exercised
 * manually + via e2e once the App.tsx integration lands.
 *
 * These tests pin the initial render shape — the HTML produced
 * via `dangerouslySetInnerHTML` from `buildContenteditableHtml`.
 * If a regression breaks the SSR path the integration will fail
 * visibly on mount, so this is the right level for a unit
 * gate.
 */

describe('ContenteditableComposer — initial render', () => {
  it('renders an editable textbox with the right ARIA role + multiline', () => {
    const html = renderToStaticMarkup(<ContenteditableComposer value="" onChange={() => {}} />)
    expect(html).toContain('role="textbox"')
    expect(html).toContain('aria-multiline="true"')
    // React's SSR emits the camelCase attribute name verbatim
    // (it's a known DOM property name); the browser still treats
    // it as contenteditable. The lowercase form would be valid
    // but only matters when serialising for non-React consumers.
    expect(html).toContain('contentEditable="true"')
  })

  it('marks the surface empty when value is empty', () => {
    const html = renderToStaticMarkup(<ContenteditableComposer value="" onChange={() => {}} />)
    expect(html).toContain('data-empty="true"')
    expect(html).toContain('<br>')
  })

  it('marks the surface non-empty when value has content', () => {
    const html = renderToStaticMarkup(<ContenteditableComposer value="hello" onChange={() => {}} />)
    expect(html).toContain('data-empty="false"')
    expect(html).toContain('hello')
  })

  it('escapes the value (no HTML injection)', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer value="<script>alert(1)</script>" onChange={() => {}} />
    )
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)')
  })

  it('renders mentions as spans with data-mention attribute', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer
        value="hi @codex"
        onChange={() => {}}
        mentions={[
          {
            start: 3,
            end: 9,
            data: 'codex',
            className: 'provider-codex'
          }
        ]}
      />
    )
    expect(html).toContain('data-mention="codex"')
    expect(html).toContain('class="provider-codex"')
    expect(html).toContain('@codex')
  })

  it('passes through composerStyle as a data attribute', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer value="hi" onChange={() => {}} composerStyle="claude" />
    )
    expect(html).toContain('data-composer-style="claude"')
  })

  it('reflects placeholder via data attribute (not a real placeholder)', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer value="" onChange={() => {}} placeholder="Type a message…" />
    )
    expect(html).toContain('data-placeholder="Type a message…"')
    expect(html).toContain('aria-label="Type a message…"')
    expect(html).not.toContain('aria-placeholder')
  })

  it('respects disabled by dropping contenteditable + setting aria-disabled', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer value="hi" onChange={() => {}} disabled />
    )
    expect(html).toContain('contentEditable="false"')
    expect(html).toContain('aria-disabled="true"')
  })

  it('applies the composer-textarea class for shared shell styling', () => {
    const html = renderToStaticMarkup(<ContenteditableComposer value="hi" onChange={() => {}} />)
    expect(html).toContain('composer-textarea')
    expect(html).toContain('contenteditable-composer')
  })

  it('applies a custom className alongside the base classes', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer value="hi" onChange={() => {}} className="custom-shell" />
    )
    expect(html).toContain('composer-textarea')
    expect(html).toContain('contenteditable-composer')
    expect(html).toContain('custom-shell')
  })

  it('preserves newlines as <br> in the rendered HTML', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer value="line1\nline2" onChange={() => {}} />
    )
    // Note: backslash-n in source means literal \n in the
    // string; renderToStaticMarkup escapes those as visible
    // characters. We check for the BR conversion path with a
    // real newline in the next test.
    expect(html).toContain('line1')
    expect(html).toContain('line2')
  })

  it('preserves a real newline as <br>', () => {
    const html = renderToStaticMarkup(
      <ContenteditableComposer value={'one\ntwo'} onChange={() => {}} />
    )
    expect(html).toContain('one<br>two')
  })
})
