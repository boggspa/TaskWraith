import type { ProviderId } from '../../../main/store/types'

/** Guarantee tier exposed honestly by transport — mirrors WriteMain policy model. */
export type CacheGuaranteeTier =
  | 'guaranteed'
  | 'automatic-observed'
  | 'best-effort'
  | 'unsupported'

export type PromptCacheMode = 'off' | 'auto' | 'explicit'

export type PromptCacheTransport = 'api-byok' | 'api-managed' | 'cli-opaque' | 'local'

export interface ProviderCacheCapabilitySummary {
  provider: ProviderId
  transport: PromptCacheTransport
  guaranteeTier: CacheGuaranteeTier
  /** Whether TaskWraith can apply cache controls on this path when policy allows. */
  controllable: boolean
  /** Human label for Settings badges. */
  guaranteeLabel: string
  detail: string
  supportsModeControl: boolean
  defaultMode: PromptCacheMode
}

export interface PromptCacheProviderPolicy {
  mode: PromptCacheMode
}

export interface PromptCachePolicySettings {
  enabled: boolean
  providers: Partial<Record<ProviderId, PromptCacheProviderPolicy>>
}

export interface ProviderCacheDiagnostics {
  provider: ProviderId
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  inputTokens?: number
  lastRunAt?: number
}

/** IPC contract for WriteMain — channel names documented for preload wiring. */
const IPC = {
  getPolicy: 'prompt-cache:get-policy',
  savePolicy: 'prompt-cache:save-policy',
  getCapabilities: 'prompt-cache:get-capabilities',
  getDiagnostics: 'prompt-cache:get-diagnostics'
} as const

export const DEFAULT_PROMPT_CACHE_POLICY: PromptCachePolicySettings = {
  enabled: true,
  providers: {
    claude: { mode: 'auto' },
    codex: { mode: 'auto' },
    kimi: { mode: 'off' },
    grok: { mode: 'off' },
    cursor: { mode: 'off' },
    ollama: { mode: 'off' }
  }
}

export const CACHE_GUARANTEE_LABELS: Record<CacheGuaranteeTier, string> = {
  guaranteed: 'Guaranteed',
  'automatic-observed': 'Automatic',
  'best-effort': 'Best effort',
  unsupported: 'Unsupported'
}

export const CACHE_GUARANTEE_DETAILS: Record<CacheGuaranteeTier, string> = {
  guaranteed:
    'TaskWraith can request provider-side caching on API/BYOK paths it owns. Hits appear as cache read tokens when the provider reports them.',
  'automatic-observed':
    'Provider-managed implicit caching. TaskWraith observes cache hits in usage metadata but cannot force breakpoints.',
  'best-effort':
    'Opaque CLI transport. Cache tokens are recorded only when the provider CLI emits them — not guaranteed.',
  unsupported: 'No provider-side prompt caching on this transport.'
}

/** Static fallback matrix when backend IPC is not yet available. */
export function buildStaticCacheCapabilityMatrix(): ProviderCacheCapabilitySummary[] {
  const rows: Array<[ProviderId, PromptCacheTransport, CacheGuaranteeTier, boolean, boolean]> = [
    ['codex', 'cli-opaque', 'automatic-observed', false, false],
    ['claude', 'cli-opaque', 'best-effort', false, true],
    ['kimi', 'cli-opaque', 'best-effort', false, true],
    ['grok', 'cli-opaque', 'best-effort', false, false],
    ['cursor', 'cli-opaque', 'best-effort', false, false],
    ['ollama', 'local', 'unsupported', false, false]
  ]
  return rows.map(([provider, transport, guaranteeTier, controllable, supportsModeControl]) => ({
    provider,
    transport,
    guaranteeTier,
    controllable,
    supportsModeControl,
    defaultMode: guaranteeTier === 'unsupported' ? 'off' : 'auto',
    guaranteeLabel: CACHE_GUARANTEE_LABELS[guaranteeTier],
    detail: CACHE_GUARANTEE_DETAILS[guaranteeTier]
  }))
}

export function summarizeCapabilitiesByProvider(
  capabilities: ProviderCacheCapabilitySummary[]
): Partial<Record<ProviderId, ProviderCacheCapabilitySummary>> {
  const out: Partial<Record<ProviderId, ProviderCacheCapabilitySummary>> = {}
  for (const row of capabilities) {
    const existing = out[row.provider]
    if (!existing) {
      out[row.provider] = row
      continue
    }
    // Prefer the strongest controllable / guaranteed row per provider.
    const rank = (tier: CacheGuaranteeTier): number => {
      switch (tier) {
        case 'guaranteed':
          return 4
        case 'automatic-observed':
          return 3
        case 'best-effort':
          return 2
        default:
          return 1
      }
    }
    if (rank(row.guaranteeTier) > rank(existing.guaranteeTier)) {
      out[row.provider] = row
    }
  }
  return out
}

function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  const api = (typeof window !== 'undefined' ? window.api : undefined) as
    | Record<string, (...params: unknown[]) => Promise<unknown>>
    | undefined
  if (!api || typeof api[channel] !== 'function') return Promise.resolve(null)
  return api[channel](...args).then((value) => value as T)
}

export async function fetchPromptCachePolicy(): Promise<PromptCachePolicySettings> {
  const remote = await invokeIpc<PromptCachePolicySettings>(IPC.getPolicy)
  if (!remote || typeof remote !== 'object') return DEFAULT_PROMPT_CACHE_POLICY
  return {
    enabled: remote.enabled !== false,
    providers: { ...DEFAULT_PROMPT_CACHE_POLICY.providers, ...(remote.providers ?? {}) }
  }
}

export async function savePromptCachePolicy(
  policy: PromptCachePolicySettings
): Promise<{ ok: boolean; error?: string }> {
  const result = await invokeIpc<{ ok: boolean; error?: string }>(IPC.savePolicy, policy)
  if (!result) {
    return { ok: false, error: 'Prompt cache policy API unavailable. Rebuild TaskWraith after backend lands.' }
  }
  return result
}

export async function fetchProviderCacheCapabilities(): Promise<ProviderCacheCapabilitySummary[]> {
  const remote = await invokeIpc<ProviderCacheCapabilitySummary[]>(IPC.getCapabilities)
  if (Array.isArray(remote) && remote.length > 0) return remote
  return buildStaticCacheCapabilityMatrix()
}

export async function fetchProviderCacheDiagnostics(): Promise<ProviderCacheDiagnostics[]> {
  const remote = await invokeIpc<ProviderCacheDiagnostics[]>(IPC.getDiagnostics)
  return Array.isArray(remote) ? remote : []
}

export function guaranteeBadgeClass(tier: CacheGuaranteeTier): string {
  return `prompt-cache-guarantee prompt-cache-guarantee--${tier}`
}