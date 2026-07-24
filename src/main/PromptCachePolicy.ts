import type {
  AppSettings,
  PromptCacheCapability,
  PromptCacheCapabilitySummary,
  PromptCacheMode,
  PromptCacheProviderSettings,
  PromptCacheSettings,
  ChatRecord,
  ProviderId
} from './store/types'
import { isRetiredProvider } from '../shared/retiredProviders'

const PROVIDERS: ProviderId[] = [
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'gemini',
  'antigravity'
]
const PROMPT_CACHE_MODES = new Set<PromptCacheMode>(['off', 'auto', 'explicit'])
export const DEFAULT_PROMPT_CACHE_SETTINGS: Required<Pick<PromptCacheSettings, 'enabled'>> &
  PromptCacheSettings = {
  enabled: true,
  providers: {
    claude: { mode: 'auto' },
    codex: { mode: 'auto' },
    kimi: { mode: 'off' },
    grok: { mode: 'off' },
    cursor: { mode: 'off' },
    ollama: { mode: 'off' },
    gemini: { mode: 'off' },
    antigravity: { mode: 'off' }
  }
}

type StaticCacheCapability = Omit<
  PromptCacheCapability,
  'defaultMode'
>

export interface PromptCacheDiagnosticRow {
  provider: ProviderId
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  inputTokens: number
  lastRunAt?: number
  runCount: number
}

const STATIC_CAPABILITIES: StaticCacheCapability[] = [
  {
    provider: 'codex',
    label: 'Codex',
    transport: 'cli-opaque',
    guaranteeTier: 'automatic-observed',
    guaranteeLabel: 'Automatic',
    detail:
      'Provider-managed prompt caching. TaskWraith observes cache hits in usage metadata where Codex reports them but does not control cache breakpoints.',
    controllable: false,
    supportsModeControl: false
  },
  {
    provider: 'claude',
    label: 'Claude',
    transport: 'cli-opaque',
    guaranteeTier: 'best-effort',
    guaranteeLabel: 'Best effort',
    detail:
      'Claude BYOK currently runs through the Claude Code Agent SDK/CLI surface. TaskWraith can pass credentials and record cache tokens, but cannot attach raw Messages API cache_control blocks on this transport.',
    controllable: false,
    supportsModeControl: true
  },
  {
    provider: 'kimi',
    label: 'Kimi',
    transport: 'cli-opaque',
    guaranteeTier: 'best-effort',
    guaranteeLabel: 'Best effort',
    detail:
      'Runtime-admitted Kimi Code runs through opaque ACP provider semantics. Managed authentication comes from the current Kimi Code home, not the TaskWraith Settings usage key; cache creation is provider-managed.',
    controllable: false,
    supportsModeControl: true
  },
  {
    provider: 'grok',
    label: 'Grok',
    transport: 'cli-opaque',
    guaranteeTier: 'best-effort',
    guaranteeLabel: 'Best effort',
    detail:
      'Grok runs use a provider-native CLI bridge. TaskWraith reports cache tokens when emitted but cannot force provider-side caching.',
    controllable: false,
    supportsModeControl: false
  },
  {
    provider: 'cursor',
    label: 'Cursor',
    transport: 'cli-opaque',
    guaranteeTier: 'unsupported',
    guaranteeLabel: 'Unsupported',
    detail:
      'Historical Cursor usage may still decode cache metadata. Cursor managed runs and cache controls are unavailable while startup containment remains unqualified.',
    controllable: false,
    supportsModeControl: false,
    retired: true
  },
  {
    provider: 'ollama',
    label: 'Ollama',
    transport: 'local',
    guaranteeTier: 'unsupported',
    guaranteeLabel: 'Unsupported',
    detail: 'Local Ollama runs do not expose provider-side paid prompt caching semantics.',
    controllable: false,
    supportsModeControl: false
  },
  {
    provider: 'gemini',
    label: 'Gemini',
    transport: 'api-managed',
    guaranteeTier: 'unsupported',
    guaranteeLabel: 'Unsupported',
    detail:
      'Gemini is retired in TaskWraith. Historical usage may still decode cache-hit metadata, but new cache controls are not offered.',
    controllable: false,
    supportsModeControl: false,
    retired: true,
  },
  {
    // AntiGravity carries two transports under one id, and the weaker one sets
    // the tier: the Gemini API key lane gets Google's provider-side implicit
    // caching (no breakpoints TaskWraith can set), and the official agy CLI
    // lane is opaque like every other CLI row.
    provider: 'antigravity',
    label: 'Antigravity',
    transport: 'api-managed',
    guaranteeTier: 'automatic-observed',
    guaranteeLabel: 'Automatic',
    detail:
      'Gemini API key runs use Google-managed implicit caching; the official agy CLI lane is an opaque transport. TaskWraith records cache tokens only where the transport reports them and cannot force cache breakpoints on either lane.',
    controllable: false,
    supportsModeControl: false
  }
]

export function normalizePromptCacheMode(value: unknown, fallback: PromptCacheMode): PromptCacheMode {
  return typeof value === 'string' && PROMPT_CACHE_MODES.has(value as PromptCacheMode)
    ? (value as PromptCacheMode)
    : fallback
}

