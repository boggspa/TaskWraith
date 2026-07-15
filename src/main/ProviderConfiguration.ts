import { promises as fsp } from 'fs'
import type { AppSettings, ProviderId } from './store/types'
import { resolveCliProviderBinary } from './providers/CliProviderRuntime'
import { getOllamaStatusSnapshot } from './ollama/OllamaProvider'
import { kimiCredentialCandidatePaths } from './providers/KimiCredential'

/** True when a Kimi OAuth credential is present (Kimi Code home first, legacy
 *  fallback) — i.e. the user is signed in via `kimi login` even without an API
 *  key or an explicit binary path in settings. */
async function kimiOAuthCredentialPresent(): Promise<boolean> {
  for (const path of kimiCredentialCandidatePaths()) {
    try {
      await fsp.access(path)
      return true
    } catch {
      // Try the next candidate.
    }
  }
  return false
}

/**
 * The set of providers the user has actually set up ("logged in + activated") —
 * used to seed a new ensemble's default roster with only usable providers
 * instead of all six.
 *
 *  - claude / codex / gemini / kimi: gated by their auth field in settings
 *    (API key, CLI binary path, OAuth profile, or imported credential).
 *  - grok / cursor: no settings auth (they're CLI-based), so we probe the CLI
 *    the SAME way the runner resolves it — `resolveCliProviderBinary` checks the
 *    runtime profile, `~/.grok/bin` / `~/.local/bin`, common install dirs, and
 *    PATH. A non-null binary path means it's present and runnable.
 *
 * Async because the grok/cursor probe stats the filesystem; callers pre-compute
 * the set and pass it into the (synchronous) ensemble-creation path.
 */
export async function detectConfiguredProviders(settings: AppSettings): Promise<Set<ProviderId>> {
  const configured = new Set<ProviderId>()

  if (settings.claudeApiKey || settings.claudeBinaryPath) configured.add('claude')
  if (settings.codexUsageCredential?.encryptedAccessToken) configured.add('codex')
  if ((settings.geminiAuthProfiles?.length ?? 0) > 0 || settings.defaultGeminiAuthProfileId) {
    configured.add('gemini')
  }
  // kimi: an API key or explicit binary path, OR an OAuth-signed-in Kimi Code
  // install — the binary auto-resolves (~/.kimi-code/bin) and a credential file
  // exists, with neither field set in settings (dossier slice 3 OAuth-aware arm).
  if (settings.kimiApiKey || settings.kimiBinaryPath) {
    configured.add('kimi')
  } else {
    try {
      const resolvedKimi = await resolveCliProviderBinary('kimi')
      if (resolvedKimi.binaryPath && (await kimiOAuthCredentialPresent())) configured.add('kimi')
    } catch {
      // Unresolved binary / probe error → treat as not configured.
    }
  }
  try {
    const ollamaStatus = await getOllamaStatusSnapshot(settings)
    if (ollamaStatus.available && ollamaStatus.modelCount > 0) configured.add('ollama')
  } catch {
    // Unreachable local service -> not configured.
  }

  await Promise.all(
    (['grok', 'cursor'] as const).map(async (provider) => {
      try {
        const resolved = await resolveCliProviderBinary(provider)
        if (resolved.binaryPath) configured.add(provider)
      } catch {
        // Unresolved / probe error → treat as not configured.
      }
    })
  )

  return configured
}
