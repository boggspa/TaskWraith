import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DailyActivityHeatmap } from './DailyActivityHeatmap'
import type { DailyUsageDays } from '../../../shared/dailyUsageRollup'

const CSS_PATH = join(__dirname, '..', 'assets', 'css', '02-transcript-messages-fx.css')

function daysWith(entries: Record<string, Record<string, [number, number]>>): DailyUsageDays {
  const out: DailyUsageDays = {}
  for (const [day, providers] of Object.entries(entries)) {
    out[day] = {}
    for (const [provider, [tokens, runs]] of Object.entries(providers)) {
      out[day][provider] = { tokens, runs }
    }
  }
  return out
}

/** Today's key in local time, so a fixture lands inside the rendered window. */
function todayKey(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

describe('DailyActivityHeatmap', () => {
  it('renders the year window with provider filter tabs', () => {
    const html = renderToStaticMarkup(
      <DailyActivityHeatmap
        title="External Activity"
        showProviderFilter
        rollupDays={{}}
        externalRecords={[]}
      />
    )
    for (const label of ['All', 'Codex', 'Claude', 'Gemini', 'Kimi', 'Grok', 'Cursor']) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toContain('External Activity')
    expect(html).toContain('365D')
  })

  it('labels the month axis so a year of columns stays readable', () => {
    const html = renderToStaticMarkup(<DailyActivityHeatmap rollupDays={{}} externalRecords={[]} />)
    expect(html).toContain('daily-heatmap-month-axis')
    expect(html).toContain('daily-heatmap-month-label')
  })

  it('states every provider for a day in the tooltip, not just the winner', () => {
    const html = renderToStaticMarkup(
      <DailyActivityHeatmap
        rollupDays={daysWith({ [todayKey()]: { codex: [900, 3], claude: [100, 1] } })}
        externalRecords={[]}
      />
    )
    // Newlines land as &#x27; escaped entities in the title attribute; assert
    // on the provider fragments rather than the whole formatted block.
    expect(html).toContain('Codex')
    expect(html).toContain('Claude')
    expect(html).toContain('1.0K tokens')
  })

  it('renders padding cells so the first and last weeks stay square', () => {
    const html = renderToStaticMarkup(<DailyActivityHeatmap rollupDays={{}} externalRecords={[]} />)
    expect(html).toContain('data-outside="true"')
  })
})

/*
 * CSS contract. There is no DOM test environment in this repo, so the geometry
 * that keeps a 53-column grid legible is pinned by reading the stylesheet.
 */
describe('daily heatmap CSS contract', () => {
  const css = readFileSync(CSS_PATH, 'utf8')

  function block(selector: string): string {
    const index = css.indexOf(`${selector} {`)
    expect(index, `${selector} missing`).toBeGreaterThan(-1)
    return css.slice(index, css.indexOf('}', index))
  }

  it('uses ONE gutter value for the tiles and the month axis', () => {
    // Two grids over the same tracks. A mismatch walks the labels off their
    // columns by `column * gap / columns` — invisible on the left, a whole
    // tile wide by December.
    expect(block('.daily-heatmap')).toMatch(/--daily-heatmap-gap:/)
    expect(block('.daily-heatmap-grid')).toMatch(/gap:\s*var\(--daily-heatmap-gap\)/)
    expect(block('.daily-heatmap-month-axis')).toMatch(/gap:\s*var\(--daily-heatmap-gap\)/)
  })

  it('keeps the gutter a WHOLE number of pixels', () => {
    // The gutter was `clamp(1px, 0.18cqw, 3px)`, which resolved to ~2.5px, and
    // a fractional gap rounds to 2px on some columns and 3px on others — the
    // grid reads as unevenly paced. Integers keep the rhythm regular.
    const declared = /--daily-heatmap-gap:\s*([^;]+);/.exec(block('.daily-heatmap'))?.[1]?.trim()
    expect(declared).toMatch(/^\d+px$/)
  })

  it('follows the 90-day grid: auto rows anchored by a declared ratio', () => {
    // Both are load-bearing on the sibling and for the same reasons — square
    // cells within the row height, and `1fr` rows that do not collapse.
    const grid = block('.daily-heatmap-grid')
    expect(grid).toMatch(/grid-auto-rows:\s*1fr/)
    expect(grid).toMatch(/aspect-ratio:/)
  })

  it('scrolls wide content inside the wrapper, not the page', () => {
    expect(block('.daily-heatmap-grid-wrapper')).toMatch(/overflow-x:\s*auto/)
  })

  it('keeps padding cells occupying their track', () => {
    // `display: none` here would shear every column after the first week.
    const padding = block(".daily-heatmap-cell[data-outside='true']")
    expect(padding).toMatch(/background:\s*transparent/)
    expect(padding).not.toMatch(/display:\s*none/)
  })
})
