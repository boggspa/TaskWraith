import type { AppSettings, ProviderId } from './store/types'
import { resolveCliProviderBinary } from './providers/CliProviderRuntime'
import { getOllamaStatusSnapshot } from './ollama/OllamaProvider'
import { discoverAuthenticatedAgyModels } from './antigravity/AntigravityModelDiscovery'
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
  /** Official `agy models` probe; only called after explicit AntiGravity opt-in. */
  getAntigravityConfiguredModels?: (settings: AppSettings) => Promise<ConfiguredProviderModel[]>
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

type ProviderProbeOutcome = 'configured' | 'unconfigured' | 'unknown'

interface ProviderProbe {
  provider: ProviderId
  /** A timeout must never make AntiGravity visible or eligible for a roster. */
  includeWhenUnknown?: boolean
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
  return ['oauth', 'api-key', 'authenticated', 'chatgpt', 'not-required'].includes(authState)
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
  if (settings.codexUsageCredential?.encryptedAccessToken) configured.add('codex')
  if ((settings.geminiAuthProfiles?.length ?? 0) > 0 || settings.defaultGeminiAuthProfileId) {
    configured.add('gemini')
  }
  return configured
}

function configuredProviderProbes(
  settings: AppSettings,
  dependencies: DetectConfiguredProvidersDependencies
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
  if (isAntigravityOptInEnabled(settings)) {
    const getAntigravityConfiguredModels =
      dependencies.getAntigravityConfiguredModels ?? discoverAuthenticatedAgyModels
    probes.push({
      provider: 'antigravity',
      includeWhenUnknown: false,
      run: async () => {
        const models = await getAntigravityConfiguredModels(settings)
        return { configured: models.length > 0, models }
      }
    })
  }
  return probes
}

/**
 * The set of providers the user has actually set up ("logged in + activated") —
 * used to seed a new ensemble's default roster with only usable providers
 * instead of all six.
 *
 *  - claude / codex / gemini: gated by their auth field in settings.
 *  - kimi: roster discovery checks an installed binary plus OAuth/provider-key
 *    authentication once after first paint. This is presentation only; the
 *    exact runtime is still structurally admitted again before execution.
 *  - grok / cursor: no settings auth (CLI-based), so we probe the CLI the
 *    same way the runner resolves it — a non-null binary path means present
 *    and runnable. Cursor is live again (Path-B contained `--sandbox` runs,
 *    see retiredProviders.ts); seeding is presence-only, and the run path
 *    still enforces the containment qualification at dispatch.
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
  const probes = configuredProviderProbes(settings, dependencies)

  const outcomes = await Promise.all(
    probes.map(async ({ provider, run, includeWhenUnknown = true }) => ({
      provider,
      includeWhenUnknown,
      ...(await boundedProviderProbe(Promise.resolve().then(run), deadlineMs))
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

function configuredProviderCacheKey(settings: AppSettings): string {
  return JSON.stringify({
    claudeApiKey: Boolean(settings.claudeApiKey),
    claudeBinaryPath: settings.claudeBinaryPath || '',
    codexUsageCredential: Boolean(settings.codexUsageCredential?.encryptedAccessToken),
    geminiAuthProfileIds: (settings.geminiAuthProfiles || []).map((profile) => profile.id),
    defaultGeminiAuthProfileId: settings.defaultGeminiAuthProfileId || '',
    kimiBinaryPath: settings.kimiBinaryPath || '',
    ollamaBaseUrl: settings.ollamaBaseUrl || '',
    ollamaDefaultModel: settings.ollamaDefaultModel || '',
    antigravityEnabled: settings.antigravityEnabled === true,
    antigravityOptInAcceptedAt: settings.antigravityOptInAcceptedAt || null
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
    const key = configuredProviderCacheKey(settings)
    if (startedKey === key) return
    startedKey = key
    completedKey = null
    rosterConfigured = settingsConfiguredProviders(settings)
    confirmedConfigured = new Set()
    configuredModels = new Map()
    const currentGeneration = ++generation
    const probes = configuredProviderProbes(settings, dependencies)
    let remaining = probes.length
    if (remaining === 0) {
      completedKey = key
      return
    }

    probes.forEach(({ provider, run, includeWhenUnknown = true }, index) => {
      const timer = setTimeout(() => {
        void boundedProviderProbe(Promise.resolve().then(run), deadlineMs).then(({ outcome, result }) => {
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
          if (remaining === 0) completedKey = key
        })
      }, index * staggerMs)
      timer.unref?.()
    })
  }

  return {
    start,
    snapshot: async (settings) => {
      const key = configuredProviderCacheKey(settings)
      return completedKey === key ? new Set(rosterConfigured) : new Set()
    },
    statusSnapshot: (settings) => {
      const key = configuredProviderCacheKey(settings)
      if (startedKey !== key) {
        return { ready: false, configuredProviders: new Set() }
      }
      return {
        ready: completedKey === key,
        configuredProviders: new Set(confirmedConfigured)
      }
    },
    modelsSnapshot: (settings) => {
      const key = configuredProviderCacheKey(settings)
      return completedKey === key
        ? new Map([...configuredModels].map(([provider, models]) => [provider, [...models]]))
        : new Map()
    }
  }
}
