import type { AppSettings, ProviderId } from './store/types'
import { resolveCliProviderBinary } from './providers/CliProviderRuntime'
import { getOllamaStatusSnapshot } from './ollama/OllamaProvider'
import { discoverAuthenticatedAgyModels } from './antigravity/AntigravityModelDiscovery'
import type { AntigravityCombinedCatalogModel } from './antigravity/AntigravityCombinedModelCatalog'
import { isAntigravityOptInEnabled } from '../shared/retiredProviders'

export interface ConfiguredProviderModel {
  id: string
  label: string
}

export interface DetectConfiguredProvidersDependencies {
  /** Lightweight binary + credential presence checks used only for picker/roster presentation. */
  getCodexConfiguredStatus?: (
    settings: AppSettings
  ) => Promise<{ available: boolean; authState?: string }>
  getClaudeConfiguredStatus?: (
    settings: AppSettings
  ) => Promise<{ available: boolean; authState?: string }>
  /**
   * Lightweight roster-only status. Production checks binary + auth presence;
   * full Kimi structural admission remains on the execution path.
   */
  getKimiConfiguredStatus?: () => Promise<{ available: boolean; authState?: string }>
  resolveProviderBinary?: (
    provider: ProviderId
  ) => Promise<{ binaryPath: string | null | undefined }>
  getOllamaStatus?: (
    settings: AppSettings
  ) => Promise<{ available: boolean; modelCount: number }>
  /** Count of Pi upstreams with a stored BYOK key; 0 keeps pi unconfigured. */
  getPiConfiguredUpstreamCount?: () => number
  /** Official `agy models` probe; only called after opt-in or API-key admission. */
  getAntigravityConfiguredModels?: (settings: AppSettings) => Promise<ConfiguredProviderModel[]>
  /** Combined authenticated agy + Gemini API catalog; called only after lane admission. */
  getAntigravityCombinedModels?: (settings: AppSettings) => Promise<AntigravityCombinedCatalogModel[]>
  /** Nonsecret key-generation identity used to invalidate a completed catalog. */
  getAntigravityGeminiApiKeyGeneration?: (settings: AppSettings) => string | null
  /** Called after a complete cached generation; never authorizes a provider. */
  onDiscoveryComplete?: (settings: AppSettings) => void
  /**
   * Roster discovery is advisory, never provider execution authority. Keep its
   * latency bounded so an unavailable CLI/local service cannot pin New Chat.
   */
  probeDeadlineMs?: number
}

export interface ConfiguredProviderDetectorOptions {
  staggerMs?: number
}

export interface ConfiguredProviderDiscoveryStatus {
  ready: boolean
  configuredProviders: Set<ProviderId>
}

export const CONFIGURED_PROVIDER_PROBE_DEADLINE_MS = 1_000
export const CONFIGURED_PROVIDER_PROBE_STAGGER_MS = 250
// The AntiGravity catalog has its own 900ms per-lane fallback window. Give the
// outer configured-provider probe enough scheduler headroom to receive that
// consent-and-binary-gated fallback instead of racing it at the 1s generic
// deadline and publishing a misleading ready-but-empty snapshot.
export const ANTIGRAVITY_CONFIGURED_CATALOG_PROBE_DEADLINE_MS = 1_500

type ProviderProbeOutcome = 'configured' | 'unconfigured' | 'unknown'

interface ProviderProbe {
  provider: ProviderId
  /** A timeout must never make AntiGravity visible or eligible for a roster. */
  includeWhenUnknown?: boolean
  /** Provider-specific deadline for a nested bounded probe. */
  deadlineMs?: number
  run: () => Promise<ProviderProbeResult>
}

interface ProviderProbeResult {
  configured: boolean
  models?: ConfiguredProviderModel[]
}

function configuredStatusIsAuthenticated(status: {
  available: boolean
  authState?: string
}): boolean {
  if (!status.available) return false
  const authState = String(status.authState || '')
    .trim()
    .toLowerCase()
  return ['oauth', 'api-key', 'apikey', 'authenticated', 'chatgpt', 'not-required'].includes(
    authState
  )
}

