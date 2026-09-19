/**
 * runFailureRemedy — shared failure-cause classification and the remedy
 * actions the transcript error cards offer.
 *
 * WHY A NEW MODULE. The renderer's `ErrorClassifier` already emits
 * `auth_error` / `quota_or_rate_limited` categories, but nothing consumes
 * them and its marker lists are narrower than what providers actually print
 * (the main-process `ProviderQuotaWallClassifier` and AcpTransientPromptFailure
 * vocabularies are the richer source — mirrored here so the renderer can
 * classify without an IPC round trip). Everything is pure string matching;
 * tests pin the markers so drift is loud.
 *
 * THE REMEDY MAP. `providerLoginCapability` is the renderer-side mirror of
 * main's `ProviderManualSetupFlowCatalog` 'login' flows: terminal handoff for
 * CLI-login providers, in-app OAuth for Gemini, and an honest "no login
 * button" for API-key-only Pi. A provider NOT listed here gets no button —
 * never a dead control.
 */

import type { ProviderId } from '../../../main/store/types'
import { getProviderLabel } from './providerLabels'
import { isContextOverflowErrorText } from '../../../shared/contextCompaction'

/**
 * The deterministic failure families the cards know how to voice. Order of
 * evaluation below is the contract: more specific causes win over generic
 * ones, and auth always beats quota (a 403 from an expired token is not a
 * quota wall).
 */
export type FailureRemedyKind =
  | 'auth'
  | 'model-retired'
  | 'usage-limit'
  | 'context-overflow'
  | 'missing-cli'
  | 'dispatch'
  | 'network'
  | 'catalogue-reindexing'

/**
 * Auth-failure markers. Sources: AcpTransientPromptFailure's NEVER_TRANSIENT
 * auth arm, CodexAppServerClient's token-revoked strings, the CLI auth-status
 * probes, and observed stderr (e.g. Codex's websocket 403s).
 */
const AUTH_MARKER_PATTERN =
  /authorizationrequired|\bunauthenticated\b|\bunauthorized\b|\bforbidden\b|invalid[_ ]api[_ ]key|authentication[_ ](?:error|failed|required)|(?:status|code)\s*[:=]?\s*40[13]\b|http error:\s*40[13]\b|\btoken[_ ]revoked\b|invalidated oauth token|not logged in|login required|oauth-login-required/i

/**
 * Usage-limit / quota markers. Sources: ProviderQuotaWallClassifier's
 * per-provider rules, the ACP quota arm, and the renderer classifier's
 * capacity family (a full model and a throttled account share the same
 * remedy: swap the model or wait).
 */
const USAGE_LIMIT_MARKER_PATTERN =
  /rate[_ ]?limit|ratelimitexceeded|\bquota\b|usage limit|spending limit|out of (?:usage )?credits|resource[_ ]exhausted|insufficient[_ ]quota|too many requests|overloaded|model[_ ]capacity[_ ]exhausted|no capacity available for model|\b429\b|\b529\b/i

/**
 * Retired / removed model markers. Observed shapes: Pi's
 * "model 'x' was retired on YYYY-MM-DD. Choose an active model…", Codex's
 * "gpt-… was retired on …", plus the generic deprecated/unavailable family.
 * The remedy is identical to a quota wall — the picker pill — but the words
 * must say "this model no longer exists", not "slow down".
 */
const MODEL_RETIRED_MARKER_PATTERN =
  /\bwas retired\b|\bmodel retired\b|retired on\s+\d{4}|choose an active\b|no longer available|\bis deprecated\b|does not exist anymore/i

/** Provider CLI simply not present on this machine. */
const MISSING_CLI_MARKER_PATTERN =
  /command not found|enoent\b.*\bspawn\b|spawn\s+\S+\s+enoent|not installed|no such file or directory.*\bcli\b|executable not found/i

