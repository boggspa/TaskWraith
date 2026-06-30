import poolManifestRaw from '../../../../design-assets/agent-pool-icons/agent-pool-icons.manifest.json'
import providerManifestRaw from '../../../../design-assets/provider-glyphs/provider-glyphs.manifest.json'

/**
 * App-wide SVG icon pool for the Settings → Roster "Agent pool" picker.
 *
 * Folds several design-asset directories into one selectable catalogue, keyed by
 * a group-namespaced `key` (`pool:neon-node`, `provider:claude`, `ghost:…`,
 * `action:…`, `command:…`). The featured group is the purpose-built
 * `design-assets/agent-pool-icons` set; the rest are the provider glyphs, ghost
 * marks, workflow/action icons and slash-command icons the user asked to expose.
 *
 * Recolouring is auto-detected: an SVG that uses `currentColor` / `--agent-accent`
 * is tinted to the agent's accent (like the named identicons); a fixed-palette
 * SVG (provider brand glyphs, the full-colour ghost art) renders natively.
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
  /** Raw SVG markup. */
  raw: string
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
  const out: PoolIconAsset[] = []
  for (const [file, raw] of PROVIDER_RAW) {
    const id = stemOf(file)
    out.push({
      key: `provider:${id}`,
      group: 'Providers',
      label: labelById.get(id) ?? prettifyStem(id),
      raw,
      recolor: isRecolorable(raw),
      accent: accentById.get(id)
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

/**
 * Inline-ready SVG: injects sizing, and — for recolourable icons — tints
 * `currentColor` + `--agent-accent` to `accent`. Fixed-palette icons (provider
 * brand glyphs, full-colour ghost art) render natively, accent ignored.
 */
export function preparePoolIconSvg(asset: PoolIconAsset, size: number, accent?: string): string {
  let svg = asset.raw.replace(
    /^<svg\s+/,
    `<svg class="agent-pool-asset-svg" width="${size}" height="${size}" aria-hidden="true" focusable="false" `
  )
  svg = svg.replace(/\srole="[^"]*"/, '').replace(/\saria-labelledby="[^"]*"/, '')
  if (asset.recolor && accent) {
    const tint = ` style="color: ${accent}; --agent-accent: ${accent};"`
    svg = /<svg[^>]*\sstyle="/.test(svg)
      ? svg.replace(/(<svg\b[^>]*?)\sstyle="[^"]*"/, `$1${tint}`)
      : svg.replace(/^<svg\s+/, `<svg${tint} `)
  }
  return svg
}