function hasConfiguredGeminiApiKey(generation: string | null | undefined): boolean {
  const normalized = generation?.trim()
  return Boolean(
    normalized &&
      normalized !== 'missing' &&
      normalized !== 'unconfigured' &&
      normalized !== 'unavailable'
  )
}

function boundedProviderProbe(
  probe: Promise<ProviderProbeResult>,
  deadlineMs: number
): Promise<{ outcome: ProviderProbeOutcome; result?: ProviderProbeResult }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      resolve({ outcome: 'unknown' })
    }, deadlineMs)
    timer.unref?.()

    void probe.then(
      (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ outcome: result.configured ? 'configured' : 'unconfigured', result })
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ outcome: 'unconfigured' })
      }
    )
  })
}

function settingsConfiguredProviders(settings: AppSettings): Set<ProviderId> {
  const configured = new Set<ProviderId>()
  if (settings.claudeApiKey || settings.claudeBinaryPath) configured.add('claude')
  // Codex usage imports are quota telemetry only. Runtime configuration is
  // established exclusively by the private-home auth probe below.
  if ((settings.geminiAuthProfiles?.length ?? 0) > 0 || settings.defaultGeminiAuthProfileId) {
    configured.add('gemini')
  }
  return configured
}

function configuredProviderProbes(
  settings: AppSettings,
  dependencies: DetectConfiguredProvidersDependencies,
  deadlineMs: number = CONFIGURED_PROVIDER_PROBE_DEADLINE_MS
): ProviderProbe[] {
  const resolveProviderBinary = dependencies.resolveProviderBinary ?? resolveCliProviderBinary
  const getOllamaStatus = dependencies.getOllamaStatus ?? getOllamaStatusSnapshot
  const probes: ProviderProbe[] = []
  if (dependencies.getCodexConfiguredStatus) {
    probes.push({
      provider: 'codex',
      run: () =>
        dependencies
          .getCodexConfiguredStatus!(settings)
          .then((status) => ({ configured: configuredStatusIsAuthenticated(status) }))
    })
  }
  if (dependencies.getClaudeConfiguredStatus) {
    probes.push({
      provider: 'claude',
      run: () =>
        dependencies
          .getClaudeConfiguredStatus!(settings)
          .then((status) => ({ configured: configuredStatusIsAuthenticated(status) }))
    })
  }
  if (dependencies.getKimiConfiguredStatus) {
    probes.push({
      provider: 'kimi',
      run: () =>
        dependencies
          .getKimiConfiguredStatus!()
          .then((status) => ({ configured: configuredStatusIsAuthenticated(status) }))
    })
  }
  probes.push({
    provider: 'ollama',
    run: () =>
      getOllamaStatus(settings).then((status) => ({
        configured: status.available && status.modelCount > 0
      }))
  })
  for (const provider of ['grok', 'cursor'] as const) {
    probes.push({
      provider,
      run: () =>
        resolveProviderBinary(provider).then((resolved) => ({ configured: Boolean(resolved.binaryPath) }))
    })
  }
  probes.push({
    provider: 'pi',
    // Configured = pi binary present AND at least one allowlisted upstream key
    // stored. Zero keys means zero models, so admitting on binary alone would
    // surface a picker entry that cannot run anything — and for the same
    // reason this probe is NOT fail-open: an unresolved probe must leave pi
    // out of the strict picker snapshot rather than optimistically admit a
    // model-less seat (the AntiGravity `includeWhenUnknown: false` rule).
    includeWhenUnknown: false,
    run: () =>
      resolveProviderBinary('pi').then((resolved) => ({
        configured:
          Boolean(resolved.binaryPath) &&
          (dependencies.getPiConfiguredUpstreamCount?.() ?? 0) > 0
      }))
  })
  let apiKeyConfigured = false
  try {
    apiKeyConfigured = hasConfiguredGeminiApiKey(
      dependencies.getAntigravityGeminiApiKeyGeneration?.(settings)
    )
  } catch {
    apiKeyConfigured = false
  }
  if (isAntigravityOptInEnabled(settings) || apiKeyConfigured) {
    const getAntigravityConfiguredModels =
      dependencies.getAntigravityCombinedModels ??
      dependencies.getAntigravityConfiguredModels ??
      discoverAuthenticatedAgyModels
    probes.push({
      provider: 'antigravity',
      includeWhenUnknown: false,
      deadlineMs: Math.max(deadlineMs, ANTIGRAVITY_CONFIGURED_CATALOG_PROBE_DEADLINE_MS),
      run: async () => {
        const models = await getAntigravityConfiguredModels(settings)
        return { configured: models.length > 0, models }
      }
    })
  }
  return probes
}

