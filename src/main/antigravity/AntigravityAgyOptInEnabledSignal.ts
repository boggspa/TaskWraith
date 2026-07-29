/**
 * Main-only, synchronous admission signal for the AGY/CLI ban-risk lane,
 * shared by the interactive run-admission chokepoints (`ComposerService`,
 * `ChatService`, `RunQueueService`) that decide whether AntiGravity may start
 * a new run.
 *
 * This is the deliberate twin of `AntigravityGeminiApiKeyConfiguredSignal`,
 * and it exists for the same structural reason: those chokepoints have no
 * `AppSettings` access, and giving them one would mean threading settings
 * through three service constructors (and 11 call sites in `ChatService`) to
 * evaluate a two-field predicate. `index.ts` wires a tiny closure here once
 * instead.
 *
 * WHY IT WAS NEEDED (2026-07-29): all three chokepoints admitted
 * `antigravity` on the Gemini API **key** signal alone. The two lanes are
 * independent everywhere else, so that single check linked them — an
 * opted-in user with no API key could pick an agy quota model and physically
 * could not send it ("antigravity is unavailable for new runs"), while a
 * stored key envelope admitted agy models that have nothing to do with it.
 * Presence of a key is not evidence about the agy lane, in either direction.
 *
 * Reports ONLY a boolean, never settings or their contents, and defaults to
 * `false` (fail closed) until `index.ts` wires the real probe. It never
 * gates, reads, or affects the Gemini API-key lane, which keeps its own
 * independent `isAntigravityGeminiApiKeyConfigured` check at every call site.
 */

let probe: () => boolean = () => false

export function isAntigravityAgyOptInEnabled(): boolean {
  try {
    return probe() === true
  } catch {
    return false
  }
}

/** Wired exactly once by `index.ts`, from persisted settings. */
export function setAntigravityAgyOptInEnabledProbe(next: () => boolean): void {
  probe = next
}

/** Test-only: restore the fail-closed default probe between test cases. */
export function resetAntigravityAgyOptInEnabledProbeForTests(): void {
  probe = () => false
}
