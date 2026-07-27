import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const themeCss = readFileSync(
  join(process.cwd(), 'src/renderer/src/styles/theme.css'),
  'utf8'
)
const iosTheme = readFileSync(
  join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift'),
  'utf8'
)
const transcriptCss = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/02-transcript-messages-fx.css'),
  'utf8'
)
const polishCss = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/05-polish-fx-layouts.css'),
  'utf8'
)

const STATIC_PROVIDER_COLORS = {
  gemini: '#346EEC',
  codex: '#705AFF',
  claude: '#B16105',
  kimi: '#0073E6',
  grok: '#757575',
  cursor: '#8D7312',
  ollama: '#1A8562',
  antigravity: '#308713',
  ensemble: '#986781',
  alibaba: '#8C52EF',
  'deep-reinforce': '#BE5809',
  ibm: '#3079BC',
  liquid: '#D72D82',
  nvidia: '#538200',
  openbmb: '#E22B17',
  poolside: '#0C8194',
  // Pi seat + its BYOK upstream brands. `pi` was absent from this map entirely,
  // which is why it shipped at #C25E4C — 4.20 contrast on white, under the AA
  // floor — without this gate noticing. The sub-provider hues had the same gap.
  pi: '#68768C',
  deepseek: '#4E6AEE',
  zai: '#177DAA',
  minimax: '#C044A4',
  mistral: '#D44404',
  cerebras: '#BB584A',
  groq: '#088482'
} as const

const PROVIDER_ALIASES = {
  qwen: 'alibaba',
  google: 'antigravity',
  openai: 'codex',
  ornith: 'deep-reinforce'
} as const

const IOS_PROVIDER_CASES = [
  ['case "gemini"', '#346EEC'],
  ['case "codex", "openai"', '#705AFF'],
  ['case "claude"', '#B16105'],
  ['case "kimi"', '#0073E6'],
  ['case "grok"', '#757575'],
  ['case "cursor"', '#8D7312'],
  ['case "ollama"', '#1A8562'],
  ['case "antigravity", "google"', '#308713'],
  ['case "ensemble"', '#986781'],
  ['case "alibaba", "qwen"', '#8C52EF'],
  ['case "deep-reinforce", "ornith"', '#BE5809'],
  ['case "ibm"', '#3079BC'],
  ['case "liquid"', '#D72D82'],
  ['case "nvidia"', '#538200'],
  ['case "openbmb"', '#E22B17'],
  ['case "poolside"', '#0C8194']
] as const

const PROVIDER_RGB_TRIPLETS = {
  gemini: '52 110 236',
  codex: '112 90 255',
  claude: '177 97 5',
  kimi: '0 115 230',
  grok: '117 117 117',
  cursor: '141 115 18',
  ollama: '26 133 98',
  ensemble: '152 103 129'
} as const

const linearChannel = (channel: number): number => {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
  return (
    0.2126 * linearChannel(channels[0]) +
    0.7152 * linearChannel(channels[1]) +
    0.0722 * linearChannel(channels[2])
  )
}

const contrastAgainstWhite = (hex: string): number =>
  1.05 / (relativeLuminance(hex) + 0.05)

const contrastAgainstBlack = (hex: string): number =>
  (relativeLuminance(hex) + 0.05) / 0.05