/**
 * The turn never reached the provider at all — dispatch/admission failed
 * first (participant-health "dispatch failed" codas are the common shape).
 */
const DISPATCH_MARKER_PATTERN =
  /dispatch failed|failed before dispatch|could not be dispatched|failed before startup|before host admission|before lane launch/i

/** Transport-level reachability, distinct from auth and from Host being down.
 * Deliberately excludes "socket hang up": a provider process dying mid-turn
 * produces the same text, and that is not a connectivity claim. */
const NETWORK_MARKER_PATTERN =
  /econnrefused|etimedout|enotfound|network error|failed to fetch|fetch failed|connection refused|connection timed out/i

/**
 * The thread-catalogue indexing race: a background reindex moved history
 * under a foreground read. Retryable by the tree's own taxonomy
 * (ThreadCatalogueRequestError.retryable) — a timing hiccup, never a problem
 * with the user's request.
 */
const CATALOGUE_REINDEXING_MARKER_PATTERN =
  /threadcataloguerequesterror|history changed during indexing|thread-catalogue:read|source_changed/i

/**
 * Classify failure text into its remedy family, or null when nothing
 * actionable matches (the card then stays a generic failure). Auth wins when
 * both match — a 403 from an expired token must not read as a quota wall.
 */
export function classifyFailureRemedy(text: string): FailureRemedyKind | null {
  if (!text) return null
  if (AUTH_MARKER_PATTERN.test(text)) return 'auth'
  if (CATALOGUE_REINDEXING_MARKER_PATTERN.test(text)) return 'catalogue-reindexing'
  if (MODEL_RETIRED_MARKER_PATTERN.test(text)) return 'model-retired'
  if (isContextOverflowErrorText(text)) return 'context-overflow'
  if (USAGE_LIMIT_MARKER_PATTERN.test(text)) return 'usage-limit'
  if (MISSING_CLI_MARKER_PATTERN.test(text)) return 'missing-cli'
  if (DISPATCH_MARKER_PATTERN.test(text)) return 'dispatch'
  if (NETWORK_MARKER_PATTERN.test(text)) return 'network'
  return null
}

const PROVIDER_IDS: readonly ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral',
  'muse',
  'devin'
]

/**
 * Best-effort provider read from free-form failure text. The reliable carrier
 * is the "Failed to start {Label}:" prefix App.tsx stamps on dispatch
 * failures; anything weaker stays unidentified rather than guessing wrong.
 */
export function extractProviderFromFailureText(text: string): ProviderId | undefined {
  const match = /^Failed to start ([^:]+):/i.exec(text.trim())
  if (!match) return undefined
  const label = match[1].trim().toLowerCase()
  return PROVIDER_IDS.find((id) => getProviderLabel(id).toLowerCase() === label)
}

export type ProviderLoginCapability = 'terminal' | 'oauth' | 'api-key-only'

/**
 * How (whether) a provider logs back in. Mirrors main's manual-setup flow
 * catalog: terminal handoff for the CLI-login providers, Gemini's in-app
 * OAuth, Pi's API-key-only lane. Unlisted → undefined → no button rendered.
 */
export function providerLoginCapability(provider: ProviderId): ProviderLoginCapability | undefined {
  switch (provider) {
    case 'codex':
    case 'claude':
    case 'kimi':
    case 'antigravity':
    case 'ollama':
    case 'cursor':
    case 'mistral':
    case 'muse':
    case 'devin':
    case 'grok':
      return 'terminal'
    case 'gemini':
      return 'oauth'
    case 'pi':
      return 'api-key-only'
    default:
      return undefined
  }
}

/**
 * Launch the provider's login flow. Returns a user-readable note for the
 * card's outcome line; never throws into a transcript render.
 */