/**
 * The set of statically offered providers the user has actually set up
 * ("logged in + activated") — used to seed a new ensemble's default roster
 * with usable providers. Conditional AntiGravity admission is joined by the
 * caller from its authoritative consent/credential-backed catalog.
 *
 *  - claude / codex: gated by their auth field in settings.
 *  - kimi: roster discovery checks an installed binary plus OAuth/provider-key
 *    authentication once after first paint. This is presentation only; the
 *    exact runtime is still structurally admitted again before execution.
 *  - grok / cursor: no settings auth (CLI-based), so we probe the CLI the
 *    same way the runner resolves it — a non-null binary path means present
 *    and runnable. Cursor seeding is presence-only; the live Path-B run
 *    constructs its contained `--sandbox` launch plan at dispatch and reports
 *    broker attachment separately. Management assurance does not decide offer
 *    membership.
 *
 * Async because the local-provider probes use filesystem/network I/O. The
 * production caller prewarms a staggered session snapshot after first paint;
 * chat creation only reads that snapshot and never awaits these probes.
 */
export async function detectConfiguredProviders(
  settings: AppSettings,
  dependencies: DetectConfiguredProvidersDependencies = {}
): Promise<Set<ProviderId>> {
  const configured = settingsConfiguredProviders(settings)
  const deadlineMs =
    Number.isFinite(dependencies.probeDeadlineMs) && (dependencies.probeDeadlineMs ?? 0) > 0
      ? Math.floor(dependencies.probeDeadlineMs!)
      : CONFIGURED_PROVIDER_PROBE_DEADLINE_MS
  const probes = configuredProviderProbes(settings, dependencies, deadlineMs)

  const outcomes = await Promise.all(
    probes.map(async ({ provider, run, includeWhenUnknown = true, deadlineMs: providerDeadlineMs }) => ({
      provider,
      includeWhenUnknown,
      ...(await boundedProviderProbe(Promise.resolve().then(run), providerDeadlineMs ?? deadlineMs))
    }))
  )
  for (const { provider, outcome, includeWhenUnknown } of outcomes) {
    // A timeout is uncertainty, not proof that the user lacks the provider.
    // Fail open ONLY for default-roster composition: actual provider dispatch
    // still passes the normal runtime admission/authentication gates.
    if (outcome === 'configured' || (outcome === 'unknown' && includeWhenUnknown)) {
      configured.add(provider)
    }
  }

  return configured
}

function configuredProviderCacheKey(
  settings: AppSettings,
  dependencies: DetectConfiguredProvidersDependencies = {}
): string {
  return JSON.stringify({
    claudeApiKey: Boolean(settings.claudeApiKey),
    claudeBinaryPath: settings.claudeBinaryPath || '',
    geminiAuthProfileIds: (settings.geminiAuthProfiles || []).map((profile) => profile.id),
    defaultGeminiAuthProfileId: settings.defaultGeminiAuthProfileId || '',
    kimiBinaryPath: settings.kimiBinaryPath || '',
    ollamaBaseUrl: settings.ollamaBaseUrl || '',
    ollamaDefaultModel: settings.ollamaDefaultModel || '',
    antigravityEnabled: settings.antigravityEnabled === true,
    antigravityOptInAcceptedAt: settings.antigravityOptInAcceptedAt || null,
    antigravityGeminiApiDisclosureAcceptedAt:
      settings.antigravityGeminiApiDisclosureAcceptedAt || null,
    antigravityGeminiApiKeyGeneration:
      dependencies.getAntigravityGeminiApiKeyGeneration?.(settings) ?? null
  })
}

