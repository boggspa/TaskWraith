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
  it('makes the whole pane a sampled neutral 65%-alpha material, including its header', () => {
    const card = rule('.app-sidebar .model-usage-summary--sidebar {')
    const body = rule('.app-sidebar .model-usage-liquid-card {')

    expect(card).toContain('border-radius: 16px;')
    expect(card).toContain('background-color: rgba(22, 22, 22, 0.65);')
    expect(card).toContain('background-image: none;')
    expect(card).toContain('backdrop-filter: blur(22px) saturate(0%) brightness(0.96);')
    expect(card).toContain('--model-usage-rim-glow: rgba(86, 151, 240, 0.38);')
    expect(card).toContain('0 0 12px -4px var(--model-usage-rim-glow)')
    expect(body).toContain('background: transparent;')
    expect(body).toContain('border: 0;')
  })

  it('builds a sharp cool hairline rim without a top-biased sheen', () => {
    const card = rule('.app-sidebar .model-usage-summary--sidebar {')
    const rim = rule('.app-sidebar .model-usage-summary--sidebar::before {')
    const sheen = rule('.app-sidebar .model-usage-summary--sidebar::after {')

    expect(card).toContain('--model-usage-rim-inset: 2px;')
    expect(card).toContain('border: 1px solid transparent;')
    expect(card).not.toContain('0 0 20px -12px')
    expect(card).not.toContain('inset 0 1px 0')
    expect(card).not.toContain('radial-gradient(115% 82% at 12% -12%')
    expect(card).not.toContain('inset 0 18px 34px -30px')
    expect(rim).toContain('inset: var(--model-usage-rim-inset);')
    expect(rim).toContain('height: auto;')
    expect(rim).toContain('border-radius: calc(16px - var(--model-usage-rim-inset));')
    expect(rim).toContain('-webkit-mask-composite: xor;')
    expect(rim).toContain('mask-composite: exclude;')
    expect(rim).toContain('background: rgba(112, 168, 246, 0.65);')
    expect(rim).toContain('filter: drop-shadow(0 0 1px rgba(112, 168, 246, 0.35));')
    expect(rim).not.toContain('background: linear-gradient(')
    expect(sheen).toContain('linear-gradient(')
    expect(sheen).not.toContain('radial-gradient(')
    expect(sheen).not.toContain('rgba(150, 171, 201')
    expect(sheen).not.toMatch(/purple|magenta/i)
  })

  it('keeps soft and native glass achromatic without increasing layout-rule specificity', () => {
    const glassCard = rule(
      ":is([data-appearance='soft_glass'], [data-appearance='native_glass'])"
    )

    expect(css).toContain('.app-sidebar .model-usage-summary--sidebar.is-collapsed {')
    expect(glassCard).toContain('border-color: transparent;')
    expect(glassCard).toContain('background-color: rgba(22, 22, 22, 0.65);')
    expect(glassCard).toContain('background-image: none;')
    expect(glassCard).toContain('inset 0 -1px 0 rgba(0, 0, 0, 0.5)')
    expect(glassCard).toContain('0 0 12px -4px var(--model-usage-rim-glow)')
    expect(glassCard).not.toContain('inset 0 1px 0')
  })

  it('uses opaque black for Reduce Transparency and pure white for light themes', () => {
    const reduced = rule("[data-appearance='solid']")
    const light = rule(
      ":is([data-theme='light'], [data-theme='mist'], [data-theme='sage'])[data-appearance]"
    )

    expect(reduced).toContain("[data-reduce-transparency='true']")
    expect(reduced).toContain('background-color: rgb(22, 22, 22);')
    expect(reduced).toContain('background-image: none;')
    expect(reduced).toContain('backdrop-filter: none;')
    expect(light).toContain('.model-usage-summary--sidebar')
    expect(light).toContain('background-color: rgba(255, 255, 255, 0.65);')
    expect(light).toContain('background-image: none;')
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

  it('keeps the collapsed quota percentages flat and readable at compact density', () => {
    const grid = rule(
      '.app-sidebar .model-usage-liquid-card .model-usage-compact-grid {'
    )
    const cell = rule('.app-sidebar .model-usage-liquid-card .model-usage-compact-cell {')

    expect(grid).toContain('border-collapse: separate;')
    expect(grid).toContain('border-spacing: 2px 2px;')
    expect(cell).toContain('border: 0;')
    expect(cell).toContain('background: transparent;')
    expect(cell).toContain('box-shadow: none;')
    expect(cell).toContain('text-shadow: none;')
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
