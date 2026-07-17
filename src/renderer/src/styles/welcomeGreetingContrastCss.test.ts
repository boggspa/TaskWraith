import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/03-composer-welcome-activity.css'),
  'utf8'
).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (selector: string): string => {
  const start = css.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return css.slice(start, end + 1)
}

describe('welcome greeting contrast', () => {
  it('keeps the luminous provider-tinted foreground and glow for dark themes', () => {
    const block = cssBlockStartingAt('.welcome-hero h1 strong {')

    expect(block).toContain(
      'color: color-mix(in srgb, var(--welcome-provider-color) 28%, #ffffff 72%);'
    )
    expect(block).toContain('var(--welcome-provider-color) 58%')
  })

  it('uses dark ink with the provider glow on every light-family welcome', () => {
    const selector =
      ':is([data-theme="light"], [data-theme="citrus"], [data-theme="mist"], [data-theme="sage"])\n  .workspace-name-glow {'
    const block = cssBlockStartingAt(selector)

    expect(block).toContain('color: var(--text-primary);')
    expect(block).toContain('var(--workspace-name-glow-color, var(--text-primary)) 30%')
    expect(block).toContain('var(--workspace-name-glow-color, var(--text-primary)) 16%')
  })
})
