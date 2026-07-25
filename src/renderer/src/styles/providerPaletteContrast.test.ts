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
  poolside: '#0C8194'
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
      expect(iosTheme).toContain(`${switchCase}: return Color(hex: 0x${hex.slice(1)})`)
    }
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

})
