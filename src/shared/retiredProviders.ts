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
 * Canonical offer/run set. Known ids omitted here remain valid for historical
 * decode and rendering, but must not be used to create or dispatch new work.
 * Cursor is live again: Path-B runs use the contained `--sandbox` argv.
 */
export const LIVE_SELECTABLE_PROVIDER_IDS = [
  'codex',
  'claude',
  'kimi',
  'cursor',
  'grok',
  'ollama'
] as const
const LIVE_SELECTABLE_PROVIDER_ID_SET: ReadonlySet<string> = new Set(
  LIVE_SELECTABLE_PROVIDER_IDS
)

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

/** True only for providers that may be offered, selected, or run now. */
export function isLiveSelectableProvider(
  provider: string | null | undefined
): provider is (typeof LIVE_SELECTABLE_PROVIDER_IDS)[number] {
  return provider != null && LIVE_SELECTABLE_PROVIDER_ID_SET.has(provider)
}

/**
 * True for providers an ENSEMBLE seat may carry and be dispatched/targeted
 * with. Superset of the static live set: AntiGravity is admitted dynamically
 * (BYO gemini-api key or agy opt-in — enforced at admission time by
 * `selectableProviderIds`/the renderer snapshot), so seat-level gates that
 * filtered on `isLiveSelectableProvider` alone silently excluded valid,
 * already-admitted AntiGravity seats from fan-out targeting and per-seat
 * affordances. Use THIS predicate for seat gates; keep
 * `isLiveSelectableProvider` for static offer surfaces.
 */
export function isEnsembleSeatProvider(provider: string | null | undefined): boolean {
  return isLiveSelectableProvider(provider) || provider === 'antigravity'
}

/**
 * Coerce a possibly missing or unavailable provider to a live one: returns the
 * input unchanged only when it belongs to the canonical live-selectable set,
 * otherwise `DEFAULT_PROVIDER`. Use this on READ wherever a runnable default is
 * needed, without mutating the provider stored in historical records.
 *
 * Generic over the input so the return type stays assignable to the caller's
 * provider type (e.g. `ProviderId`) without this node-free module importing it.
 */
export function coerceLiveProvider<T extends string>(
  provider: T | null | undefined
): T | typeof DEFAULT_PROVIDER {
  if (isLiveSelectableProvider(provider)) {
    return provider
  }
  return DEFAULT_PROVIDER
}

/** Canonical id for the opt-in AntiGravity provider. Distinct from the RETIRED
 *  `gemini` id — adding AntiGravity is NOT a Gemini revival. */
export const ANTIGRAVITY_PROVIDER_ID = 'antigravity' as const

/**
 * Minimal settings shape the AntiGravity opt-in gate reads. Kept structural so
 * this node-free module (imported by BOTH main and renderer) never has to pull
 * in the full `AppSettings` type — same discipline as `coerceLiveProvider`.
 */
export interface AntigravityOptInSettingsLike {
  antigravityEnabled?: boolean | null
  antigravityOptInAcceptedAt?: number | string | null
}

/**
 * True only when the user has BOTH enabled AntiGravity AND recorded explicit
 * consent to the account/ToS/ban-risk warning (`antigravityOptInAcceptedAt`).
 * Missing either signal — the default for every existing install — keeps the
 * provider disabled, hidden, and non-runnable.
 *
 * This is a record of the user's informed opt-in ONLY. It asserts nothing about
 * Google ToS approval or ban-safety; AntiGravity third-party access is expressly
 * prohibited by the Antigravity Additional Terms and the consent copy (later
 * slice) must state that. Downstream offer/run gating consumes this predicate;
 * it never bypasses the retired-provider or configured-provider-snapshot gates.
 */
export function isAntigravityOptInEnabled(
  settings: AntigravityOptInSettingsLike | null | undefined
): boolean {
  return (
    settings != null &&
    settings.antigravityEnabled === true &&
    Boolean(settings.antigravityOptInAcceptedAt)
  )
}
