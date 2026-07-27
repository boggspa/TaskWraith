import poolManifestRaw from '../../../../design-assets/agent-pool-icons/agent-pool-icons.manifest.json'
import providerManifestRaw from '../../../../design-assets/provider-glyphs/provider-glyphs.manifest.json'
import type { ProviderId } from '../../../main/store/types'

/**
 * App-wide SVG icon pool for the Settings → Roster "Agent pool" picker.
 *
 * Folds several design-asset directories into one selectable catalogue, keyed by
 * a group-namespaced `key` (`pool:neon-node`, `provider:claude`, `ghost:…`,
 * `action:…`, `command:…`). The featured group is the purpose-built
 * `design-assets/agent-pool-icons` set; the rest are official provider marks,
 * TaskWraith's Ensemble glyph, ghost marks, workflow/action icons and
 * slash-command icons the user asked to expose.
 *
 * Recolouring is auto-detected: an SVG that uses `currentColor` / `--agent-accent`
 * is tinted to the agent's accent (like the named identicons); a fixed-palette
 * SVG (the Ensemble glyph and full-colour ghost art) renders natively. Official
 * provider marks use the component-rendered PNG catalogue.
 *
 * This is deliberately separate from `agentIdentityCatalog.ts` (the
 * subagent/nickname identicon catalogue) — see that file's note.
 */

export type PoolIconGroup = 'Agent pool' | 'Providers' | 'Ghosts' | 'Actions' | 'Commands'

export interface PoolIconAsset {
  /** Stable group-namespaced key persisted on the pooled agent. */
  key: string
  group: PoolIconGroup
  label: string
  /** Raw SVG markup for TaskWraith-owned and generic catalogue artwork. */
  raw?: string
  /** Official provider mark rendered by ProviderBrandLogo instead of inline SVG. */
  providerLogo?: ProviderId
  /** True when the icon honours `currentColor` and can be tinted to the accent. */
  recolor: boolean
  /** Suggested accent (hex) — from a manifest where available. */
  accent?: string
  /** Suggested hue (0-359) where a manifest provides one. */
  hue?: number
}

/** Group render order in the picker. */
export const POOL_ICON_GROUPS: readonly PoolIconGroup[] = [
  'Agent pool',
  'Providers',
  'Ghosts',
  'Actions',
  'Commands'
]

function globRaw(modules: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [path, raw] of Object.entries(modules)) {
    if (typeof raw !== 'string') continue
    const file = path.split('/').pop()
    if (file) out.set(file, raw)
  }
  return out
}

// Eager raw-SVG imports (mirrors AgentIdentityIcon's named-identicon glob).
const POOL_RAW = globRaw(
  import.meta.glob('../../../../design-assets/agent-pool-icons/icons/*.svg', {
    eager: true,
    import: 'default',
    query: '?raw'
  }) as Record<string, string>
)
const GHOST_RAW = globRaw(
  import.meta.glob('../../../../design-assets/ghost/*.svg', {
    eager: true,
    import: 'default',
    query: '?raw'
  }) as Record<string, string>
)
const PROVIDER_RAW = globRaw(
  import.meta.glob('../../../../design-assets/provider-glyphs/glyphs/*.svg', {
    eager: true,
    import: 'default',
    query: '?raw'
  }) as Record<string, string>
)

const OFFICIAL_PROVIDER_POOL_ASSETS: readonly {
  providerLogo: ProviderId
  label: string
  accent: string
}[] = [
  { providerLogo: 'gemini', label: 'Gemini', accent: '#346EEC' },
  { providerLogo: 'codex', label: 'Codex', accent: '#705AFF' },
  { providerLogo: 'claude', label: 'Claude', accent: '#B16105' },
  { providerLogo: 'kimi', label: 'Kimi', accent: '#0073E6' },
  { providerLogo: 'cursor', label: 'Cursor', accent: '#8D7312' },
  { providerLogo: 'grok', label: 'Grok', accent: '#757575' },
  { providerLogo: 'ollama', label: 'Ollama', accent: '#1A8562' },
  { providerLogo: 'antigravity', label: 'Antigravity', accent: '#308713' },
  { providerLogo: 'pi', label: 'Pi', accent: '#68768C' },
  { providerLogo: 'mistral', label: 'Mistral', accent: '#D44404' }
]
const ACTION_RAW = globRaw(
  import.meta.glob('../../../../design-assets/workflows/icons/*.svg', {
    eager: true,
    import: 'default',
    query: '?raw'
  }) as Record<string, string>
)
const COMMAND_RAW = globRaw(
  import.meta.glob('../../../../design-assets/slash-commands/icons/*.svg', {
    eager: true,
    import: 'default',
    query: '?raw'
  }) as Record<string, string>
)

