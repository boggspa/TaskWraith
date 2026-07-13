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
  it('keeps the resize shell transparent and gives the selected view its own material', () => {
    const shell = rule('.app-sidebar .model-usage-summary--sidebar {')
    const card = rule('.app-sidebar .model-usage-liquid-card {')

    expect(shell).toContain('background: transparent;')
    expect(shell).toContain('border: 0;')
    expect(card).toContain('border-radius: 16px;')
    expect(card).toContain('background-color: rgba(7, 19, 34, 0.82);')
    expect(card).toContain('backdrop-filter: blur(22px) saturate(145%) brightness(1.03);')
  })

  it('builds a directional rim and neutral refractive sheen around the card', () => {
    const rim = rule('.app-sidebar .model-usage-liquid-card::before {')
    const sheen = rule('.app-sidebar .model-usage-liquid-card::after {')

    expect(rim).toContain('-webkit-mask-composite: xor;')
    expect(rim).toContain('mask-composite: exclude;')
    expect(sheen).toContain('rgba(255, 255, 255, 0.12)')
    expect(sheen).not.toMatch(/purple|magenta/i)
  })

  it('has opaque Reduce Transparency and pale light-theme fallbacks', () => {
    const reduced = rule("[data-appearance='solid'] .app-sidebar .model-usage-liquid-card,")
    const light = rule(":is([data-theme='light'], [data-theme='mist'], [data-theme='sage'])")

    expect(reduced).toContain("[data-reduce-transparency='true']")
    expect(reduced).toContain('backdrop-filter: none;')
    expect(light).toContain('.model-usage-liquid-card')
    expect(light).toContain('background-color: rgba(224, 235, 246, 0.78);')
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
})
