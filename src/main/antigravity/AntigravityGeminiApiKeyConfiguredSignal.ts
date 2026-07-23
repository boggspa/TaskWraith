/**
 * Main-only, synchronous, nonsecret admission signal shared by the
 * interactive-dispatch chokepoints (`MainSanitizers.selectableProviderIds` /
 * `assertLiveProviderId`, `ComposerService`, `ChatService`) that decide
 * whether AntiGravity may start a new run. Those chokepoints cannot import
 * the dedicated `AntigravityGeminiApiSecretStore` directly without creating a
 * backward dependency on the `index.ts` composition root, so `index.ts`
 * wires a tiny closure here once the store exists instead.
 *
 * This reports ONLY a boolean configured/not-configured state -- never a
 * key, status object, or error detail -- and defaults to `false` (fail
 * closed) until `index.ts` wires the real probe. It never gates, reads, or
 * affects the separate AGY/CLI ban-risk opt-in lane, which keeps its own
 * independent `isAntigravityOptInEnabled` consent check at every call site.
 */

let probe: () => boolean = () => false

export function isAntigravityGeminiApiKeyConfigured(): boolean {
  try {
    return probe() === true
  } catch {
    return false
  }
}

/** Wired exactly once by `index.ts` after the dedicated secret store exists. */
export function setAntigravityGeminiApiKeyConfiguredProbe(next: () => boolean): void {
  probe = next
}

/** Test-only: restore the fail-closed default probe between test cases. */
export function resetAntigravityGeminiApiKeyConfiguredProbeForTests(): void {
  probe = () => false
}
