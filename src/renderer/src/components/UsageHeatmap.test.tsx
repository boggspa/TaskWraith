import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageHeatmap } from './UsageHeatmap'
import { HEATMAP_PROVIDER_FILTERS } from '../lib/UsageHeatmap'

describe('UsageHeatmap', () => {
  it('renders provider isolation controls without changing the all-provider chips', () => {
    const html = renderToStaticMarkup(
      <UsageHeatmap title="TaskWraith Activity" dayCount={90} showProviderFilter />
    )

    for (const label of [
      'All',
      'Codex',
      'Claude',
      'Gemini',
      'Kimi',
      'Grok',
      'Cursor',
      'Ollama',
      'AntiGravity',
      'Pi'
    ]) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toContain('TaskWraith Activity')
    expect(html).toContain('TaskWraith Activity all-provider totals')
    expect(html).toContain('90D')
  })
})

/*
 * Header layout contract. The provider filter grows every time a provider
 * ships — 10 tabs once AntiGravity and Pi landed — while the 24h/7D/90D totals
 * do not. The middle grid track was a bare `auto`, which sizes to max-content
 * and never shrinks, so the tabs ran over the totals ("Pi24h 6.16B"). No jsdom
 * in this repo, so pin the CSS contract that keeps the yield order right.
 */
describe('usage heatmap header layout', () => {
  const css = readFileSync(
    new URL('../assets/css/02-transcript-messages-fx.css', import.meta.url),
    'utf8'
  )
  const headerRule =
    css.match(
      /\.usage-heatmap--with-provider-filter\s+\.usage-heatmap-header\s*\{([^}]*)\}/
    )?.[1] ?? ''
  const filterRule = css.match(/\n\.usage-heatmap-provider-filter\s*\{([^}]*)\}/)?.[1] ?? ''

  it('gives the totals a max-content floor so a token number can never be clipped', () => {
    expect(headerRule).toMatch(/grid-template-columns:[^;]*minmax\(max-content,\s*1fr\)/)
  })

  it('lets the provider filter shrink below its content instead of overrunning', () => {
    // A bare `auto` middle track is the regression this whole rule exists to
    // prevent — it cannot shrink, so it pushes into the totals column.
    expect(headerRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*auto\)/)
    expect(headerRule).not.toMatch(/grid-template-columns:[^;]*\s+auto\s+minmax/)
    expect(filterRule).toMatch(/min-width:\s*0/)
  })

  it('scrolls the filter rather than clipping a provider out of reach', () => {
    expect(filterRule).toMatch(/overflow-x:\s*auto/)
    expect(filterRule).not.toMatch(/overflow:\s*hidden/)
    // An always-on edge mask would fade the active tab's own tint at the ends
    // even when nothing overflows — worse than the missing scroll hint.
    expect(filterRule).not.toMatch(/mask-image/)
  })

  it('keeps the three totals on one line as a unit', () => {
    const chipsRule = css.match(/\n\.usage-heatmap-chips\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(chipsRule).toMatch(/flex-wrap:\s*nowrap/)
    expect(chipsRule).toMatch(/white-space:\s*nowrap/)
  })

  it('still has more provider tabs than the row was originally sized for', () => {
    // If this ever drops back to a handful, the tight-fit rules above stop
    // earning their keep and can be simplified — fail loudly rather than
    // leaving dead layout defence behind.
    expect(HEATMAP_PROVIDER_FILTERS.length).toBeGreaterThanOrEqual(9)
  })
})
