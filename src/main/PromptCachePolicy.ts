import type {
  AppSettings,
  PromptCacheCapability,
  PromptCacheCapabilitySummary,
  PromptCacheMode,
  PromptCacheProviderSettings,
  PromptCacheSettings,
  ProviderId,
  UsageRecord
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
  'antigravity',
  'pi'
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
    antigravity: { mode: 'off' },
    // Pi's upstreams cache provider-side with no client control.
    pi: { mode: 'off' }
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
    guaranteeTier: 'best-effort',
    guaranteeLabel: 'Best effort',
    detail:
      'Managed Cursor runs use an opaque cursor-agent CLI transport. TaskWraith records cache tokens when emitted but cannot force provider-side caching or control cache breakpoints.',
    controllable: false,
    supportsModeControl: false
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
  },
  {
    provider: 'pi',
    label: 'Pi',
    transport: 'cli-opaque',
    guaranteeTier: 'automatic-observed',
    guaranteeLabel: 'Automatic',
    detail:
      'Pi upstreams (DeepSeek, GLM, Qwen, MiniMax and friends) apply their own provider-side caching where supported; pi reports cache-read tokens per turn and TaskWraith records them as observed. No cache breakpoints can be forced.',
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

function usageCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/**
 * Settings → Providers → Prompt caching diagnostics, aggregated from the usage
 * journal rather than from chat records.
 *
 * This used to take `AppStore.getChats()`: a synchronous parse of EVERY chat
 * file on the main process — measured on a real profile 2026-10-07 at 572
 * files / 1.25GB / ~11.6s — to read a few token counters per run. Main
 * blocked means every window blocked, so opening the Providers tab froze the
 * whole app for the duration. The usage journal already carries the same
 * per-run `cacheReadInputTokens` / `cacheCreationInputTokens` facts (the
 * Claude, Codex and Pi totals matched the chat-record totals exactly on that
 * profile), is served from the hot checkpoint plus journal (~25ms), and is
 * what the Model usage table on the same panel reads. Never widen this back
 * to a corpus read; extend the usage record instead.
 *
 * `reset_hint` rows are quota hints, not runs. Time-bucket aggregates (external
 * activity scans) carry `runCount`; count it, never 1 per record.
 */
export function aggregatePromptCacheDiagnosticsFromUsage(
  records: readonly UsageRecord[],
  options: { maxRuns?: number; sinceMs?: number; nowMs?: number } = {}
): PromptCacheDiagnosticRow[] {
  const maxRuns = Math.max(1, Math.trunc(options.maxRuns ?? 500))
  const sinceMs = options.sinceMs ?? (options.nowMs ?? Date.now()) - 30 * 24 * 60 * 60 * 1000
  const runs: Array<{ record: UsageRecord; provider: ProviderId; at: number }> = []
  for (const record of records) {
    const provider = record.provider
    if (!provider || isRetiredProvider(provider)) continue
    if (record.usageKind === 'reset_hint') continue
    const at = usageCount(record.timestamp)
    if (at > 0 && at < sinceMs) continue
    runs.push({ record, provider, at })
  }
  runs.sort((a, b) => b.at - a.at)

  const byProvider = new Map<ProviderId, PromptCacheDiagnosticRow>()
  for (const { provider, record, at } of runs.slice(0, maxRuns)) {
    const row =
      byProvider.get(provider) ||
      ({
        provider,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        inputTokens: 0,
        runCount: 0
      } satisfies PromptCacheDiagnosticRow)
    row.cacheReadInputTokens += usageCount(record.cacheReadInputTokens)
    row.cacheCreationInputTokens += usageCount(record.cacheCreationInputTokens)
    row.inputTokens += usageCount(record.inputTokens)
    row.runCount += Math.max(1, usageCount(record.runCount ?? 1))
    if (at > 0 && (!row.lastRunAt || at > row.lastRunAt)) row.lastRunAt = at
    byProvider.set(provider, row)
  }

  return [...byProvider.values()].sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
