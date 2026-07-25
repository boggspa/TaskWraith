import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PI_UPSTREAM_BRANDS, resolvePiUpstreamBrand, splitPiWireModelId } from './piBrandTable'

const THEME_CSS = join(process.cwd(), 'src/renderer/src/styles/theme.css')
const IOS_THEME = join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift')

/** WCAG relative luminance for an #RRGGBB string. */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}
const onWhite = (hex: string): number => 1.05 / (relativeLuminance(hex) + 0.05)
const onBlack = (hex: string): number => (relativeLuminance(hex) + 0.05) / 0.05

describe('splitPiWireModelId', () => {
  it('splits on the FIRST slash so Groq two-slash ids keep their upstream', () => {
    // The landmine: splitting on the LAST slash yields upstream
    // "groq/openai", which matches no brand and mis-colours every Groq row.
    expect(splitPiWireModelId('groq/openai/gpt-oss-120b')).toEqual({
      upstream: 'groq',
      modelId: 'openai/gpt-oss-120b'
    })
  })

  it('splits ordinary single-slash ids', () => {
    expect(splitPiWireModelId('deepseek/deepseek-v4-flash')).toEqual({
      upstream: 'deepseek',
      modelId: 'deepseek-v4-flash'
    })
  })

  it.each(['', 'noslash', '/leading', 'trailing/'])('rejects %o', (wire) => {
    expect(splitPiWireModelId(wire)).toBeNull()
  })
})

describe('resolvePiUpstreamBrand', () => {
  it('resolves each surfaced upstream from a wire id', () => {
    expect(resolvePiUpstreamBrand('mistral/devstral-2512')?.hueClass).toBe('mistral')
    expect(resolvePiUpstreamBrand('groq/openai/gpt-oss-120b')?.hueClass).toBe('groq')
    expect(resolvePiUpstreamBrand('minimax/MiniMax-M3')?.label).toBe('MiniMax')
  })

  it('maps qwen-token-plan to the EXISTING qwen hue, not a new one', () => {
    // Qwen must read identically whether it arrives via Ollama or via Pi.
    expect(resolvePiUpstreamBrand('qwen-token-plan/qwen3.7-max')?.hueClass).toBe('qwen')
  })

  it.each([null, undefined, '', 'garbage', 'anthropic/claude-opus'])(
    'returns null for %o so callers fall back to the pi seat colour',
    (wire) => {
      expect(resolvePiUpstreamBrand(wire)).toBeNull()
    }
  )
})

describe('Pi sub-provider palette', () => {
  const css = readFileSync(THEME_CSS, 'utf8')
  const hueClasses = [...new Set(Object.values(PI_UPSTREAM_BRANDS).map((b) => b.hueClass))]

  /** Resolve a provider token to its literal hex, following one level of
   *  `var(--provider-x-color)` aliasing (qwen points at alibaba by design). */
  const cssHex = (cls: string, depth = 0): string => {
    const match = css.match(new RegExp(`--provider-${cls}-color:\\s*([^;]+);`))
    expect(match, `--provider-${cls}-color missing from theme.css`).toBeTruthy()
    const value = (match as RegExpMatchArray)[1].trim()
    if (/^#[0-9A-Fa-f]{6}$/.test(value)) return value.toUpperCase()
    const alias = value.match(/var\(\s*--provider-([a-z0-9-]+)-color\s*\)/i)
    expect(alias, `--provider-${cls}-color is neither a hex nor an alias: ${value}`).toBeTruthy()
    expect(depth, `alias loop resolving --provider-${cls}-color`).toBeLessThan(4)
    return cssHex((alias as RegExpMatchArray)[1], depth + 1)
  }

  it('defines a theme token for every surfaced upstream hue class', () => {
    for (const cls of hueClasses) expect(cssHex(cls)).toMatch(/^#[0-9A-F]{6}$/)
  })

  // The invariant every provider colour in this palette already satisfies:
  // legible on pure white AND pure black. Pi's old #C25E4C broke it at 4.20 on
  // white, which is what prompted this pass — don't let a new chip regress it.
  it.each(['pi', 'deepseek', 'zai', 'minimax', 'mistral', 'cerebras', 'groq', 'qwen'])(
    '%s clears WCAG AA on both pure white and pure black',
    (cls) => {
      const hex = cssHex(cls)
      expect(onWhite(hex)).toBeGreaterThanOrEqual(4.5)
      expect(onBlack(hex)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it('gives every surfaced upstream a distinct hue (siblings co-appear in the picker)', () => {
    const hexes = hueClasses.map(cssHex)
    expect(new Set(hexes).size).toBe(hexes.length)
  })

  it('mirrors each hue into the hand-maintained iOS accent map', () => {
    // No codegen across the platform boundary — a miss here is a silently
    // wrong-coloured row on the phone, so pin the numbers themselves.
    const swift = readFileSync(IOS_THEME, 'utf8')
    for (const cls of hueClasses) {
      if (cls === 'qwen') continue // pre-existing `case "alibaba", "qwen"`
      const hex = cssHex(cls).slice(1)
      expect(swift, `iOS accent missing for ${cls}`).toContain(
        `case "${cls}": return Color(hex: 0x${hex})`
      )
    }
  })

  it('keeps the pi seat colour itself in sync across css and iOS', () => {
    const swift = readFileSync(IOS_THEME, 'utf8')
    expect(swift).toContain(`case "pi": return Color(hex: 0x${cssHex('pi').slice(1)})`)
  })
})