function isRecolorable(raw: string): boolean {
  return /currentColor|--agent-accent/.test(raw)
}

function stemOf(file: string): string {
  return file.replace(/\.svg$/i, '')
}

function prettifyStem(stem: string): string {
  const cleaned = stem.replace(/^(ghost-guy-|action-|status-)/, '').replace(/[-_]+/g, ' ').trim()
  if (!cleaned) return stem
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

function parseHex(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined
}

function buildPoolGroup(): PoolIconAsset[] {
  const manifest = Array.isArray(poolManifestRaw) ? (poolManifestRaw as unknown[]) : []
  const out: PoolIconAsset[] = []
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const slug = typeof record.slug === 'string' ? record.slug.trim() : ''
    const file = typeof record.file === 'string' ? record.file.split('/').pop() ?? '' : ''
    const raw = file ? POOL_RAW.get(file) : undefined
    if (!slug || !raw) continue
    const hue = Number(record.hue)
    out.push({
      key: `pool:${slug}`,
      group: 'Agent pool',
      label: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : prettifyStem(slug),
      raw,
      recolor: isRecolorable(raw),
      accent: parseHex(record.accent),
      hue: Number.isFinite(hue) ? ((Math.round(hue) % 360) + 360) % 360 : undefined
    })
  }
  return out
}

function buildProviderGroup(): PoolIconAsset[] {
  const manifest = Array.isArray(providerManifestRaw) ? (providerManifestRaw as unknown[]) : []
  const labelById = new Map<string, string>()
  const accentById = new Map<string, string>()
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id) continue
    if (typeof record.label === 'string') labelById.set(id, record.label)
    const accent = parseHex(record.accent)
    if (accent) accentById.set(id, accent)
  }
  const out: PoolIconAsset[] = OFFICIAL_PROVIDER_POOL_ASSETS.map(
    ({ providerLogo, label, accent }) => ({
      key: `provider:${providerLogo}`,
      group: 'Providers',
      label,
      providerLogo,
      recolor: false,
      accent
    })
  )
  const ensembleRaw = PROVIDER_RAW.get('ensemble.svg')
  if (ensembleRaw) {
    out.push({
      key: 'provider:ensemble',
      group: 'Providers',
      label: labelById.get('ensemble') ?? 'Ensemble',
      raw: ensembleRaw,
      recolor: isRecolorable(ensembleRaw),
      accent: accentById.get('ensemble')
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

function buildSimpleGroup(
  raws: Map<string, string>,
  group: PoolIconGroup,
  keyPrefix: string
): PoolIconAsset[] {
  const out: PoolIconAsset[] = []
  for (const [file, raw] of raws) {
    const stem = stemOf(file)
    out.push({
      key: `${keyPrefix}:${stem}`,
      group,
      label: prettifyStem(stem),
      raw,
      recolor: isRecolorable(raw)
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

export const POOL_ICON_ASSETS: readonly PoolIconAsset[] = [
  ...buildPoolGroup(),
  ...buildProviderGroup(),
  ...buildSimpleGroup(GHOST_RAW, 'Ghosts', 'ghost'),
  ...buildSimpleGroup(ACTION_RAW, 'Actions', 'action'),
  ...buildSimpleGroup(COMMAND_RAW, 'Commands', 'command')
]

const ASSET_BY_KEY = new Map(POOL_ICON_ASSETS.map((asset) => [asset.key, asset]))

export function getPoolIconAsset(key: string | null | undefined): PoolIconAsset | undefined {
  return key ? ASSET_BY_KEY.get(key) : undefined
}

export function poolIconAssetsByGroup(): { group: PoolIconGroup; assets: PoolIconAsset[] }[] {
  return POOL_ICON_GROUPS.map((group) => ({
    group,
    assets: POOL_ICON_ASSETS.filter((asset) => asset.group === group)
  })).filter((section) => section.assets.length > 0)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function classPrefixForAsset(key: string): string {
  const stem = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `agent-pool-icon-${stem}-`
}

function namespaceInlineSvgIds(raw: string, key: string, instanceId: string): string {
  const prefix = classPrefixForAsset(`${key}-${instanceId}`)
  const idMap = new Map<string, string>()
  for (const match of raw.matchAll(/\sid="([^"]+)"/g)) {
    idMap.set(match[1], `${prefix}${match[1]}`)
  }
  if (idMap.size === 0) return raw

  let namespaced = raw.replace(/\sid="([^"]+)"/g, (match, id: string) => {
    const replacement = idMap.get(id)
    return replacement ? ` id="${replacement}"` : match
  })
  namespaced = namespaced.replace(
    /\b(href|xlink:href)="#([^"]+)"/g,
    (match, attribute: string, id: string) => {
      const replacement = idMap.get(id)
      return replacement ? `${attribute}="#${replacement}"` : match
    }
  )
  namespaced = namespaced.replace(/url\(#([^)]+)\)/g, (match, id: string) => {
    const replacement = idMap.get(id)
    return replacement ? `url(#${replacement})` : match
  })
  return namespaced.replace(/\saria-labelledby="([^"]+)"/g, (_match, ids: string) => {
    const replacements = ids
      .split(/\s+/)
      .map((id) => idMap.get(id) ?? id)
      .join(' ')
    return ` aria-labelledby="${replacements}"`
  })
}

