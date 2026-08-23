import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PI_MODEL_LABELS,
  PI_UPSTREAM_BRANDS,
  resolvePiModelLabel,
  resolvePiUpstreamBrand,
  splitPiWireModelId
} from './piBrandTable'
import { PI_STATIC_MODELS } from '../main/pi/PiModels'

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
    expect(resolvePiUpstreamBrand('openrouter/stealth/ox-alpha')?.label).toBe('OpenRouter')
    expect(resolvePiUpstreamBrand('openrouter/zai/glm-5.2')?.label).toBe('Z.ai')
    expect(resolvePiUpstreamBrand('openrouter/zai/glm-5.2')?.hueClass).toBe('zai')
    expect(resolvePiUpstreamBrand('openrouter/poolside/laguna-s-2.1')?.label).toBe('Poolside')
    expect(resolvePiUpstreamBrand('openrouter/poolside/laguna-s-2.1')?.hueClass).toBe('poolside')
    expect(resolvePiUpstreamBrand('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')?.label).toBe('NVIDIA')
    expect(resolvePiUpstreamBrand('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')?.hueClass).toBe('nvidia')
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

describe('resolvePiModelLabel', () => {
  it('humanises a catalogued wire id', () => {
    expect(resolvePiModelLabel('mistral/devstral-2512')).toBe('Devstral 2')
    expect(resolvePiModelLabel('mistral/zai-glm-5-2')).toBe('GLM-5.2 (via Mistral)')
    expect(resolvePiModelLabel('deepseek/deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(resolvePiModelLabel('openrouter/stealth/ox-alpha')).toBe('Ox Alpha')
  })

  it('keeps the disambiguating suffix on models two upstreams both serve', () => {
    // GPT-OSS 120B is served by BOTH groq and cerebras; in the flat picker the
    // rows are otherwise identical.
    expect(resolvePiModelLabel('groq/openai/gpt-oss-120b')).toBe('GPT-OSS 120B (Groq)')
    expect(resolvePiModelLabel('cerebras/gpt-oss-120b')).toBe('GPT-OSS 120B (Cerebras)')
  })

  it('drops the redundant upstream prefix for an uncatalogued model', () => {
    // The upstream is already rendered beside the label as the brand name.
    expect(resolvePiModelLabel('mistral/some-future-model')).toBe('some-future-model')
  })

  it.each([null, undefined, '', 'noslash', 'anthropic/claude-opus'])(
    'returns null for %o so the caller keeps the raw id',
    (wire) => {
      expect(resolvePiModelLabel(wire)).toBeNull()
    }
  )

  it('labels every model in the curated catalog', () => {
    // Pinned against the main-side catalog: the renderer may not import
    // src/main, so the label map is a second copy and would otherwise drift
    // silently the next time a model is added.
    const catalog = Object.fromEntries(PI_STATIC_MODELS.map((m) => [m.wireId, m.label]))
    expect(PI_MODEL_LABELS).toEqual(catalog)
  })

  it('names an upstream brand for every catalogued model', () => {
    for (const model of PI_STATIC_MODELS) {
      expect(resolvePiUpstreamBrand(model.wireId), `no brand for ${model.wireId}`).toBeTruthy()
    }
  })
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
      expect(swift, `iOS accent missing for ${cls}`).toContain(`case "${cls}": return 0x${hex}`)
    }
  })

  it('keeps the pi seat colour itself in sync across css and iOS', () => {
    const swift = readFileSync(IOS_THEME, 'utf8')
    expect(swift).toContain(`case "pi": return 0x${cssHex('pi').slice(1)}`)
  })
})