export function launchProviderLogin(provider: ProviderId): { ok: boolean; note: string } {
  const label = getProviderLabel(provider)
  const capability = providerLoginCapability(provider)
  if (capability === 'api-key-only') {
    return { ok: false, note: `${label} uses an API key — update it in Settings.` }
  }
  if (typeof window === 'undefined' || !window.api) {
    return { ok: false, note: 'The login bridge is unavailable here.' }
  }
  if (capability === 'oauth') {
    if (typeof window.api.startGeminiOAuthLogin !== 'function') {
      return { ok: false, note: 'The Gemini sign-in bridge is unavailable.' }
    }
    void window.api.startGeminiOAuthLogin({})
    return { ok: true, note: 'Gemini sign-in started — finish it in the window that opens.' }
  }
  if (capability === 'terminal' && typeof window.api.openProviderLoginTerminal === 'function') {
    void window.api.openProviderLoginTerminal(provider)
    return {
      ok: true,
      note: `${label} sign-in opened in a terminal — finish it there, then retry.`
    }
  }
  return { ok: false, note: `${label} sign-in is not available from here — use Settings.` }
}

/**
 * THE TEMPLATE POOL. Deterministic headline/body/note per failure family, so
 * a card never says "couldn't finish" when the error text already knows why.
 * `subject` is the seat name ("Review 1") or the provider label for
 * run-level errors; `surface` picks the seat voice vs the run voice for the
 * few families whose advice differs.
 */
export interface FailureRemedyCopy {
  readonly title: string
  readonly body: string
  readonly note?: string
}

export function describeFailureRemedyCopy(
  remedy: FailureRemedyKind,
  input: { subject: string; providerLabel?: string; surface: 'seat' | 'run' }
): FailureRemedyCopy {
  const { subject, surface } = input
  const providerLabel = input.providerLabel ?? subject
  const retryVoice = surface === 'seat' ? 'retry the seat' : 'retry the run'
  switch (remedy) {
    case 'auth':
      return {
        title: `${subject} needs you to sign in again`,
        body: `The provider’s login session is missing or expired. Sign in again, then ${retryVoice}.`,
        note: `This looks like a sign-in problem — ${providerLabel} needs to re-authenticate, then ${retryVoice}.`
      }
    case 'model-retired':
      return {
        title: `${subject}’s model was retired`,
        body: `That model is no longer available. Pick an active model ${surface === 'seat' ? 'for the seat' : 'below'} and ${retryVoice}.`,
        note: `${providerLabel}’s model was retired — choose an active one to continue.`
      }
    case 'usage-limit':
      return {
        title: `${subject} hit a usage limit`,
        body: `The model is rate-limited or out of credits right now. ${
          surface === 'seat'
            ? 'Swap the seat’s model or retry after the reset.'
            : 'Swap the model in the composer below, or wait for the limit to reset, then retry.'
        }`,
        note: `${providerLabel} hit a usage limit — swap ${
          surface === 'seat' ? 'the seat’s model' : 'the model'
        } or retry after the reset.`
      }
    case 'context-overflow':
      return {
        title: `${subject} ran out of context`,
        body: 'The conversation filled the model’s context window. Compact the session or start a fresh thread, then retry.'
      }
    case 'missing-cli':
      return {
        title: `${subject}’s CLI is not installed`,
        body: 'The provider’s command-line tool was not found on this Mac. Install or repair it, then retry.'
      }
    case 'dispatch':
      return {
        title: `${subject} couldn’t start`,
        body: 'The turn never reached the provider — dispatch failed before anything ran. Nothing was sent.',
        note: 'The turn failed before dispatch — nothing reached the provider.'
      }
    case 'network':
      return {
        title: `${subject} couldn’t connect`,
        body: 'The provider could not be reached. Check the network or the provider’s status, then retry.'
      }
    case 'catalogue-reindexing':
      return {
        title: 'A background refresh interrupted this run',
        body: 'TaskWraith was refreshing its thread index when this run tried to read it — a timing hiccup, not a problem with your request. Nothing was lost.',
        note: 'The index has settled — retry the run.'
      }
  }
}
