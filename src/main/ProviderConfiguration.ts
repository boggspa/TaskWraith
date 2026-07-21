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

  if (settings.claudeApiKey || settings.claudeBinaryPath) configured.add('claude')
  if (settings.codexUsageCredential?.encryptedAccessToken) configured.add('codex')
  if ((settings.geminiAuthProfiles?.length ?? 0) > 0 || settings.defaultGeminiAuthProfileId) {
    configured.add('gemini')
  }
  if (dependencies.getKimiManagedStatus) {
    try {
      const status = await dependencies.getKimiManagedStatus()
      const authState = String(status.authState || '').trim().toLowerCase()
      if (
        status.available === true &&
        ['oauth', 'api-key', 'authenticated'].includes(authState)
      ) {
        configured.add('kimi')
      }
    } catch {
      // Admission/status failure → exclude Kimi fail-closed.
    }
  }
  try {
    const ollamaStatus = await getOllamaStatus(settings)
    if (ollamaStatus.available && ollamaStatus.modelCount > 0) configured.add('ollama')
  } catch {
    // Unreachable local service -> not configured.
  }

  await Promise.all(
    (['grok', 'cursor'] as const).map(async (provider) => {
      try {
        const resolved = await resolveProviderBinary(provider)
        if (resolved.binaryPath) configured.add(provider)
      } catch {
        // Unresolved / probe error → treat as not configured.
      }
    })
  )

  return configured
}
