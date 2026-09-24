/**
 * Ask the local Ollama daemon whether it is signed in to an ollama.com account.
 *
 * `discoverOllamaCloud` is the canonical answer, so this is a thin adapter that
 * reduces it to the non-secret fields the sign-in memory is allowed to keep.
 * The account id and email the daemon returns are never read here.
 */

import { discoverOllamaCloud } from './OllamaCloudCatalog'
import { normalizeOllamaBaseUrl } from './OllamaProvider'
import type { OllamaCliSignInObservation } from './OllamaCliSignInMemory'

export async function probeOllamaCloudAccount(
  baseUrl: string | null | undefined,
  options: { apiKey?: string | null; timeoutMs?: number } = {}
): Promise<OllamaCliSignInObservation> {
  const cloud = await discoverOllamaCloud(normalizeOllamaBaseUrl(baseUrl), {
    apiKey: options.apiKey ?? null,
    ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {})
  })
  return {
    supported: cloud.supported,
    authenticated: cloud.authenticated,
    ...(cloud.plan ? { plan: cloud.plan } : {}),
    ...(cloud.apiKeyConfigured ? { apiKeyConfigured: true } : {})
  }
}
