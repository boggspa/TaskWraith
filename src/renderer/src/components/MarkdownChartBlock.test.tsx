import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'
import { MarkdownChartBlock } from './MarkdownChartBlock'
import type { CanvasChartDocument } from '../../../shared/canvasChart'

const VALID_CHART: CanvasChartDocument = {
  schemaVersion: 1,
  title: 'Latency p95',
  kind: 'bar',
  series: [
    {
      id: 'p95',
      label: 'p95 ms',
      points: [
        { x: 'a', y: 10 },
        { x: 'b', y: 20 },
        { x: 'c', y: 15 }
      ]
    }
  ],
  xLabel: 'bucket',
  yLabel: 'ms'
}

describe('MarkdownChartBlock', () => {
  it('renders an SVG chart shell for a valid chart document fence body', () => {
    const html = renderToStaticMarkup(<MarkdownChartBlock content={JSON.stringify(VALID_CHART)} />)

    expect(html).toContain('markdown-chart-block')
    expect(html).toContain('Latency p95')
    expect(html).toMatch(/<svg[\s>]/i)
    expect(html).not.toContain('message-code-shell')
  })

  it('falls back to a code shell with an error caption for invalid JSON', () => {
    const html = renderToStaticMarkup(<MarkdownChartBlock content={'{not-json'} />)

    expect(html).toContain('markdown-chart-error')
    expect(html).toContain('message-code-shell')
    expect(html).not.toContain('markdown-chart-block')
  })

  it('caps the chart viewport height to avoid transcript scroll fatigue', () => {
    const html = renderToStaticMarkup(<MarkdownChartBlock content={JSON.stringify(VALID_CHART)} />)

    expect(html).toMatch(/max-height:\s*280px/)
  })
})

describe('StableMarkdownBlock ```chart fence', () => {
  it('renders a closed chart fence as an inline chart instead of a source code shell', () => {
    const fence = ['```chart', JSON.stringify(VALID_CHART), '```'].join('\n')
    const html = renderToStaticMarkup(<MarkdownMessage content={fence} />)

    expect(html).toContain('markdown-chart-block')
    expect(html).toContain('Latency p95')
    expect(html).toMatch(/<svg[\s>]/i)
    // The chart path must win over the ordinary fenced-code shell.
    expect(html).not.toContain('message-code-language">chart')
  })

  it('falls back to fenced source when the chart JSON is invalid', () => {
    const fence = ['```chart', '{', '```'].join('\n')
    const html = renderToStaticMarkup(<MarkdownMessage content={fence} />)

    expect(html).toContain('markdown-chart-error')
    expect(html).toContain('message-code-shell')
  })
})
