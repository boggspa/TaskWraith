import manifest from '../../design-assets/agent-identicon/agent-identicons.manifest.json'

export interface AgentSeedIdentity {
  name: string
  slug: string
  accent: string
}

interface AgentIdenticonManifestEntry {
  name: string
  slug: string
  accent: string
}

const EMPTY_CATALOG_FALLBACK: AgentSeedIdentity = {
  name: 'Agent',
  slug: 'agent',
  accent: '#5A8CFF'
}

function parseManifestEntry(value: unknown): AgentIdenticonManifestEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const slug = typeof record.slug === 'string' ? record.slug.trim() : ''
  const accent = typeof record.accent === 'string' ? record.accent.trim().toUpperCase() : ''
  if (!name || !slug || !/^#[0-9A-F]{6}$/.test(accent)) return null
  return { name, slug, accent }
}

const NAMED_AGENT_IDENTICONS = (manifest as readonly unknown[])
  .map(parseManifestEntry)
  .filter((entry): entry is AgentIdenticonManifestEntry => Boolean(entry))

function normaliseIdenticonSeed(seed: string | null | undefined): string {
  const trimmed = seed?.trim()
  return trimmed ? trimmed.toLowerCase() : 'agent'
}

export function agentIdenticonHash(seed: string | null | undefined): number {
  const value = normaliseIdenticonSeed(seed)
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function assignAgentIdentityFromSeed(seed: string | null | undefined): AgentSeedIdentity {
  if (NAMED_AGENT_IDENTICONS.length === 0) return EMPTY_CATALOG_FALLBACK
  const entry = NAMED_AGENT_IDENTICONS[agentIdenticonHash(seed) % NAMED_AGENT_IDENTICONS.length]
  return {
    name: entry.name,
    slug: entry.slug,
    accent: entry.accent
  }
}