export function normalizePromptCacheProviderSettings(
  value: unknown,
  fallback: PromptCacheProviderSettings = {}
): PromptCacheProviderSettings {
  const input = isRecord(value) ? value : {}
  const minTokens = Number(input.minStablePrefixTokens)
  return {
    mode: normalizePromptCacheMode(input.mode, fallback.mode || 'auto'),
    minStablePrefixTokens: Number.isFinite(minTokens)
      ? Math.max(0, Math.min(200_000, Math.trunc(minTokens)))
      : fallback.minStablePrefixTokens,
    diagnosticsEnabled:
      typeof input.diagnosticsEnabled === 'boolean'
        ? input.diagnosticsEnabled
        : fallback.diagnosticsEnabled
  }
}

export function normalizePromptCacheSettings(
  value: unknown,
  fallback: PromptCacheSettings = DEFAULT_PROMPT_CACHE_SETTINGS
): PromptCacheSettings {
  const input = isRecord(value) ? value : {}
  const fallbackProviders = isRecord(fallback.providers) ? fallback.providers : {}
  const inputProviders = isRecord(input.providers) ? input.providers : {}
  const providers: Partial<Record<ProviderId, PromptCacheProviderSettings>> = {}
  for (const provider of PROVIDERS) {
    const normalized = normalizePromptCacheProviderSettings(
      inputProviders[provider],
      fallbackProviders[provider]
    )
    if (
      normalized.mode !== undefined ||
      normalized.minStablePrefixTokens !== undefined ||
      normalized.diagnosticsEnabled !== undefined
    ) {
      providers[provider] = normalized
    }
  }
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : fallback.enabled !== false,
    providers
  }
}

export function buildPromptCacheCapabilitySummary(
  settingsOrAppSettings?: PromptCacheSettings | Pick<AppSettings, 'promptCache'> | null,
  now: Date = new Date()
): PromptCacheCapabilitySummary {
  const rawSettings =
    settingsOrAppSettings && 'promptCache' in settingsOrAppSettings
      ? settingsOrAppSettings.promptCache
      : settingsOrAppSettings
  const settings = normalizePromptCacheSettings(rawSettings)
  const capabilities = STATIC_CAPABILITIES.map((capability) =>
    capabilityForProvider(capability, settings)
  )
  return {
    generatedAt: now.toISOString(),
    settings,
    capabilities
  }
}

function capabilityForProvider(
  base: StaticCacheCapability,
  settings: PromptCacheSettings
): PromptCacheCapability {
  const providerMode = settings.providers?.[base.provider]?.mode
  const mode = settings.enabled === false ? 'off' : providerMode || 'auto'
  const retired = isRetiredProvider(base.provider)
  return {
    ...base,
    defaultMode: retired || base.guaranteeTier === 'unsupported' ? 'off' : mode,
    retired: base.retired || retired || undefined,
    detail: retired
      ? `${base.detail} ${base.label} cannot start new TaskWraith runs.`
      : base.detail
  }
}

const CACHE_READ_KEYS = [
  'cacheReadInputTokens',
  'cache_read_input_tokens',
  'input_cache_read',
  'cacheReadTokens',
  'cachedInputTokens',
  'cached_input_tokens'
]

const CACHE_CREATION_KEYS = [
  'cacheCreationInputTokens',
  'cache_creation_input_tokens',
  'input_cache_creation',
  'cacheWriteTokens'
]

const INPUT_TOKEN_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input']

function statNumber(stats: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = stats[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed))
    }
  }
  return 0
}

function runTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function aggregatePromptCacheDiagnosticsFromChats(
  chats: ChatRecord[],
  options: { maxRuns?: number; sinceMs?: number; nowMs?: number } = {}
): PromptCacheDiagnosticRow[] {
  const maxRuns = Math.max(1, Math.trunc(options.maxRuns ?? 500))
  const sinceMs = options.sinceMs ?? (options.nowMs ?? Date.now()) - 30 * 24 * 60 * 60 * 1000
  const runs: Array<{
    run: NonNullable<ChatRecord['runs']>[number]
    provider: ProviderId
    at: number
  }> = []
  for (const chat of chats) {
    for (const run of Array.isArray(chat.runs) ? chat.runs : []) {
      const provider = run.provider || chat.provider
      const at = runTimestampMs(run.endedAt) ?? runTimestampMs(run.startedAt) ?? 0
      if (!provider || isRetiredProvider(provider)) continue
      if (!isRecord(run.stats)) continue
      if (at > 0 && at < sinceMs) continue
      runs.push({ run, provider, at })
    }
  }
  runs.sort((a, b) => b.at - a.at)

  const byProvider = new Map<ProviderId, PromptCacheDiagnosticRow>()
  for (const { provider, run, at } of runs.slice(0, maxRuns)) {
    const stats = run.stats as Record<string, unknown>
    const row =
      byProvider.get(provider) ||
      ({
        provider,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        inputTokens: 0,
        runCount: 0
      } satisfies PromptCacheDiagnosticRow)
    row.cacheReadInputTokens += statNumber(stats, CACHE_READ_KEYS)
    row.cacheCreationInputTokens += statNumber(stats, CACHE_CREATION_KEYS)
    row.inputTokens += statNumber(stats, INPUT_TOKEN_KEYS)
    row.runCount += 1
    if (at > 0 && (!row.lastRunAt || at > row.lastRunAt)) row.lastRunAt = at
    byProvider.set(provider, row)
  }

  return [...byProvider.values()].sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