describe('iOS PiBrandTable twin', () => {
  // No codegen across the platform boundary. The accent map is already pinned
  // above; these pin the LABELS, which are what the phone actually renders in
  // the transcript header and participant chips. A brand or model added on the
  // desktop and forgotten on the phone fails here rather than shipping a row
  // that reads "Pi · mistral/devstral-2512".
  const swift = readFileSync(
    join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithKit/PiBrandTable.swift'),
    'utf8'
  )

  it.each(Object.entries(PI_UPSTREAM_BRANDS))(
    'mirrors the %s brand into Swift',
    (upstream, brand) => {
      expect(swift).toContain(
        `"${upstream}": Brand(label: "${brand.label}", hueClass: "${brand.hueClass}")`
      )
    }
  )

  it.each(Object.entries(PI_MODEL_LABELS))('mirrors the %s label into Swift', (wireId, label) => {
    expect(swift).toContain(`"${wireId}": "${label}"`)
  })

  it('surfaces no upstream or model the desktop does not', () => {
    const swiftUpstreams = [...swift.matchAll(/^\s{8}"([a-z0-9/-]+)": Brand\(/gm)].map((m) => m[1])
    expect(swiftUpstreams.sort()).toEqual(Object.keys(PI_UPSTREAM_BRANDS).sort())
    const swiftModels = [...swift.matchAll(/^\s{8}"([^"]+\/[^"]+)": "/gm)].map((m) => m[1])
    expect(swiftModels.sort()).toEqual(Object.keys(PI_MODEL_LABELS).sort())
  })
})

describe('the renderer ensemble-editor mirror', () => {
  // A FOURTH hand-maintained copy of this catalog (main, shared, iOS, and the
  // ensemble seat editor). It has drifted before, which puts two different
  // names for one model in front of the same user; pin ids and labels together.
  const source = readFileSync(
    join(process.cwd(), 'src/renderer/src/lib/ensembleProviderDefaults.ts'),
    'utf8'
  )
  const block = source.slice(source.indexOf('const PI_MODELS'))
  const listed = [
    ...block.slice(0, block.indexOf('\n]')).matchAll(/\{ id: '([^']+)', label: '([^']+)' \}/g)
  ]

  it('lists every catalogued model exactly once', () => {
    expect(listed.map((m) => m[1]).sort()).toEqual(Object.keys(PI_MODEL_LABELS).sort())
  })

  it.each(Object.entries(PI_MODEL_LABELS))('labels %s identically to the catalog', (id, label) => {
    expect(listed.find((m) => m[1] === id)?.[2]).toBe(label)
  })
})

describe('Pi hue classes are actually painted', () => {
  // A theme TOKEN is only half of a hue: the surface has to carry a rule that
  // reads it. `resolveProviderHueClass` shipped returning `mistral` before any
  // stylesheet matched `.provider-mistral`, so Pi participants rendered in the
  // inherited text colour while every other provider wore its accent. These
  // pin the enumerated blocks — a new Pi upstream that lands in the brand table
  // without its CSS row fails here instead of silently rendering uncoloured.
  const classes = ['pi', ...new Set(Object.values(PI_UPSTREAM_BRANDS).map((b) => b.hueClass))]

  const cssFile = (name: string): string =>
    readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', name), 'utf8')

  it.each(classes)('%s tints the above-composer participant role', (cls) => {
    expect(cssFile('09-ensemble-work-session.css')).toContain(
      `.ensemble-above-chip.provider-${cls} .ensemble-above-chip-role`
    )
  })

  it.each(classes)('%s tints the above-composer chip tooltip title', (cls) => {
    expect(cssFile('09-ensemble-work-session.css')).toContain(
      `.ensemble-above-chip-tooltip.provider-${cls} .ensemble-above-chip-tooltip-title`
    )
  })

  it.each(classes)('%s tints the transcript speaker label', (cls) => {
    // `qwen` predates Pi on the Ollama side and is already present.
    expect(cssFile('02-transcript-messages-fx.css')).toContain(`.message-meta.provider-${cls}`)
  })

  it.each(classes)('%s tints the participant-health chip', (cls) => {
    expect(cssFile('02-transcript-messages-fx.css')).toContain(
      `.participant-health-chip.provider-${cls}`
    )
  })
})