/**
 * Run each advisory provider check once per settings generation, staggered on
 * post-paint timers. Chat creation reads only the completed snapshot and never
 * starts or awaits discovery; until the background pass completes it returns
 * an empty set, which intentionally selects the full recommended default panel.
 */
export function createConfiguredProviderDetector(
  dependencies: DetectConfiguredProvidersDependencies = {},
  options: ConfiguredProviderDetectorOptions = {}
): {
  start: (settings: AppSettings) => void
  refresh: (settings: AppSettings) => void
  snapshot: (settings: AppSettings) => Promise<Set<ProviderId>>
  statusSnapshot: (settings: AppSettings) => ConfiguredProviderDiscoveryStatus
  modelsSnapshot: (settings: AppSettings) => ReadonlyMap<ProviderId, ConfiguredProviderModel[]>
} {
  const staggerMs =
    Number.isFinite(options.staggerMs) && (options.staggerMs ?? -1) >= 0
      ? Math.floor(options.staggerMs!)
      : CONFIGURED_PROVIDER_PROBE_STAGGER_MS
  const deadlineMs =
    Number.isFinite(dependencies.probeDeadlineMs) && (dependencies.probeDeadlineMs ?? 0) > 0
      ? Math.floor(dependencies.probeDeadlineMs!)
      : CONFIGURED_PROVIDER_PROBE_DEADLINE_MS
  let generation = 0
  let startedKey: string | null = null
  let completedKey: string | null = null
  let rosterConfigured = new Set<ProviderId>()
  let confirmedConfigured = new Set<ProviderId>()
  let configuredModels = new Map<ProviderId, ConfiguredProviderModel[]>()

  const start = (settings: AppSettings): void => {
    const key = configuredProviderCacheKey(settings, dependencies)
    if (startedKey === key) return
    startedKey = key
    completedKey = null
    rosterConfigured = settingsConfiguredProviders(settings)
    confirmedConfigured = new Set()
    configuredModels = new Map()
    const currentGeneration = ++generation
    const probes = configuredProviderProbes(settings, dependencies, deadlineMs)
    let remaining = probes.length
    if (remaining === 0) {
      completedKey = key
      dependencies.onDiscoveryComplete?.(settings)
      return
    }

    probes.forEach(({ provider, run, includeWhenUnknown = true, deadlineMs: providerDeadlineMs }, index) => {
      const timer = setTimeout(() => {
        void boundedProviderProbe(
          Promise.resolve().then(run),
          providerDeadlineMs ?? deadlineMs
        ).then(({ outcome, result }) => {
          if (currentGeneration !== generation) return
          if (outcome === 'configured') {
            rosterConfigured.add(provider)
            confirmedConfigured.add(provider)
            if (result?.models?.length) configuredModels.set(provider, [...result.models])
          } else if (outcome === 'unknown' && includeWhenUnknown) {
            rosterConfigured.add(provider)
          } else {
            confirmedConfigured.delete(provider)
            configuredModels.delete(provider)
          }
          remaining -= 1
          if (remaining === 0) {
            completedKey = key
            dependencies.onDiscoveryComplete?.(settings)
          }
        })
      }, index * staggerMs)
      timer.unref?.()
    })
  }

  return {
    refresh: (settings) => {
      startedKey = null
      start(settings)
    },
    start,
    snapshot: async (settings) => {
      const key = configuredProviderCacheKey(settings, dependencies)
      return completedKey === key ? new Set(rosterConfigured) : new Set()
    },
    statusSnapshot: (settings) => {
      const key = configuredProviderCacheKey(settings, dependencies)
      if (startedKey !== key) {
        return { ready: false, configuredProviders: new Set() }
      }
      return {
        ready: completedKey === key,
        configuredProviders: new Set(confirmedConfigured)
      }
    },
    modelsSnapshot: (settings) => {
      const key = configuredProviderCacheKey(settings, dependencies)
      return completedKey === key
        ? new Map([...configuredModels].map(([provider, models]) => [provider, [...models]]))
        : new Map()
    }
  }
}