describe('provider palette contrast', () => {
  it('pins the reviewed desktop provider and Ollama display-brand swatches', () => {
    for (const [provider, hex] of Object.entries(STATIC_PROVIDER_COLORS)) {
      expect(themeCss).toContain(`--provider-${provider}-color: ${hex};`)
    }
  })

  it('keeps display-brand aliases attached to their canonical provider tokens', () => {
    for (const [alias, provider] of Object.entries(PROVIDER_ALIASES)) {
      expect(themeCss).toContain(
        `--provider-${alias}-color: var(--provider-${provider}-color);`
      )
    }
  })

  it('keeps the iOS provider and display-brand mirror in sync', () => {
    for (const [switchCase, hex] of IOS_PROVIDER_CASES) {
      // The Swift table is HEX-FIRST (`providerAccentHex` returns the number and
      // `providerAccent` wraps it in a Color) so the Live Activity widget — which
      // cannot link TaskWraithUI — can be handed a resolved value instead of
      // needing a second copy of this catalogue.
      expect(iosTheme).toContain(`${switchCase}: return 0x${hex.slice(1)}`)
    }
  })

  /**
   * `TWTheme.providerAccentKeys` is a hand-list sitting beside a switch, which
   * is a drift risk in its own right — and it is load-bearing: the phone ships
   * that map to the Mac so push-to-start can colour an activity without the Mac
   * needing a provider table of its own. A key missing here means a run
   * push-started from a closed phone wears the wrong brand.
   */
  it('keeps providerAccentKeys exactly in step with the accent switch', () => {
    const fn = iosTheme.match(
      /public static func providerAccentHex\(_ provider: String\?\) -> UInt32 \{([\s\S]*?)\n    \}/
    )
    expect(fn, 'providerAccentHex switch not found in Theme.swift').toBeTruthy()
    const switchKeys = [...(fn as RegExpMatchArray)[1].matchAll(/case ("[^:]*"):/g)]
      .flatMap((m) => m[1].split(',').map((k) => k.trim().replace(/"/g, '')))
      .sort()

    const list = iosTheme.match(/public static let providerAccentKeys: \[String\] = \[([\s\S]*?)\]/)
    expect(list, 'providerAccentKeys not found in Theme.swift').toBeTruthy()
    const listedKeys = [...(list as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort()

    expect(switchKeys.length).toBeGreaterThan(20)
    expect(listedKeys).toEqual(switchKeys)
  })

  it('keeps transcript and Agent Aura RGB mirrors in sync', () => {
    for (const [provider, rgb] of Object.entries(PROVIDER_RGB_TRIPLETS)) {
      expect(transcriptCss).toMatch(
        new RegExp(
          `\\.app-transcript\\.provider-${provider} \\{[^}]*--agent-accent-rgb: ${rgb};`,
          's'
        )
      )
      expect(polishCss).toMatch(
        new RegExp(`\\.fx-provider-${provider} \\{[^}]*--agent-aura-rgb: ${rgb};`, 's')
      )
    }
  })

  it('keeps every static swatch AA-readable on pure white and pure black', () => {
    for (const [provider, hex] of Object.entries(STATIC_PROVIDER_COLORS)) {
      expect(contrastAgainstWhite(hex), `${provider} on white`).toBeGreaterThanOrEqual(4.5)
      expect(contrastAgainstBlack(hex), `${provider} on black`).toBeGreaterThanOrEqual(4.5)
    }
  })

  /**
   * The hand-written map above is a MIRROR contract — it pins specific hexes so
   * theme.css, iOS and the RGB triplets cannot drift apart. But it was also the
   * only thing feeding the AA check, so a colour simply absent from it was never
   * contrast-tested at all. `pi` was missing, and shipped at 4.20 on white —
   * under the AA floor — for exactly that reason. Six Pi sub-provider hues had
   * the same gap.
   *
   * So the AA check no longer trusts the hand-list: it discovers every literal
   * `--provider-*-color: #hex;` in theme.css and asserts on all of them. A new
   * provider colour is now contrast-tested the moment it is declared, whether or
   * not anyone remembers this file. Aliases (`var(--provider-x-color)`) are
   * skipped by construction — the regex only matches literal hexes, and the
   * alias's target is checked on its own.
   */
  it('contrast-tests EVERY provider colour declared in theme.css, not just the listed ones', () => {
    const declared = [...themeCss.matchAll(/--provider-([a-z0-9-]+)-color:\s*(#[0-9A-Fa-f]{6});/g)]
    const seen = new Map<string, string>()
    for (const [, provider, hex] of declared) seen.set(provider, hex.toUpperCase())

    // Guard the discovery itself: a regex that silently matched nothing would
    // make this whole test vacuous.
    expect(seen.size).toBeGreaterThanOrEqual(Object.keys(STATIC_PROVIDER_COLORS).length)

    for (const [provider, hex] of seen) {
      expect(contrastAgainstWhite(hex), `${provider} (${hex}) on white`).toBeGreaterThanOrEqual(4.5)
      expect(contrastAgainstBlack(hex), `${provider} (${hex}) on black`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('has no provider colour that the mirror map silently omits', () => {
    // Not a contrast check — a completeness one. Every literal provider colour
    // should be in STATIC_PROVIDER_COLORS so the theme.css/iOS/RGB mirrors stay
    // enumerable. Listed here as an explicit, reviewable exception set rather
    // than left implicit.
    const declared = new Set(
      [...themeCss.matchAll(/--provider-([a-z0-9-]+)-color:\s*#[0-9A-Fa-f]{6};/g)].map((m) => m[1])
    )
    const missing = [...declared].filter((p) => !(p in STATIC_PROVIDER_COLORS)).sort()
    expect(missing).toEqual([])
  })
})