function namespaceInlineSvgClasses(raw: string, key: string): string {
  const prefix = classPrefixForAsset(key)
  const classNames = new Set<string>()
  const withNamespacedClassAttrs = raw.replace(/\sclass="([^"]+)"/g, (match, value: string) => {
    const classes = value
      .split(/\s+/)
      .map((name) => name.trim())
      .filter(Boolean)
    if (classes.length === 0) return match
    for (const name of classes) classNames.add(name)
    return ` class="${classes.map((name) => `${prefix}${name}`).join(' ')}"`
  })

  // Embedded SVG styles often define a shared class vocabulary even when a
  // particular glyph uses only a subset (the filled Codex cloud, for example,
  // uses `.dot` but not `.line`). Scope those unused selectors too so generic
  // rules can never leak from an inline pool icon into the host document.
  withNamespacedClassAttrs.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/g,
    (_match, css: string) => {
      for (const rule of css.matchAll(/([^{}]+)\{/g)) {
        const prelude = rule[1].trim()
        if (prelude.startsWith('@')) continue
        for (const selector of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
          classNames.add(selector[1])
        }
      }
      return _match
    }
  )

  if (classNames.size === 0) return withNamespacedClassAttrs

  const classSelectorReplacements = Array.from(classNames)
    .sort((a, b) => b.length - a.length)
    .map((name) => ({
      pattern: new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`, 'g'),
      replacement: `.${prefix}${name}`
    }))

  return withNamespacedClassAttrs.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g,
    (_match, open: string, css: string, close: string) => {
      let scopedCss = css
      for (const { pattern, replacement } of classSelectorReplacements) {
        scopedCss = scopedCss.replace(pattern, replacement)
      }
      return `${open}${scopedCss}${close}`
    }
  )
}

function tintStyleForAccent(accent: string): string {
  return `color: ${accent}; --agent-accent: ${accent}; --workflow-accent: ${accent};`
}

function mergeRootSvgStyle(existing: string, accent: string): string {
  const trimmed = existing.trim().replace(/;?\s*$/, '')
  const tint = tintStyleForAccent(accent)
  return trimmed ? `${trimmed}; ${tint}` : tint
}

/**
 * Inline-ready SVG: injects sizing, and — for recolourable icons — tints
 * `currentColor` + `--agent-accent` to `accent`. Fixed-palette icons (provider
 * Ensemble artwork, full-colour ghost art) render natively, accent ignored.
 */
export function preparePoolIconSvg(
  asset: PoolIconAsset,
  size: number,
  accent: string | undefined,
  instanceId: string
): string {
  const raw = asset.raw
  if (!raw) {
    throw new Error(`Pool icon ${asset.key} uses a component-rendered provider logo`)
  }
  const namespaceKey = `${asset.key}-${instanceId}`
  let svg = namespaceInlineSvgIds(
    namespaceInlineSvgClasses(raw, namespaceKey),
    asset.key,
    instanceId
  ).replace(
    /^<svg\s+/,
    `<svg class="agent-pool-asset-svg" width="${size}" height="${size}" aria-hidden="true" focusable="false" `
  )
  svg = svg.replace(/\srole="[^"]*"/, '').replace(/\saria-labelledby="[^"]*"/, '')
  if (asset.recolor && accent) {
    const tint = tintStyleForAccent(accent)
    svg = /<svg[^>]*\sstyle="/.test(svg)
      ? svg.replace(
          /(<svg\b[^>]*?\sstyle=")([^"]*)(")/,
          (_match, open: string, existing: string, close: string) =>
            `${open}${mergeRootSvgStyle(existing, accent)}${close}`
        )
      : svg.replace(/^<svg\s+/, `<svg style="${tint}" `)
  }
  return svg
}
