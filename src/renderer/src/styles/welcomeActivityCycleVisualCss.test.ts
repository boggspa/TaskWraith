import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const heatmapCss = readFileSync(
  new URL('../assets/css/02-transcript-messages-fx.css', import.meta.url),
  'utf8'
)
const tokenChartCss = readFileSync(
  new URL('../components/TokenUsageChart.css', import.meta.url),
  'utf8'
)
const dailyHeatmapSource = readFileSync(
  new URL('../components/DailyActivityHeatmap.tsx', import.meta.url),
  'utf8'
)
const tokenChartSource = readFileSync(
  new URL('../components/TokenUsageChart.tsx', import.meta.url),
  'utf8'
)

function cssBlock(css: string, selector: string): string {
  const start = css.lastIndexOf(`${selector} {`)
  expect(start, `${selector} missing`).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('\n}', start))
}

describe('Thread Home activity-cycle visual contract', () => {
  it('keeps empty 90-day and yearly cells transparent with a visible rim', () => {
    const ninetyDay = cssBlock(
      heatmapCss,
      '.usage-heatmap--welcome-standalone .usage-heatmap-cell[data-empty="true"]'
    )
    const yearly = cssBlock(
      heatmapCss,
      ".daily-heatmap--welcome-standalone .daily-heatmap-cell[data-empty='true']"
    )

    for (const block of [ninetyDay, yearly]) {
      expect(block).toMatch(/background:\s*transparent/)
      expect(block).toMatch(/border-color:/)
      expect(block).toMatch(/box-shadow:/)
    }
  })

  it('de-pills every welcome-cycle statistic without changing its layout owner', () => {
    const sharedStat = cssBlock(
      heatmapCss,
      ':is(.usage-heatmap--welcome-standalone, .daily-heatmap--welcome-standalone, .token-usage-chart--welcome) .usage-heatmap-chip'
    )

    expect(sharedStat).toMatch(/border:\s*1px/)
    expect(sharedStat).toMatch(/border-radius:\s*4px/)
    expect(sharedStat).toMatch(/background:\s*transparent/)
    expect(sharedStat).toMatch(/font-size:\s*10px/)
    expect(sharedStat).toMatch(/line-height:\s*1/)
    expect(sharedStat).not.toMatch(/min-height:/)
    expect(sharedStat).not.toMatch(/border-radius:\s*999px/)
  })

  it('uses the same compact rim class for daily and token totals', () => {
    expect(dailyHeatmapSource.match(/daily-heatmap-chip usage-heatmap-chip/g)).toHaveLength(2)
    expect(tokenChartSource).toContain('className="token-usage-chart-total usage-heatmap-chip"')
    expect(tokenChartSource).not.toContain(
      '{windowLabel} <strong>{formatTokenCount(data.totalTokens)}</strong> tokens'
    )
    expect(tokenChartCss).not.toContain('.token-usage-chart--welcome .token-usage-chart-total {')
    expect(heatmapCss).not.toContain('.daily-heatmap--welcome-standalone .daily-heatmap-chip {')
  })

  it('retains provider attribution while reducing inactive filter fill', () => {
    const welcomeTreatment = heatmapCss.slice(
      heatmapCss.indexOf('/* Thread Home activity cycle — high-contrast rim treatment.')
    )

    expect(welcomeTreatment).toMatch(
      /\.usage-heatmap-provider-filter-tab\s*\{[\s\S]*?background:\s*transparent/
    )
    expect(welcomeTreatment).toMatch(
      /\.usage-heatmap-provider-filter-tab\[data-active="true"\][\s\S]*?currentColor 58%/
    )
  })

  it('gives provider-coloured token bars a provider-derived rim', () => {
    const bar = cssBlock(tokenChartCss, '.token-usage-chart--welcome .token-usage-chart-bar')

    expect(bar).toMatch(/--token-usage-bar-color/)
    expect(bar).toMatch(/stroke:/)
    expect(bar).toMatch(/vector-effect:\s*non-scaling-stroke/)
  })

  it('does not overlay horizontal guide lines on the existing charts', () => {
    expect(heatmapCss).not.toContain(
      '.usage-heatmap--welcome-standalone .usage-heatmap-grid-wrapper {'
    )
    expect(heatmapCss).not.toContain(
      '.daily-heatmap--welcome-standalone .daily-heatmap-grid-wrapper {'
    )
    expect(tokenChartCss).not.toContain('.token-usage-chart--welcome .token-usage-chart-svg {')
  })
})
