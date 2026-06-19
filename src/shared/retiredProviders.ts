/**
 * Node-builtin-FREE registry of RETIRED providers.
 *
 * A retired provider is preserved everywhere we DECODE or RENDER history — the
 * `ProviderId` union, labels/glyphs/theme tokens, the sanitize accept-sets
 * (`assertProviderId`), transcript export, the historical token ledger, and the
 * adapter registry (so `require(provider).cancel()` still works) — but is
 * removed from every surface that OFFERS or RUNS it: pickers, onboarding,
 * ensemble seeds, dispatch, and the live usage meter.
 *
 * Gemini was retired on 2026-06-18 when Google ended the Gemini-CLI consumer
 * OAuth path; chat history and metadata persist, but no new Gemini runs.
 *
 * Both the main process and the renderer import this module, so it MUST stay
 * free of node builtins (a node import reachable from the renderer blanks the
 * window — see MEMORY.md). Mirrors the discipline of `remoteWorkspaceDefaults`.
 */

/** Providers kept only for historical decode/render — never offered or run. */
export const RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set<string>(['gemini'])

/**
 * The structural fallback "live" provider used wherever code previously
 * defaulted to `'gemini'` (new-chat seed, projection fallbacks, malformed-record
 * coercion). Claude is the boring always-valid default; the *user-facing*
 * new-chat default is sticky last-used (see slice 6), not this constant.
 */
export const DEFAULT_PROVIDER = 'claude' as const

/** True when `provider` is retired (offer/run surfaces must exclude it). */
export function isRetiredProvider(provider: string | null | undefined): boolean {
  return provider != null && RETIRED_PROVIDER_IDS.has(provider)
}

/**
 * Coerce a possibly-missing-or-retired provider to a live one: returns the input
 * unchanged when it is a non-retired, non-empty provider, otherwise
 * `DEFAULT_PROVIDER`. Use this on READ wherever a default provider is needed, so
 * retired values migrate to a runnable provider WITHOUT mutating stored history.
 *
 * Generic over the input so the return type stays assignable to the caller's
 * provider type (e.g. `ProviderId`) without this node-free module importing it.
 */
export function coerceLiveProvider<T extends string>(
  provider: T | null | undefined
): T | typeof DEFAULT_PROVIDER {
  if (provider != null && provider.length > 0 && !isRetiredProvider(provider)) {
    return provider
  }
  return DEFAULT_PROVIDER
}
