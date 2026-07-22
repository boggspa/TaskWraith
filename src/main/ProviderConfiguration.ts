import type { AppSettings, ProviderId } from './store/types'
import { resolveCliProviderBinary } from './providers/CliProviderRuntime'
import { getOllamaStatusSnapshot } from './ollama/OllamaProvider'

export interface DetectConfiguredProvidersDependencies {
  /** Authoritative managed-run snapshot. Omit to exclude Kimi fail-closed. */
  getKimiManagedStatus?: () => Promise<{ available: boolean; authState?: string }>
  resolveProviderBinary?: (
    provider: ProviderId
  ) => Promise<{ binaryPath: string | null | undefined }>
  getOllamaStatus?: (
    settings: AppSettings
  ) => Promise<{ available: boolean; modelCount: number }>
  /**
   * Roster discovery is advisory, never provider execution authority. Keep its
   * latency bounded so an unavailable CLI/local service cannot pin New Chat.
   */
  probeDeadlineMs?: number
}

export interface ConfiguredProviderDetectorOptions {
  cacheTtlMs?: number
  now?: () => number
}

export const CONFIGURED_PROVIDER_PROBE_DEADLINE_MS = 1_000
export const CONFIGURED_PROVIDER_CACHE_TTL_MS = 30_000

type ProviderProbeOutcome = 'configured' | 'unconfigured' | 'unknown'

function boundedProviderProbe(
  probe: Promise<boolean>,
  deadlineMs: number
): Promise<ProviderProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      resolve('unknown')
    }, deadlineMs)
    timer.unref?.()

    void probe.then(
      (configured) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(configured ? 'configured' : 'unconfigured')
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve('unconfigured')
      }
    )
  })
}

/**
 * The set of providers the user has actually set up ("logged in + activated") —
 * used to seed a new ensemble's default roster with only usable providers
 * instead of all six.
 *
 *  - claude / codex / gemini: gated by their auth field in settings.
 *  - kimi: included only when the exact runtime is admitted AND its admitted
 *    snapshot reports OAuth or provider-key authentication. Raw key,
 *    credential, or binary presence is never managed-run readiness.
 *  - grok / cursor: no settings auth (CLI-based), so we probe the CLI the
 *    same way the runner resolves it — a non-null binary path means present
 *    and runnable. Cursor is live again (Path-B contained `--sandbox` runs,
 *    see retiredProviders.ts); seeding is presence-only, and the run path
 *    still enforces the containment qualification at dispatch.
 *
 * Async because the grok/cursor probes stat the filesystem; callers
 * pre-compute the set and pass it into the (synchronous) ensemble-creation
 * path.
 */
export async function detectConfiguredProviders(
  settings: AppSettings,
  dependencies: DetectConfiguredProvidersDependencies = {}
): Promise<Set<ProviderId>> {
  const configured = new Set<ProviderId>()
  const resolveProviderBinary = dependencies.resolveProviderBinary ?? resolveCliProviderBinary
  const getOllamaStatus = dependencies.getOllamaStatus ?? getOllamaStatusSnapshot
  const deadlineMs =
    Number.isFinite(dependencies.probeDeadlineMs) && (dependencies.probeDeadlineMs ?? 0) > 0
      ? Math.floor(dependencies.probeDeadlineMs!)
      : CONFIGURED_PROVIDER_PROBE_DEADLINE_MS

  if (settings.claudeApiKey || settings.claudeBinaryPath) configured.add('claude')
  if (settings.codexUsageCredential?.encryptedAccessToken) configured.add('codex')
  if ((settings.geminiAuthProfiles?.length ?? 0) > 0 || settings.defaultGeminiAuthProfileId) {
    configured.add('gemini')
  }
  const probes: Array<{ provider: ProviderId; probe: Promise<boolean> }> = []
  if (dependencies.getKimiManagedStatus) {
    probes.push({
      provider: 'kimi',
      probe: dependencies.getKimiManagedStatus().then((status) => {
        const authState = String(status.authState || '').trim().toLowerCase()
        return (
          status.available === true &&
          ['oauth', 'api-key', 'authenticated'].includes(authState)
        )
      })
    })
  }
  probes.push({
    provider: 'ollama',
    probe: getOllamaStatus(settings).then(
      (status) => status.available && status.modelCount > 0
    )
  })
  for (const provider of ['grok', 'cursor'] as const) {
    probes.push({
      provider,
      probe: resolveProviderBinary(provider).then((resolved) => Boolean(resolved.binaryPath))
    })
  }

  const outcomes = await Promise.all(
    probes.map(async ({ provider, probe }) => ({
      provider,
      outcome: await boundedProviderProbe(probe, deadlineMs)
    }))
  )
  for (const { provider, outcome } of outcomes) {
    // A timeout is uncertainty, not proof that the user lacks the provider.
    // Fail open ONLY for default-roster composition: actual provider dispatch
    // still passes the normal runtime admission/authentication gates.
    if (outcome === 'configured' || outcome === 'unknown') configured.add(provider)
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
    ollamaDefaultModel: settings.ollamaDefaultModel || ''
  })
}

/**
 * Share the bounded discovery flight across rapid create actions and retain a
 * short-lived immutable snapshot. Binary installs outside settings eventually
 * refresh at the TTL; settings/auth changes invalidate immediately via key.
 */
export function createConfiguredProviderDetector(
  dependencies: DetectConfiguredProvidersDependencies = {},
  options: ConfiguredProviderDetectorOptions = {}
): (settings: AppSettings) => Promise<Set<ProviderId>> {
  const cacheTtlMs =
    Number.isFinite(options.cacheTtlMs) && (options.cacheTtlMs ?? -1) >= 0
      ? Math.floor(options.cacheTtlMs!)
      : CONFIGURED_PROVIDER_CACHE_TTL_MS
  const now = options.now ?? Date.now
  let cached: { key: string; expiresAt: number; providers: Set<ProviderId> } | null = null
  let flight: { key: string; promise: Promise<Set<ProviderId>> } | null = null

  return (settings) => {
    const key = configuredProviderCacheKey(settings)
    if (cached?.key === key && now() < cached.expiresAt) {
      return Promise.resolve(new Set(cached.providers))
    }
    if (flight?.key === key) {
      return flight.promise.then((providers) => new Set(providers))
    }

    const promise = detectConfiguredProviders(settings, dependencies)
      .then((providers) => {
        cached = {
          key,
          expiresAt: now() + cacheTtlMs,
          providers: new Set(providers)
        }
        return new Set(providers)
      })
      .finally(() => {
        if (flight?.promise === promise) flight = null
      })
    flight = { key, promise }
    return promise.then((providers) => new Set(providers))
  }
}
