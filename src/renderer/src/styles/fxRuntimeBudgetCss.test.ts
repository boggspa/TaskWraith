import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const cssBlockAfter = (css: string, marker: string, endMarker: string): string => {
  const start = css.indexOf(marker)
  expect(start, `Missing CSS marker: ${marker}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf(endMarker, start)
  expect(end, `Missing CSS end marker: ${endMarker}`).toBeGreaterThan(start)
  return css.slice(start, end)
}

describe('FX runtime compositor budget', () => {
  it('keeps the animated sky root unfiltered and moves its colour grade to the base gradient', () => {
    const transcriptCss = readCss('02-transcript-messages-fx.css')
    const skyRoot = cssBlockAfter(transcriptCss, '.sky-visual-fx {', '/* Static film grain')
    const skyGradient = cssBlockAfter(transcriptCss, '.sky-gradient {', '/* Warm bloom')
    const polishCss = readCss('05-polish-fx-layouts.css')

    expect(skyRoot).toContain('mix-blend-mode: normal;')
    expect(skyRoot).toContain('filter: none;')
    expect(skyRoot).not.toContain('will-change: transform, opacity;')
    expect(skyGradient).toContain('filter: var(--fx-sky-filter')
    expect(polishCss).toContain('[data-fx-mode="cinematic"] .sky-visual-fx .sky-gradient')
    expect(polishCss).toContain('[data-fx-mode="epic"] .sky-visual-fx .sky-gradient')
  })

  it('keeps the fading sky backdrop beneath readable transcript content', () => {
    const transcriptCss = readCss('02-transcript-messages-fx.css')
    const skyRoot = cssBlockAfter(transcriptCss, '.sky-visual-fx {', '/* Static film grain')
    const transcriptScroll = cssBlockAfter(
      transcriptCss,
      '.transcript-scroll {',
      '/* Gemini terminal docks below the composer'
    )

    expect(skyRoot).toContain('z-index: 2;')
    expect(transcriptScroll).toContain('z-index: 3;')
  })

  it('uses opacity-based telemetry signals and pauses inactive telemetry history', () => {
    const polishCss = readCss('05-polish-fx-layouts.css')
    const runDataViz = cssBlockAfter(
      polishCss,
      '.run-data-viz-layer {',
      ':is(.composer-surface, .composer-above-bar-stack).fx-agent-aura {'
    )

    expect(runDataViz).toContain('mix-blend-mode: normal;')
    expect(runDataViz).toContain('animation: run-data-signal-pulse')
    expect(runDataViz).toContain('animation: none;')
    expect(polishCss).toContain('@keyframes run-data-signal-pulse')
    expect(polishCss).not.toContain('@keyframes run-data-flow')
    expect(polishCss).not.toContain('stroke-dashoffset: -40')
  })
})
