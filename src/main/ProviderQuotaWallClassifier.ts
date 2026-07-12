import type { ProviderId } from './store/types'

/**
 * Pure classifier: did a failed provider run die on a PROVIDER quota /
 * rate-limit wall (HTTP 429 / "usage limit" / "out of credits"), as opposed
 * to an ordinary error or a rate-limit string the agent's own tools emitted?
 *
 * Modeled on SandboxFallback.ts — a pure, fully-unit-tested string classifier
 * with no side effects.
 *
 * DESIGN — a four-stage funnel (see docs/auto-failover-killswitch-spec.md and
 * the recon notes). This module owns stages 2-3; the caller owns 1 + 4:
 *   1. (caller) Only classify on a TERMINAL non-zero exit. A 429 in a run that
 *      ultimately SUCCEEDED is noise — both the Anthropic and OpenAI SDKs
 *      auto-retry 429 twice, so transient 429s routinely sit in healthy logs.
 *   2. (here) Only inspect the provider's ERROR/transport channel text (the
 *      `agent-error` payload), never assistant tool stdout — that scoping
 *      excludes the universe of tool-emitted 429s (AWS ThrottlingException,
 *      Docker pull limits, GitHub "API rate limit exceeded for", curl -v, …).
 *   3. (here) Match provider-specific structured `type`/`code` tokens
 *      (snake_case) over human prose, which is templated/localized and a
 *      false-positive generator.
 *   4. (caller) Dedupe per run + cap failover hops.
 *
 * Returns `{ hit:false }` for Ollama unconditionally: a LOCAL Ollama server has
 * no quota/rate-limit primitive (its `server busy … maximum pending requests`
 * is transient backpressure, not a billing wall). A cloud-proxied Ollama could
 * 429, but TaskWraith's Ollama transport is local-first; failing closed here
 * avoids a class of false positives.
 */

export interface QuotaWallVerdict {
  hit: boolean
  /** ISO timestamp the provider window is expected to reset, if derivable. */
  resetHintAt?: string
  /** Short tag of which signal matched (for logs/audit). */
  reason?: string
}

const NO: QuotaWallVerdict = { hit: false }

interface ProviderRule {
  /** Snake_case type/code tokens and stable message anchors. Case-insensitive. */
  patterns: RegExp[]
}

// Verbatim tokens cross-checked against official provider error docs + real
// captured 429 bodies (see the recon dossiers). Anchored on stable structured
// tokens, not on templated prose with interpolated org-ids / models / counts.
const PROVIDER_RULES: Partial<Record<ProviderId, ProviderRule>> = {
  claude: {
    patterns: [
      /rate_limit_error/i, // Anthropic 429 error.type
      /overloaded_error/i, // Anthropic 529 (capacity); treated as a transient wall
      /Claude AI usage limit reached\|\d{10}/i, // -p/stream-json stdout form, epoch reset
      /Claude usage limit reached/i, // interactive OAuth/subscription form
      // C1 — Claude subscription / "Fable" weekly wall, e.g.
      // "You've hit your limit · resets Jul 14". Envelope-anchored per Captain
      // G1: requires the distinctive opener AND a nearby reset token, so bare
      // "quota"/"resets" prose (or a peer quoting the phrase) never trips it.
      // Straight + curly apostrophe.
      /You['’]ve hit your limit[\s\S]{0,64}reset/i
    ]
  },
  codex: {
    patterns: [
      /insufficient_quota/i, // OpenAI billing wall (type+code)
      /\brate_limit_exceeded\b/i, // OpenAI rate-limit code
      /You've hit your usage limit\./i, // Codex subscription cap (CLI/TUI)
      /Rate limit reached for /i, // OpenAI platform-API message anchor
      /You exceeded your current quota/i // OpenAI quota message anchor
    ]
  },
  kimi: {
    patterns: [
      /rate_limit_reached_error/i, // Moonshot 429 type (throughput)
      /exceeded_current_quota_error/i, // Moonshot 429 type (balance/quota)
      /engine_overloaded_error/i, // Moonshot 429 type (overload)
      /reached organization (max|TPM|TPD|max RPM|max concurrency)/i, // templated detail
      /is suspended due to insufficient balance/i, // billing wall
      /We're receiving too many requests/i // generic gateway 429
    ]
  },
  grok: {
    patterns: [
      /has either used all available credits or reached its monthly spending limit/i, // xAI credits wall
      /Too many tokens for team/i, // xAI TPM wall
      /Error code: 429 - \{/i // OpenAI-SDK passthrough wrapper around the flat xAI body
    ]
  },
  cursor: {
    patterns: [
      /You've hit your usage limit/i, // Cursor account usage wall
      /hit your free requests limit/i, // Cursor free-tier wall
      /experiencing high demand for/i, // Cursor capacity/resource exhaustion
      /resource_exhausted/i // ERROR_RESOURCE_EXHAUSTED machine code
    ]
  }
  // ollama: intentionally absent → always { hit:false } (local has no quota wall)
}

/**
 * Classify the provider's error-channel text. `text` MUST be the provider
 * transport/error string (the `agent-error` payload), not assistant stdout.
 */
export function classifyProviderQuotaWall(
  provider: ProviderId,
  text: string | null | undefined,
  opts?: { now?: number }
): QuotaWallVerdict {
  const rule = PROVIDER_RULES[provider]
  if (!rule) return NO // ollama + any unmapped provider fail closed
  const body = typeof text === 'string' ? text : ''
  if (!body.trim()) return NO
  const matched = rule.patterns.find((re) => re.test(body))
  if (!matched) return NO
  return {
    hit: true,
    reason: `${provider}:${matched.source.slice(0, 32)}`,
    resetHintAt: extractResetHint(provider, body, opts?.now ?? Date.now())
  }
}

/**
 * Best-effort parse of a reset time embedded in the error text. Returns an ISO
 * string or undefined (the caller applies a conservative default backoff when
 * absent). No provider is required to expose this in-body; many only carry it
 * in a separate usage endpoint or a header we don't see here.
 */
export function extractResetHint(
  provider: ProviderId,
  body: string,
  now: number
): string | undefined {
  // Claude `…reached|<unix-seconds>`
  if (provider === 'claude') {
    const epoch = body.match(/Claude AI usage limit reached\|(\d{10})/i)
    if (epoch) {
      const ms = Number(epoch[1]) * 1000
      if (Number.isFinite(ms) && ms > now) return new Date(ms).toISOString()
    }
  }
  // Kimi `please try again after N seconds`
  const afterSeconds = body.match(/try again after (\d+)\s*seconds?/i)
  if (afterSeconds) return new Date(now + Number(afterSeconds[1]) * 1000).toISOString()
  // OpenAI `Please try again in N.NNNs` / `after N seconds`
  const inSeconds = body.match(/try again in (\d+(?:\.\d+)?)s/i) || body.match(/after (\d+(?:\.\d+)?) seconds/i)
  if (inSeconds) return new Date(now + Math.ceil(Number(inSeconds[1]) * 1000)).toISOString()
  return undefined
}
