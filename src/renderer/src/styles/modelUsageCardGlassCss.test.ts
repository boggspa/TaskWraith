import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/ModelUsageCard.css'),
  'utf8'
)

const rule = (selector: string): string => {
  const start = css.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  expect(end, `Missing block end: ${selector}`).toBeGreaterThan(start)
  return css.slice(start, end + 1)
}

describe('Model Usage liquid-glass sidebar CSS', () => {
  it('makes the whole pane one 60%-alpha material, including its header', () => {
    const card = rule('.app-sidebar .model-usage-summary--sidebar {')
    const body = rule('.app-sidebar .model-usage-liquid-card {')

    expect(card).toContain('border-radius: 16px;')
    expect(card).toContain('background-color: rgba(7, 19, 34, 0.6);')
    expect(card).toContain('backdrop-filter: blur(22px) saturate(145%) brightness(1.03);')
    expect(body).toContain('background: transparent;')
    expect(body).toContain('border: 0;')
  })

  it('builds a directional rim and neutral refractive sheen around the card', () => {
    const rim = rule('.app-sidebar .model-usage-summary--sidebar::before {')
    const sheen = rule('.app-sidebar .model-usage-summary--sidebar::after {')

    expect(rim).toContain('-webkit-mask-composite: xor;')
    expect(rim).toContain('mask-composite: exclude;')
    expect(sheen).toContain('rgba(255, 255, 255, 0.1)')
    expect(sheen).not.toMatch(/purple|magenta/i)
  })

  it('has opaque Reduce Transparency and pale light-theme fallbacks', () => {
    const reduced = rule("[data-appearance='solid'] .app-sidebar .model-usage-summary--sidebar,")
    const light = rule(":is([data-theme='light'], [data-theme='mist'], [data-theme='sage'])")

    expect(reduced).toContain("[data-reduce-transparency='true']")
    expect(reduced).toContain('backdrop-filter: none;')
    expect(light).toContain('.model-usage-summary--sidebar')
    expect(light).toContain('background-color: rgba(224, 235, 246, 0.6);')
  })

  it('uses fading provider dividers and compact luminous quota meters', () => {
    const divider = rule(
      '.app-sidebar .model-usage-liquid-card .model-usage-item + .model-usage-item::before {'
    )
    const meter = rule('.app-sidebar .model-usage-liquid-card .quota-progress-bar {')
    const meta = rule('.app-sidebar .model-usage-liquid-card .model-usage-window-meta {')

    expect(divider).toContain('linear-gradient(90deg, transparent')
    expect(meter).toContain('height: 5px;')
    expect(meta).toContain('display: none;')
  })

  it('turns the collapsed matrix into subtle glass wells without losing density', () => {
    const grid = rule(
      '.app-sidebar .model-usage-liquid-card .model-usage-compact-grid {'
    )
    const cell = rule('.app-sidebar .model-usage-liquid-card .model-usage-compact-cell {')

    expect(grid).toContain('border-collapse: separate;')
    expect(grid).toContain('border-spacing: 2px 2px;')
    expect(cell).toContain('background: rgba(218, 235, 252, 0.035);')
  })

  it('keeps the resize hit target draggable while hiding its visual grip', () => {
    const handle = rule('.model-usage-resize-handle {')
    const hiddenChrome = rule(
      '.app-sidebar .model-usage-summary--sidebar .model-usage-resize-handle::before,'
    )

    expect(handle).toContain('height: 18px;')
    expect(handle).toContain('cursor: ns-resize;')
    expect(hiddenChrome).toContain('opacity: 0;')
    expect(hiddenChrome).toContain('background: transparent;')
  })

  it('gives spend estimates shallow glass rows with chrome value pills', () => {
    const row = rule('.app-sidebar .model-usage-liquid-card .model-usage-spend-row {')
    const cost = rule('.app-sidebar .model-usage-liquid-card .model-usage-spend-cost {')

    expect(row).toContain('border-radius: 7px;')
    expect(row).toContain('rgba(215, 234, 252, 0.025)')
    expect(cost).toContain('border-radius: 999px;')
  })

  it('keeps context catalogues dense inside provider-level glass wells', () => {
    const rows = rule(
      '.app-sidebar .model-usage-liquid-card .model-usage-item.context-only .model-usage-context-rows {'
    )
    const value = rule('.app-sidebar .model-usage-liquid-card .model-usage-context-window {')

    expect(rows).toContain('border-radius: 9px;')
    expect(rows).toContain('gap: 1px;')
    expect(value).toContain('border-radius: 999px;')
  })
})
