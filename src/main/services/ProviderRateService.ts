/**
 * 1.0.5-EW38 — Currency sub-slice (d): per-provider rate
 * foundation + best-effort scrape probe.
 *
 * **What this service is**: a curated baseline of per-model input
 * + output token costs across the provider roster, plus a probe
 * that fetches each provider's public pricing page and tries to
 * verify the baked-in values haven't drifted. The data is
 * foundational — no UI surfaces it in 1.0.5; the rates are
 * captured so downstream cost-estimation features (pre-flight
 * cost estimate, "you'll spend ~$X for N tokens", per-model
 * comparison in Settings → Model usage) have an accurate source
 * of truth.
 *
 * **What this service is NOT**: a real-time scraper. Pricing
 * pages are often JavaScript-rendered single-page apps; plain `fetch`
 * gets only the unrendered shell. Building a headless-browser
 * scraper for each is fragile + heavyweight + breaks the moment
 * any provider changes their HTML structure. The probe here is
 * best-effort: it fetches the page, searches the (often
 * pre-rendered) text content for known dollar amounts, and
 * reports `verified` / `not-verified` per rate. When verified,
 * the user has confidence the baked-in values are still current;
 * when not verified, that's a signal to manually check the
 * pricing URL recorded on the rate entry.
 *
 * **Manual diligence cycle**: when the probe reports drift
 * (or every release cycle as a sanity check), the maintainer updates the
 * `BAKED_IN_RATES` map below + bumps `RATE_TABLE_VERSION`.
 * Future revs may add a more robust validator (e.g. expect a
 * `$X / 1M tokens` pattern within N chars of the model name),
 * but the baked-in table is always the authoritative source.
 *
 * **Currency convention**: all rates are USD per 1 million tokens.
 * The display layer (`formatCost`) converts to the user's chosen
 * currency via the live FX rates from 1.0.5-EW35.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import type { ProviderId } from '../store/types'

/** Snapshot date for the baked-in rate values. Bump alongside the
 * rate values themselves when the manual diligence cycle runs. */
export const RATE_TABLE_VERSION = '2026-08-31'

/**
 * Per-model rate entry. Rates are USD per 1,000,000 tokens (so
 * a "0.0015" charge per 1K tokens shows here as `1.5`).
 *
 * `sourceUrl` points at the canonical pricing page so the probe
 * + the human reviewer have a single source of truth.
 *
 * `lastVerified` is bumped automatically by the probe when it
 * succeeds; manually set to the table version date when the
 * value was last hand-verified.
 */
export interface ModelRateEntry {
  modelId: string
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  /** Optional cached-prompt input rate (typically 50%-90% of the
   * full input rate). Several providers expose a cached-prompt
   * tier; when present we record it here. */
  cachedInputUsdPerMillion?: number
  /** Prompt-token threshold at which every token in the request is billed at
   * the optional long-context tier. The three long-context rates are all-or-none. */
  longContextThresholdTokens?: number
  longContextInputUsdPerMillion?: number
  longContextOutputUsdPerMillion?: number
  longContextCachedInputUsdPerMillion?: number
  /** Where this rate lives in the canonical docs. */
  sourceUrl: string
  /** Date the rate was last hand-verified (ISO 8601). */
  lastVerified: string
  /** Optional notes — e.g. "subscription-only via Codex CLI",
   * "tier-1 only", "preview pricing". */
  notes?: string
  /**
   * Set when the upstream bills by SUBSCRIPTION or prepaid allowance and
   * publishes no per-token price (Z.ai's coding plan, the Qwen token plan).
   * Such a row carries zero rates on purpose: zero means "no per-token
   * projection" — the display layer renders a neutral placeholder — NOT "free".
   *
   * The row must still exist. `resolveModelRate` falls back to `models[0]` when
   * nothing matches, so omitting these ids would price them at an unrelated
   * model's rate instead of leaving the estimate blank.
   */
  subscriptionLane?: true
  /** The provider publishes this model itself at a zero per-token price. */
  freeModel?: true
  /** Explicit source confidence for the rate value. Missing means
   * baked-in manual table. */
  confidence?: ProviderRateConfidence
}

export interface ProviderRateTable {
  provider: ProviderId
  /** Single canonical pricing page URL. The probe fetches this. */
  pricingUrl: string
  /** Per-model rate entries. */
  models: ModelRateEntry[]
}

/**
 * 1.0.5-EW38 — Baked-in provider rate snapshot. Last manually
 * reviewed 2026-08-12.
 *
 * Values are USD per 1M tokens (input / output). When provider
 * pricing pages drift the probe surfaces a `not-verified` status
 * for the affected entries and a manual update on this table is
 * required.
 *
 * **Codex / OpenAI**: Codex CLI uses ChatGPT subscription quota
 * (Plus / Pro / Business) — there's no per-token billing flowing
 * through the CLI we see. Rates here are the API equivalents for
 * the same underlying models, kept for parity + future use if
 * users opt into API-key Codex mode.
 *
 * **Claude / Anthropic**: API pricing per anthropic.com/pricing.
 * Sonnet + Opus + Haiku families have standard tiers; specific
 * model variants (Opus 4.7 1M context window) sometimes carry a
 * surcharge — captured as a separate entry where applicable.
 *
 * **Gemini / Google**: ai.google.dev/gemini-api/docs/pricing.
 * Free-tier developer quota is generous; paid-tier rates apply
 * above the quota.
 *
 * **Kimi / Moonshot**: platform.moonshot.cn/docs/pricing (CN) +
 * the English mirror. Notably cheaper than the other three for
 * comparable capability.
 */
export const BAKED_IN_RATES: Record<ProviderId, ProviderRateTable> = {
  // Grok. IMPORTANT: TaskWraith drives Grok through the SuperGrok CLI
  // subscription (a credit pool — see GrokUsage's "Subscription credits"
  // meter), NOT the xAI per-token API. These rates are therefore a PROJECTED
  // API-equivalent ("what this run would have cost on the xAI API"), not actual
  // billing. Captured from xAI model docs 2026-08-12.
  grok: {
    provider: 'grok',
    pricingUrl: 'https://docs.x.ai/developers/pricing',
    models: [
      {
        modelId: 'grok-4.6',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 6.0,
        cachedInputUsdPerMillion: 0.5,
        longContextThresholdTokens: 200_000,
        longContextInputUsdPerMillion: 4.0,
        longContextOutputUsdPerMillion: 12.0,
        longContextCachedInputUsdPerMillion: 1.0,
        sourceUrl: 'https://docs.x.ai/developers/models/grok-4.6',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'xAI API pricing for Grok 4.6 (500K ctx). Prompts at or above 200K tokens bill every token at the long-context tier. PROJECTED API-equivalent; CLI auth bills via subscription credits.'
      },
      {
        modelId: 'grok-4.5',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 6.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://docs.x.ai/developers/models/grok-4.5',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'xAI API pricing for Grok 4.5 (500K ctx). PROJECTED API-equivalent; CLI auth bills via subscription credits.'
      },
      {
        modelId: 'grok-build',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 6.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://docs.x.ai/developers/models/grok-4.5',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Historical Grok Build id now maps to Grok 4.5. PROJECTED API-equivalent; CLI auth bills via subscription credits.'
      },
      {
        modelId: 'grok-composer-2.5-fast',
        inputUsdPerMillion: 3.0,
        outputUsdPerMillion: 15.0,
        sourceUrl: 'https://cursor.com/docs/models/cursor-composer-2-5',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Composer 2.5 Fast selected through Grok Build CLI. PROJECTED API-equivalent from Cursor Composer pricing; Grok CLI auth bills via SuperGrok/X subscription credits.'
      },
      {
        modelId: 'grok-4.3',
        inputUsdPerMillion: 1.25,
        outputUsdPerMillion: 2.5,
        cachedInputUsdPerMillion: 0.2,
        sourceUrl: 'https://docs.x.ai/developers/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'xAI API pricing for grok-4.3 (1M ctx). Projected API-equivalent, not actual billing.'
      }
    ]
  },
  // Live Path-B, historical, and external Cursor reporting can all appear in
  // usage views. Public Fast-tier pricing is used only as a conservative
  // API-equivalent estimate, never as a claim about the user's Cursor billing.
  cursor: {
    provider: 'cursor',
    pricingUrl: 'https://cursor.com/docs/models-and-pricing',
    models: [
      {
        modelId: 'composer-2.5-fast',
        inputUsdPerMillion: 3.0,
        outputUsdPerMillion: 15.0,
        sourceUrl: 'https://cursor.com/docs/models/cursor-composer-2-5',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Composer 2.5 Fast tier (IDE default). PROJECTED API-equivalent — individual plans draw from the Composer pool, not per-token billing. Used as the fallback rate for unknown Cursor usage rows.'
      },
      {
        modelId: 'composer-2.5',
        inputUsdPerMillion: 0.5,
        outputUsdPerMillion: 2.5,
        sourceUrl: 'https://cursor.com/changelog/composer-2-5',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Composer 2.5 Standard tier. PROJECTED API-equivalent — exact rows should use this lower standard-tier rate instead of the Fast proxy.'
      },
      {
        modelId: 'grok-4.6',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 6.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://cursor.com/docs/models/grok-4-6',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Cursor Grok 4.6 standard tier. PROJECTED API-equivalent; individual plans draw from Cursor included/auto quota.'
      },
      {
        modelId: 'grok-4.6-fast',
        inputUsdPerMillion: 4.0,
        outputUsdPerMillion: 12.0,
        cachedInputUsdPerMillion: 1.0,
        sourceUrl: 'https://cursor.com/docs/models/grok-4-6',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Internal Cursor cost-rate id for Grok 4.6 Fast mode (2x standard). PROJECTED API-equivalent; not a separate picker model.'
      },
      {
        modelId: 'grok-4.5',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 6.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://cursor.com/docs/models-and-pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Cursor Grok 4.5 first-party model pool row. PROJECTED API-equivalent; individual plans draw from Cursor included/auto quota.'
      },
      {
        modelId: 'cursor-grok-4.5',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 6.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://cursor.com/docs/models-and-pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'UI alias for Cursor Grok 4.5. PROJECTED API-equivalent; individual plans draw from Cursor included/auto quota.'
      }
    ]
  },
  codex: {
    provider: 'codex',
    pricingUrl: 'https://openai.com/api/pricing',
    models: [
      // GPT-5.6 trio — GA 2026-07-09, verified against the official model
      // pages (developers.openai.com/api/docs/models/gpt-5.6-*). Note: prompts
      // >272K input tokens are billed at 2x input / 1.5x output for the full
      // request (not modelled here — estimates undercount very long prompts).
      {
        modelId: 'gpt-5.6-sol',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 30.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Codex CLI typically billed via ChatGPT subscription, not per-token.'
      },
      {
        modelId: 'gpt-5.6-terra',
        inputUsdPerMillion: 2.5,
        outputUsdPerMillion: 15.0,
        cachedInputUsdPerMillion: 0.25,
        sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'gpt-5.6-luna',
        inputUsdPerMillion: 1.0,
        outputUsdPerMillion: 6.0,
        cachedInputUsdPerMillion: 0.1,
        sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'gpt-5.5',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 30.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://openai.com/api/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Codex CLI typically billed via ChatGPT subscription, not per-token.'
      },
      {
        modelId: 'gpt-5.4',
        inputUsdPerMillion: 2.5,
        outputUsdPerMillion: 15.0,
        cachedInputUsdPerMillion: 0.25,
        sourceUrl: 'https://openai.com/api/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'gpt-5.4-mini',
        inputUsdPerMillion: 0.75,
        outputUsdPerMillion: 4.5,
        cachedInputUsdPerMillion: 0.075,
        sourceUrl: 'https://openai.com/api/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'gpt-5.3-codex',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 8.0,
        sourceUrl: 'https://openai.com/api/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Codex-tuned variant; price approximate. Retiring 2026-06-02 per OpenAI (GPT-5.3-Codex-Spark is NOT affected).'
      },
      {
        modelId: 'gpt-5.3-codex-spark',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 8.0,
        sourceUrl: 'https://openai.com/api/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Research preview; pricing may not be public.'
      },
      {
        modelId: 'gpt-5.2',
        inputUsdPerMillion: 1.0,
        outputUsdPerMillion: 8.0,
        sourceUrl: 'https://openai.com/api/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Retiring 2026-06-02 per OpenAI.'
      }
    ]
  },
  claude: {
    provider: 'claude',
    pricingUrl: 'https://www.anthropic.com/pricing',
    models: [
      {
        modelId: 'claude-fable-5',
        inputUsdPerMillion: 10.0,
        outputUsdPerMillion: 50.0,
        cachedInputUsdPerMillion: 1.0,
        sourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Frontier 1M-context model with adaptive thinking. Published rate $10/$50.'
      },
      {
        modelId: 'claude-fable-5-1m',
        inputUsdPerMillion: 10.0,
        outputUsdPerMillion: 50.0,
        cachedInputUsdPerMillion: 1.0,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: '1M context window at standard rates — no long-context premium published.'
      },
      {
        modelId: 'claude-mythos-5',
        inputUsdPerMillion: 10.0,
        outputUsdPerMillion: 50.0,
        cachedInputUsdPerMillion: 1.0,
        sourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Project Glasswing limited-availability 1M-context model with adaptive thinking. Published rate $10/$50.'
      },
      {
        modelId: 'claude-opus-5',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 25.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Current-gen Opus, launched 2026-07-24 at Opus 4.8 pricing ($5/$25). 1M context is the default — no -1m variant. Fast mode bills 2x ($10/$50) upstream; table keeps the standard tier.'
      },
      {
        modelId: 'claude-opus-4-8',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 25.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Previous-gen Opus as of Opus 5 (2026-07-24). Published rate $5/$25 (2026-06-09 diligence cycle; replaces the $15/$75 placeholder assumed from the pre-4.5 Opus tier).'
      },
      {
        modelId: 'claude-opus-4-8-1m',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 25.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          '1M context window at standard API pricing — Anthropic dropped the long-context premium from Opus 4.7 onward.'
      },
      {
        modelId: 'claude-opus-4-7',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 25.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Legacy as of Opus 4.8. Published rate $5/$25 (2026-06-09 diligence cycle).'
      },
      {
        modelId: 'claude-opus-4-7-1m',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 25.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          '1M context window at standard API pricing (no long-context premium on 4.7+). Legacy as of Opus 4.8.'
      },
      {
        modelId: 'claude-opus-4-6',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 25.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Previous-gen Opus; same published $5/$25 rate as 4.7/4.8.'
      },
      {
        modelId: 'claude-sonnet-5',
        inputUsdPerMillion: 3.0,
        outputUsdPerMillion: 15.0,
        cachedInputUsdPerMillion: 0.3,
        sourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Current-gen Sonnet. Published rate $3/$15 (verified against platform.claude.com 2026-06-30); cached-read at the standard 0.1x input = $0.3. Shares the Opus 4.8 reasoning ladder but Sonnet-tier billing, NOT Opus $5/$25. NOTE: introductory pricing of $2/$10 per MTok applies through 2026-08-31 — the table tracks the standard post-intro rate so historical/forward costs stay correct after the promo ends.'
      },
      {
        modelId: 'claude-sonnet-4-6',
        inputUsdPerMillion: 3.0,
        outputUsdPerMillion: 15.0,
        cachedInputUsdPerMillion: 0.3,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'claude-haiku-4-5',
        inputUsdPerMillion: 1.0,
        outputUsdPerMillion: 5.0,
        cachedInputUsdPerMillion: 0.1,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Corrected to the published $1/$5 rate (2026-06-09 diligence cycle).'
      }
    ]
  },
  gemini: {
    provider: 'gemini',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    models: [
      {
        modelId: 'gemini-3.1-pro-preview',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 12.0,
        cachedInputUsdPerMillion: 0.2,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Historic Gemini CLI/provider tracking row. Gemini is retired for new TaskWraith runs; retained so historical activity estimates remain visible.'
      },
      {
        modelId: 'gemini-3.1-pro',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 12.0,
        cachedInputUsdPerMillion: 0.2,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Historic plain-id alias priced at Gemini 3.1 Pro Preview standard rates; Gemini is retired for new TaskWraith runs.'
      },
      {
        modelId: 'gemini-3-flash-preview',
        inputUsdPerMillion: 0.5,
        outputUsdPerMillion: 3.0,
        cachedInputUsdPerMillion: 0.05,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Historic Gemini CLI/provider tracking row retained for external activity.'
      },
      {
        modelId: 'gemini-3.1-flash-lite',
        inputUsdPerMillion: 0.25,
        outputUsdPerMillion: 1.5,
        cachedInputUsdPerMillion: 0.025,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Historic Gemini CLI/provider tracking row retained for external activity.'
      },
      {
        modelId: 'gemini-3.1-flash-lite-preview',
        inputUsdPerMillion: 0.25,
        outputUsdPerMillion: 1.5,
        cachedInputUsdPerMillion: 0.025,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Historic preview alias priced at Gemini 3.1 Flash-Lite standard rates; Gemini is retired for new TaskWraith runs.'
      },
      {
        modelId: 'gemini-2.5-flash-lite',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.4,
        cachedInputUsdPerMillion: 0.01,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Historic Gemini CLI/provider tracking row retained for external activity.'
      }
    ]
  },
  kimi: {
    provider: 'kimi',
    pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat',
    models: [
      {
        modelId: 'kimi-k2.7-code',
        inputUsdPerMillion: 0.95,
        outputUsdPerMillion: 4.0,
        cachedInputUsdPerMillion: 0.19,
        sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Current Kimi Code CLI default. PROJECTED API-equivalent for OAuth/subscription runs; automatic context cache hit pricing recorded as cached input.'
      },
      {
        modelId: 'kimi-k2.7-code-highspeed',
        inputUsdPerMillion: 1.9,
        outputUsdPerMillion: 8.0,
        cachedInputUsdPerMillion: 0.38,
        sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Published Highspeed tier for the same K2.7 Coding model (Fast mode in TaskWraith). PROJECTED API-equivalent for OAuth/subscription runs.'
      },
      {
        modelId: 'kimi-k3',
        inputUsdPerMillion: 3.0,
        outputUsdPerMillion: 15.0,
        cachedInputUsdPerMillion: 0.3,
        sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k3',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Published K3 API pricing for the plan-dependent long-context route. PROJECTED API-equivalent for OAuth/subscription runs.'
      },
      {
        modelId: 'kimi-k3-256k',
        inputUsdPerMillion: 3.0,
        outputUsdPerMillion: 15.0,
        cachedInputUsdPerMillion: 0.3,
        sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k3',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Same published K3 API pricing for the fixed 256K route. Kimi Code membership documents lower quota consumption than the 1M route; this remains a PROJECTED API-equivalent for subscription runs.'
      },
      {
        modelId: 'kimi-k2.6',
        inputUsdPerMillion: 0.95,
        outputUsdPerMillion: 4.0,
        cachedInputUsdPerMillion: 0.16,
        sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k26',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Automatic context cache hit pricing recorded as cached input.'
      }
    ]
  },
  ollama: {
    provider: 'ollama',
    pricingUrl: 'local://ollama',
    models: [
      {
        modelId: 'qwen3:4b-instruct',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Local Ollama model. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'qwen3.5:2b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Qwen 3.5 2B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'qwen3.5:4b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Qwen 3.5 4B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'qwen3.5:9b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Qwen 3.5 9B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'qwen3.6:35b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Qwen 3.6 35B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'qwen3.8:27b-mlx',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Alibaba Qwen 3.8 27B-MLX running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'qwen3.8-flash-next:125b-mlx',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Alibaba Qwen 3.8 Flash Next 125B-MLX running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gemma3:4b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Google Gemma 3 4B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gemma4:12b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Google Gemma 4 12B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gemma4:31b-mlx',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Google Gemma 4 31B-MLX running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Ornith 1.0 9B alias running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith:latest',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Ornith 1.0 9B alias running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith:9b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Ornith 1.0 9B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith:35b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Ornith 1.0 35B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith-1.5:9b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Ornith 1.5 9B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith-1.5:35b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Ornith 1.5 35B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'laguna-xs-2.1:q8_0',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Poolside Laguna XS 2.1 Q8 running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gemma4:12b-it-q4_K_M',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Google Gemma 4 12B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gpt-oss',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gpt-oss:20b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gpt-oss:latest',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'minicpm-v4.5:8b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'MiniCPM-V 4.5 8B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4:3b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'IBM Granite 4.0 3B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4.1:3b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'IBM Granite 4.1 3B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4.1:30b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'IBM Granite 4.1 30B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4.2:3b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'IBM Granite 4.2 3B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4.2:8b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'IBM Granite 4.2 8B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4.2:30b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'IBM Granite 4.2 30B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'nemotron-3-nano:4b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'NVIDIA Nemotron 3 Nano 4B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'nemotron3:33b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'NVIDIA Nemotron 3 Nano Omni 33B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'nemotron-3.5-lightning:30b-mlx',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'NVIDIA Nemotron 3.5 Lightning 30B-MLX running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'lfm2.5-thinking:1.2b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Liquid LFM 2.5 Thinking 1.2B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        // Offered by OLLAMA_MODELS but had no row, so it was missing from the
        // Provider/Model API Rates table. Local inference is free, so the
        // absent row cost nothing — it just made the table look incomplete.
        modelId: 'lfm2.5:8b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Liquid LFM 2.5 8B-A1B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'openai/gpt-oss-20b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'devstral-small-2:24b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Mistral Devstral Small 2 24B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'mistral-medium-3.5:128b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Mistral Medium 3.5 128B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ministral-3:3b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Mistral Ministral 3 3B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ministral-3:14b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Mistral Ministral 3 14B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'muse-glimmer:30b-mlx',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Meta Muse Glimmer 30B-MLX running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'llama3.1:8b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Meta Llama 3.1 8B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'deepseek-r1:1.5b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'DeepSeek R1 Distill Qwen 1.5B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'deepseek-r1:8b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'DeepSeek R1 8B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'rnj-1',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Essential AI Rnj-1 8B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'glm-4.7-flash:q4_K_M',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Z.ai GLM-4.7-Flash 30B-A3B Q4 running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'north-mini-code-1.0:q4_K_M',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Cohere North Mini Code 1.0 30B-A3B Q4 running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'llama3.2:3b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Meta Llama 3.2 3B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      }
    ]
  },
  // AntiGravity. Rows are keyed by the persisted `gemini-api:` wire ids the
  // key lane writes into usage records. Unlike the subscription seats above,
  // the key lane genuinely bills per token, so these are the user's ACTUAL
  // billing basis (Gemini API paid tier, ≤200K-prompt rate where tiered) —
  // still surfaced as an estimate because TaskWraith never sees the invoice.
  // Pi seat: BYOK upstreams with wildly different rates; rows below cover the
  // curated defaults and the FIRST row is the fallback estimate for any other
  // pi wire id. Rates from pi 0.82.1's bundled catalog (per-million USD).
  // Pi is BYOK across SEVEN upstreams, so one rate per provider is not enough:
  // every surfaced wire id needs its own row. `resolveModelRate` falls back to
  // `models[0]` when nothing matches exactly or by prefix, and a Pi wire id
  // (`zai/glm-5.2`) shares no prefix with any other, so ANY missing row was
  // silently priced at row 0 — i.e. every Z.ai, Qwen, MiniMax, Mistral, Groq
  // and Cerebras run was being projected at DeepSeek V4 Flash rates.
  //
  // Values come from pi's bundled catalogue
  // (`@earendil-works/pi-ai/dist/providers/data/<upstream>.json`) plus official
  // Mistral model cards for deployments newer than pi 0.82.1. Re-check both on
  // pi upgrades. Table-level `pricingUrl` can only ever verify one vendor, so
  // each entry carries the vendor's own `sourceUrl` for the human half of the
  // diligence cycle; expect the probe to report not-verified for the others.
  pi: {
    provider: 'pi',
    pricingUrl: 'https://pi.dev/docs/latest/providers',
    models: [
      {
        modelId: 'deepseek/deepseek-v4-flash',
        inputUsdPerMillion: 0.14,
        outputUsdPerMillion: 0.28,
        cachedInputUsdPerMillion: 0.0028,
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Pi default model (DeepSeek API direct). First row = fallback rate for unknown pi ids.'
      },
      {
        modelId: 'deepseek/deepseek-v4-pro',
        inputUsdPerMillion: 0.435,
        outputUsdPerMillion: 0.87,
        cachedInputUsdPerMillion: 0.003625,
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'DeepSeek V4 Pro via the Pi seat.'
      },
      // Z.ai + Qwen are SUBSCRIPTION/token-plan lanes: pi publishes no
      // per-token price, so these are genuinely 0 and the display layer renders
      // a neutral placeholder rather than a figure. The rows still matter —
      // without them these ids fall through to row 0 and get billed as DeepSeek.
      // 0 here means "no per-token projection", NOT "free".
      {
        modelId: 'zai/glm-4.7',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Z.ai coding-plan lane — subscription, no per-token rate published.'
      },
      {
        modelId: 'zai/glm-5.1',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Z.ai coding-plan lane — subscription, no per-token rate published.'
      },
      {
        modelId: 'zai/glm-5.2',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Z.ai coding-plan lane — subscription, no per-token rate published.'
      },
      {
        modelId: 'qwen-token-plan/qwen3.7-max',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Qwen token plan — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'qwen-token-plan/qwen3.7-plus',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Qwen token plan — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'qwen-token-plan/qwen3.8-max',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Qwen token plan — prepaid allowance, no per-token rate published.'
      },
      // Xiaomi token plan — three regional deployments of the SAME prepaid
      // MiMo catalog; pi publishes no per-token price, so 0 means "no
      // per-token projection", NOT "free" (same rule as Z.ai/Qwen above).
      {
        modelId: 'xiaomi-token-plan-cn/mimo-v2-pro',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (China) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-cn/mimo-v2.5',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (China) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-cn/mimo-v2.5-pro',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (China) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-sgp/mimo-v2-pro',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (Singapore) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-sgp/mimo-v2.5',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (Singapore) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (Singapore) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-ams/mimo-v2-pro',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (Amsterdam) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-ams/mimo-v2.5',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (Amsterdam) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'xiaomi-token-plan-ams/mimo-v2.5-pro',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        subscriptionLane: true,
        sourceUrl: 'https://pi.dev/docs/latest/providers',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Xiaomi token plan (Amsterdam) — prepaid allowance, no per-token rate published.'
      },
      {
        modelId: 'minimax/MiniMax-M2.7',
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 1.2,
        cachedInputUsdPerMillion: 0.06,
        sourceUrl: 'https://platform.minimax.io/docs/price',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'MiniMax model ids are CASE-SENSITIVE.'
      },
      {
        modelId: 'minimax/MiniMax-M3',
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 1.2,
        cachedInputUsdPerMillion: 0.06,
        sourceUrl: 'https://platform.minimax.io/docs/price',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'MiniMax model ids are CASE-SENSITIVE.'
      },
      {
        modelId: 'mistral/zai-glm-5-2',
        inputUsdPerMillion: 1.4,
        outputUsdPerMillion: 4.4,
        cachedInputUsdPerMillion: 0.14,
        sourceUrl: 'https://docs.mistral.ai/models/zai-glm-5-2',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Third-party Z.ai GLM-5.2 served without modification by Mistral.'
      },
      {
        modelId: 'mistral/mistral-medium-3.5',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 7.5,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/mistral-medium-latest',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 7.5,
        cachedInputUsdPerMillion: 0.15,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Floating Mistral Medium alias; currently priced like Mistral Medium 3.5.'
      },
      {
        modelId: 'mistral/mistral-small-2603',
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.6,
        cachedInputUsdPerMillion: 0.015,
        sourceUrl: 'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/mistral-large-2512',
        inputUsdPerMillion: 0.5,
        outputUsdPerMillion: 1.5,
        cachedInputUsdPerMillion: 0.05,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Mistral Large 3. Cheaper per token than medium-3.5 despite being the flagship — do not infer this row from the medium one.'
      },
      {
        modelId: 'mistral/devstral-2512',
        inputUsdPerMillion: 0.4,
        outputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.04,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/codestral-2508',
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 0.9,
        cachedInputUsdPerMillion: 0.03,
        sourceUrl: 'https://docs.mistral.ai/models/codestral-25-08',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/labs-leanstral-1-5',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://docs.mistral.ai/models/leanstral-1-5',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Free Mistral Labs public preview; Labs ids may change on short notice.'
      },
      {
        modelId: 'mistral/mistral-medium-2508',
        inputUsdPerMillion: 0.4,
        outputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.04,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/mistral-medium-2505',
        inputUsdPerMillion: 0.4,
        outputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.04,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/ministral-14b-2512',
        inputUsdPerMillion: 0.2,
        outputUsdPerMillion: 0.2,
        cachedInputUsdPerMillion: 0.02,
        sourceUrl: 'https://docs.mistral.ai/models/ministral-3-14b-25-12',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/ministral-8b-2512',
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.15,
        cachedInputUsdPerMillion: 0.015,
        sourceUrl: 'https://docs.mistral.ai/models/ministral-3-8b-25-12',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral/ministral-3b-2512',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.1,
        cachedInputUsdPerMillion: 0.01,
        sourceUrl: 'https://docs.mistral.ai/models/ministral-3-3b-25-12',
        lastVerified: RATE_TABLE_VERSION
      },
      // Groq wire ids carry a SECOND slash — the id below is the whole key.
      {
        modelId: 'groq/openai/gpt-oss-120b',
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.6,
        cachedInputUsdPerMillion: 0.075,
        sourceUrl: 'https://groq.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Paid tier; Groq also has a free tier where actual spend is 0.'
      },
      {
        modelId: 'groq/qwen/qwen3-32b',
        inputUsdPerMillion: 0.29,
        outputUsdPerMillion: 0.59,
        sourceUrl: 'https://groq.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Paid tier; Groq also has a free tier where actual spend is 0.'
      },
      {
        modelId: 'cerebras/gpt-oss-120b',
        inputUsdPerMillion: 0.35,
        outputUsdPerMillion: 0.75,
        sourceUrl: 'https://www.cerebras.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Paid tier; Cerebras also has a free 1M tokens/day tier.'
      },
      {
        modelId: 'cerebras/zai-glm-4.7',
        inputUsdPerMillion: 2.25,
        outputUsdPerMillion: 2.75,
        sourceUrl: 'https://www.cerebras.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Most expensive wired Pi model by input rate — ~16x DeepSeek V4 Flash.'
      },
      {
        modelId: 'openrouter/stealth/ox-alpha',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/stealth/ox-alpha',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Formerly free on OpenRouter; retired 2026-08-28 and retained only so historical Pi chats and ensemble seats keep their cost records.'
      },
      {
        modelId: 'openrouter/z-ai/glm-5.2',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/z-ai/glm-5.2',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Free on OpenRouter (verified 2026-08-21); mirrors cost 0/0 in PiOpenRouterModelRegistration.'
      },
      {
        modelId: 'openrouter/poolside/laguna-s-2.1',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/poolside/laguna-s-2.1',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Free on OpenRouter (verified 2026-08-21); mirrors cost 0/0 in PiOpenRouterModelRegistration.'
      },
      {
        modelId: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenRouter :free variant (verified 2026-08-21); mirrors cost 0/0 in PiOpenRouterModelRegistration.'
      },
      {
        modelId: 'openrouter/cohere/north-mini-code:free',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/cohere/north-mini-code:free',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenRouter :free variant (verified 2026-08-30); mirrors cost 0/0 in PiOpenRouterModelRegistration.'
      },
      {
        modelId: 'openrouter/minimax/minimax-m3:free',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/minimax/minimax-m3:free',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenRouter :free variant (verified 2026-08-30); mirrors cost 0/0 in PiOpenRouterModelRegistration.'
      },
      {
        modelId: 'openrouter/thinkingmachines/inkling:free',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/thinkingmachines/inkling:free',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenRouter :free variant (verified 2026-08-30); mirrors cost 0/0 in PiOpenRouterModelRegistration.'
      },
      {
        modelId: 'openrouter/thinkingmachines/inkling-small:free',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://openrouter.ai/thinkingmachines/inkling-small:free',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'OpenRouter :free variant (verified 2026-08-30); mirrors cost 0/0 in PiOpenRouterModelRegistration.'
      }
    ]
  },
  // agy-lane records (non-prefixed ids) fall back to the first row as a
  // projected API-equivalent, same as the other subscription providers.
  // Row order matters twice: unknown ids fall back to the FIRST row, and
  // prefix matches scan in order (exact ids always win first).
  antigravity: {
    provider: 'antigravity',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    models: [
      {
        modelId: 'gemini-api:gemini-2.5-flash',
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 2.5,
        cachedInputUsdPerMillion: 0.03,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Gemini API paid tier via the AntiGravity BYO-key lane. First row = fallback rate for unknown/agy ids.'
      },
      {
        modelId: 'gemini-api:gemini-2.5-flash-lite',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.4,
        cachedInputUsdPerMillion: 0.01,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Gemini API paid tier via the AntiGravity BYO-key lane.'
      },
      {
        modelId: 'gemini-api:gemini-2.5-pro',
        inputUsdPerMillion: 1.25,
        outputUsdPerMillion: 10.0,
        cachedInputUsdPerMillion: 0.125,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Gemini API paid tier, ≤200K-prompt rate; >200K prompts bill higher (not modelled — long-prompt estimates undercount).'
      },
      {
        modelId: 'gemini-api:gemini-3.1-pro',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 12.0,
        cachedInputUsdPerMillion: 0.2,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Gemini API paid tier via the AntiGravity BYO-key lane. Covers the -preview alias by prefix.'
      },
      {
        modelId: 'gemini-api:gemini-3.1-flash-lite',
        inputUsdPerMillion: 0.25,
        outputUsdPerMillion: 1.5,
        cachedInputUsdPerMillion: 0.025,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Gemini API paid tier via the AntiGravity BYO-key lane.'
      },
      {
        // ANTIGRAVITY_MODELS offers this id, but it had no row: neither the
        // exact nor the prefix match in `resolveModelRate` can bridge
        // `gemini-2.0-flash` to `gemini-2.5-flash`, so it fell through to
        // `models[0]` and every 2.0 Flash run was projected at 2.5 Flash rates
        // (3x input, 6.25x output) — and the model was absent from the
        // Provider/Model API Rates table entirely.
        modelId: 'gemini-api:gemini-2.0-flash',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.4,
        cachedInputUsdPerMillion: 0.025,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Gemini API paid tier via the AntiGravity BYO-key lane.'
      },
      // The 2.5/2.0 rows above are retained deliberately: they no longer
      // appear in the offer floor but still price historical runs. The three
      // rows below are the current floor's remaining ids — without them
      // `resolveModelRate` falls through to `models[0]` and prices them at 2.5
      // Flash, which is exactly how gemini-2.0-flash shipped mispriced.
      {
        // PROMOTIONAL: $0.75/$3.75/$0.075 holds through 2026-12-31, then
        // doubles to $1.50/$7.50/$0.15 on 2027-01-01. The table carries one
        // flat rate per model, so every 3.6 Flash projection UNDERSTATES cost
        // by 2x from that date until this row is re-verified.
        modelId: 'gemini-api:gemini-3.6-flash',
        inputUsdPerMillion: 0.75,
        outputUsdPerMillion: 3.75,
        cachedInputUsdPerMillion: 0.075,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Gemini API paid tier via the AntiGravity BYO-key lane. Promotional rate through 2026-12-31; doubles 2027-01-01.'
      },
      {
        modelId: 'gemini-api:gemini-3.5-flash',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 9.0,
        cachedInputUsdPerMillion: 0.15,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Gemini API paid tier via the AntiGravity BYO-key lane.'
      },
      {
        // Same rate as the `gemini-3.1-pro` row above, which already declared
        // it covered this alias by prefix. Stated exactly rather than left to
        // the prefix match, because a prefix hit resolves under the OTHER
        // row's id and reads as unpriced to the offered-model coverage guard.
        modelId: 'gemini-api:gemini-3.1-pro-preview',
        inputUsdPerMillion: 2.0,
        outputUsdPerMillion: 12.0,
        cachedInputUsdPerMillion: 0.2,
        sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Gemini API paid tier, ≤200K-prompt rate; >200K prompts bill higher (not modelled — long-prompt estimates undercount).'
      }
    ]
  },
  // Mistral seat (ProviderId 'mistral'): the Vibe CLI over ACP, plan-backed
  // OAuth sign-in — NOT the Pi BYOK `mistral/*` upstream rows above (those
  // are a distinct identity; see the `mistral` PiUpstreamId note in
  // store/types.ts). Bare (no-slash) model ids so they can't collide with
  // Pi's `mistral/<model>` wire ids. Like Grok/Kimi, TaskWraith drives this
  // through a subscription, not the Mistral API directly, so these rates are
  // a PROJECTED API-equivalent — same published figures as the Pi upstream's
  // `mistral/mistral-medium-3.5` and `mistral/devstral-2512` rows, since both
  // lanes reach the same underlying models.
  mistral: {
    provider: 'mistral',
    pricingUrl: 'https://mistral.ai/pricing',
    models: [
      {
        modelId: 'mistral-medium-3.5',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 7.5,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Vibe CLI default model. PROJECTED API-equivalent for the plan-backed subscription lane, not actual billing. First row = fallback rate for unknown mistral ids.'
      },
      {
        modelId: 'mistral-vibe-cli-latest',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 7.5,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Wire id alias for mistral-medium-3.5 — some Vibe CLI events report this id instead of the display name.'
      },
      {
        modelId: 'devstral-small',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.3,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          "Read from the Vibe CLI's own bundled catalog (vibe/core/config/vibe_schema.py DEFAULT_MODELS: devstral-small-latest, input_price=0.1, output_price=0.3), which is authoritative over the marketing page. Do NOT copy the $0.40/$2.00 figure — that is Devstral 2, a DIFFERENT and larger model from Devstral 2 Small. PROJECTED API-equivalent for the plan-backed subscription lane, not actual billing."
      },
      {
        modelId: 'mistral-large-2512',
        inputUsdPerMillion: 0.5,
        outputUsdPerMillion: 1.5,
        cachedInputUsdPerMillion: 0.05,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Mistral Large 3.'
      },
      {
        modelId: 'zai-glm-5-2',
        inputUsdPerMillion: 1.4,
        outputUsdPerMillion: 4.4,
        cachedInputUsdPerMillion: 0.14,
        sourceUrl: 'https://docs.mistral.ai/models/zai-glm-5-2',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Third-party Z.ai GLM-5.2 served by Mistral.'
      },
      {
        modelId: 'codestral-2508',
        inputUsdPerMillion: 0.3,
        outputUsdPerMillion: 0.9,
        cachedInputUsdPerMillion: 0.03,
        sourceUrl: 'https://docs.mistral.ai/models/codestral-25-08',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral-small-2603',
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.6,
        cachedInputUsdPerMillion: 0.015,
        sourceUrl: 'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'devstral-2512',
        inputUsdPerMillion: 0.4,
        outputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.04,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'labs-leanstral-1-5',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        freeModel: true,
        sourceUrl: 'https://docs.mistral.ai/models/leanstral-1-5',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Free Mistral Labs public preview.'
      },
      {
        modelId: 'mistral-medium-latest',
        inputUsdPerMillion: 1.5,
        outputUsdPerMillion: 7.5,
        cachedInputUsdPerMillion: 0.15,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral-medium-2508',
        inputUsdPerMillion: 0.4,
        outputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.04,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'mistral-medium-2505',
        inputUsdPerMillion: 0.4,
        outputUsdPerMillion: 2,
        cachedInputUsdPerMillion: 0.04,
        sourceUrl: 'https://mistral.ai/pricing',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'ministral-14b-2512',
        inputUsdPerMillion: 0.2,
        outputUsdPerMillion: 0.2,
        cachedInputUsdPerMillion: 0.02,
        sourceUrl: 'https://docs.mistral.ai/models/ministral-3-14b-25-12',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'ministral-8b-2512',
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.15,
        cachedInputUsdPerMillion: 0.015,
        sourceUrl: 'https://docs.mistral.ai/models/ministral-3-8b-25-12',
        lastVerified: RATE_TABLE_VERSION
      },
      {
        modelId: 'ministral-3b-2512',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.1,
        cachedInputUsdPerMillion: 0.01,
        sourceUrl: 'https://docs.mistral.ai/models/ministral-3-3b-25-12',
        lastVerified: RATE_TABLE_VERSION
      }
      // Vibe's third catalogue entry, `local` (a llamacpp backend on
      // 127.0.0.1:8080), has NO row here on purpose. An earlier revision
      // registered it at zero to stop `resolveModelRate` falling back to
      // models[0] and charging a free local run at the flagship rate — but a
      // zero-priced row violates the positive-rate invariant every other
      // provider upholds, and the seat does not offer `local` at all
      // (MISTRAL_SEAT_MODELS excludes it: local inference is Ollama's lane
      // here). A model the picker never offers cannot be run, so it cannot be
      // mispriced. If the seat ever does surface it, give it a real lane rather
      // than a zero row.
    ]
  },
  // Muse Code CLI — Meta Model API / subscription lane. Rates are PROJECTED
  // API-equivalent from the Muse CLI model catalog ($/Mtok) until Meta publishes
  // a stable public pricing page TaskWraith can cite as the billing source of
  // truth. First row is the unknown-id fallback.
  muse: {
    provider: 'muse',
    pricingUrl: 'https://www.meta.com/',
    models: [
      {
        modelId: 'muse-spark-1.2',
        inputUsdPerMillion: 1.25,
        outputUsdPerMillion: 4.25,
        cachedInputUsdPerMillion: 0.15,
        sourceUrl: 'https://www.meta.com/',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'PROJECTED API-equivalent from the Muse Code CLI catalog for muse-spark-1.2 ($1.25/$4.25/$0.15 per Mtok input/output/cached). Not Meta-billed invoice line items — subscription / plan spend may differ.'
      },
      {
        modelId: 'muse-spark-1.2-contributor',
        inputUsdPerMillion: 0.1,
        outputUsdPerMillion: 0.2,
        cachedInputUsdPerMillion: 0.002,
        sourceUrl: 'https://www.meta.com/',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'PROJECTED API-equivalent from the Muse Code CLI catalog for muse-spark-1.2-contributor ($0.10/$0.20/$0.002 per Mtok input/output/cached). Discounted tokens carry the provider notice that content, including inter-session messages, may be used for product improvement. Not Meta-billed invoice line items — subscription / plan spend may differ.'
      },
      {
        modelId: 'muse-default',
        inputUsdPerMillion: 1.25,
        outputUsdPerMillion: 4.25,
        cachedInputUsdPerMillion: 0.15,
        sourceUrl: 'https://www.meta.com/',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Wire-id alias for muse-spark-1.2 when a run records the seat default sentinel instead of the catalog id.'
      }
    ]
  }
}

export type RateProbeStatus = 'verified' | 'not-verified' | 'fetch-failed'
export type ProviderRateConfidence = 'baked-in' | 'manual-override'

export interface ModelRateProbeResult {
  modelId: string
  status: RateProbeStatus
  baseline: {
    inputUsdPerMillion: number
    outputUsdPerMillion: number
    longContextThresholdTokens?: number
    longContextInputUsdPerMillion?: number
    longContextOutputUsdPerMillion?: number
    longContextCachedInputUsdPerMillion?: number
    confidence: ProviderRateConfidence
  }
  /** When status is 'verified', the dollar string we found that
   * matched the baked-in input or output rate. Useful for
   * surfacing "we saw '$3.00 / 1M' on the pricing page next to
   * sonnet-4.6 — looks fresh". */
  matchedDollarStrings?: string[]
  /** When status is 'not-verified' or 'fetch-failed', a short
   * human-readable reason. */
  errorMessage?: string
}

export interface ProviderRateProbeResult {
  provider: ProviderId
  pricingUrl: string
  /** When we last successfully fetched the pricing page (ISO). */
  fetchedAt?: string
  /** Per-model probe outcomes. */
  models: ModelRateProbeResult[]
  /** Set when the entire page fetch failed (network, 5xx, timeout). */
  pageFetchError?: string
}

export interface ProviderRatesSnapshot {
  rateTableVersion: string
  /** Baked-in rates — always present. */
  baseline: Record<ProviderId, ProviderRateTable>
  /** Optional local override load summary. Overrides are manually
   * authored and validated before they can alter the baseline. */
  manualOverrides?: ProviderRateManualOverrideSummary
  /** Probe results from the last `probeProviderRates` run. May
   * be empty / stale; clients should treat `baseline` as the
   * source of truth and probe results as drift signals only. */
  probe?: {
    runAt: string
    results: Record<ProviderId, ProviderRateProbeResult>
  }
}

export interface ProviderRateManualOverride {
  provider: ProviderId
  modelId: string
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
  sourceUrl?: string
  lastVerified?: string
  notes?: string
}

export interface ProviderRateManualOverrideSummary {
  loadedAt: string
  applied: Array<{ provider: ProviderId; modelId: string }>
  rejected: Array<{ provider?: string; modelId?: string; reason: string }>
}

/**
 * Pure helper: given the raw text of a pricing page + a target
 * dollar amount (e.g. `15` for $15), check whether the page
 * contains a recognisable `$X` or `$X.00` near a `1M tokens` or
 * `M tokens` phrase. Tolerant about whitespace + comma grouping.
 *
 * Returns the literal matched substring on success, `null`
 * otherwise. Exported for tests.
 *
 * This is intentionally fuzzy — we're not parsing the pricing
 * page rigorously, just confirming the rate's order of magnitude
 * still shows up. False positives are acceptable (multiple
 * models can share a price); false negatives just mean "drift
 * possibly — go check the page".
 */
export function findDollarRateNearTokenPhrase(
  pageText: string,
  targetDollarValue: number
): string | null {
  if (!pageText || !Number.isFinite(targetDollarValue) || targetDollarValue <= 0) return null
  // Build patterns we'll accept as a match:
  //   "$1.25 / 1M tokens"
  //   "$1.25/M tokens"
  //   "$1.25 per 1M tokens"
  //   "$1.25 / 1,000,000 tokens"
  // The dollar value can render as `1.25` or `1.250` or `1` if
  // exact-integer. We want to be reasonably tolerant.
  const intPart = Math.floor(targetDollarValue)
  const remainder = targetDollarValue - intPart
  // Build a regex that matches the dollar value with either 0/1/2
  // decimal places. Escape the `$` to be literal.
  const decimalGroup =
    remainder === 0
      ? '(?:\\.0{1,2})?'
      : `\\.${Math.round(remainder * 100)
          .toString()
          .padStart(2, '0')}`
  const dollarPattern = `\\$${intPart}${decimalGroup}`
  // Within the SAME ~80 characters, require any of:
  //   "M tokens", "1M tokens", "million tokens", "1,000,000 tokens",
  //   "/ 1M", "per 1M", "/M"
  // Same-window is the cheap proxy for "this dollar applies to a
  // per-token rate" rather than incidental occurrence elsewhere
  // on the page.
  const pattern = new RegExp(
    `${dollarPattern}[^\\n]{0,80}(?:M tokens|million tokens|1,000,000 tokens|/\\s*1?M|per\\s+1?M)`,
    'i'
  )
  const match = pageText.match(pattern)
  return match ? match[0] : null
}

const CACHE_FILENAME = 'provider-rates-probe.json'
const MANUAL_OVERRIDES_FILENAME = 'provider-rates-overrides.json'
const FETCH_TIMEOUT_MS = 15_000
const PROBE_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

function cachePath(): string {
  return join(app.getPath('userData'), CACHE_FILENAME)
}

function manualOverridesPath(): string {
  return join(app.getPath('userData'), MANUAL_OVERRIDES_FILENAME)
}

let cachedSnapshot: ProviderRatesSnapshot = {
  rateTableVersion: RATE_TABLE_VERSION,
  baseline: BAKED_IN_RATES
}

export function getCurrentProviderRates(): ProviderRatesSnapshot {
  return cachedSnapshot
}

const providerIds = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  // Without this, a persisted probe containing the (now probed) AntiGravity
  // table would fail parsing wholesale — parsePersistedProviderRateProbe
  // returns null for the ENTIRE cache on any unknown provider id.
  'antigravity',
  'pi',
  'mistral',
  'muse'
])

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && providerIds.has(value as ProviderId)
}

function isRateProbeStatus(value: unknown): value is RateProbeStatus {
  return value === 'verified' || value === 'not-verified' || value === 'fetch-failed'
}

function isProviderRateConfidence(value: unknown): value is ProviderRateConfidence {
  return value === 'baked-in' || value === 'manual-override'
}

function cloneRateTables(
  tables: Record<ProviderId, ProviderRateTable>
): Record<ProviderId, ProviderRateTable> {
  const out = {} as Record<ProviderId, ProviderRateTable>
  for (const [provider, table] of Object.entries(tables) as Array<
    [ProviderId, ProviderRateTable]
  >) {
    out[provider] = {
      ...table,
      models: table.models.map((model) => ({ ...model }))
    }
  }
  return out
}

function modelRateConfidence(model: ModelRateEntry): ProviderRateConfidence {
  return model.confidence || 'baked-in'
}

function modelProbeBaseline(model: ModelRateEntry): ModelRateProbeResult['baseline'] {
  return {
    inputUsdPerMillion: model.inputUsdPerMillion,
    outputUsdPerMillion: model.outputUsdPerMillion,
    ...(model.longContextThresholdTokens !== undefined
      ? {
          longContextThresholdTokens: model.longContextThresholdTokens,
          longContextInputUsdPerMillion: model.longContextInputUsdPerMillion,
          longContextOutputUsdPerMillion: model.longContextOutputUsdPerMillion,
          longContextCachedInputUsdPerMillion: model.longContextCachedInputUsdPerMillion
        }
      : {}),
    confidence: modelRateConfidence(model)
  }
}

function validUsdRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 10_000
}

function normalizeManualOverrides(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).overrides)) {
    return (raw as Record<string, unknown>).overrides as unknown[]
  }
  return []
}

export function applyManualProviderRateOverrides(
  baseline: Record<ProviderId, ProviderRateTable>,
  rawOverrides: unknown,
  loadedAt: string = new Date().toISOString()
): {
  baseline: Record<ProviderId, ProviderRateTable>
  summary: ProviderRateManualOverrideSummary
} {
  const next = cloneRateTables(baseline)
  const summary: ProviderRateManualOverrideSummary = { loadedAt, applied: [], rejected: [] }
  for (const raw of normalizeManualOverrides(rawOverrides)) {
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    const provider = entry?.provider
    const modelId = typeof entry?.modelId === 'string' ? entry.modelId.trim() : ''
    if (!entry || !isProviderId(provider)) {
      summary.rejected.push({ modelId, reason: 'unknown-provider' })
      continue
    }
    const table = next[provider]
    const modelIndex = table.models.findIndex((model) => model.modelId === modelId)
    if (modelIndex < 0) {
      summary.rejected.push({ provider, modelId, reason: 'unknown-model' })
      continue
    }
    if (!validUsdRate(entry.inputUsdPerMillion) || !validUsdRate(entry.outputUsdPerMillion)) {
      summary.rejected.push({ provider, modelId, reason: 'invalid-rate' })
      continue
    }
    if (entry.outputUsdPerMillion < entry.inputUsdPerMillion) {
      summary.rejected.push({ provider, modelId, reason: 'output-below-input' })
      continue
    }
    const cachedInput =
      entry.cachedInputUsdPerMillion === undefined
        ? undefined
        : validUsdRate(entry.cachedInputUsdPerMillion) &&
            entry.cachedInputUsdPerMillion < entry.inputUsdPerMillion
          ? entry.cachedInputUsdPerMillion
          : null
    if (cachedInput === null) {
      summary.rejected.push({ provider, modelId, reason: 'invalid-cached-input-rate' })
      continue
    }
    const current = table.models[modelIndex]
    table.models[modelIndex] = {
      ...current,
      inputUsdPerMillion: entry.inputUsdPerMillion,
      outputUsdPerMillion: entry.outputUsdPerMillion,
      ...(cachedInput !== undefined ? { cachedInputUsdPerMillion: cachedInput } : {}),
      sourceUrl:
        typeof entry.sourceUrl === 'string' && entry.sourceUrl
          ? entry.sourceUrl
          : current.sourceUrl,
      lastVerified:
        typeof entry.lastVerified === 'string' && Number.isFinite(Date.parse(entry.lastVerified))
          ? entry.lastVerified
          : loadedAt.slice(0, 10),
      notes:
        typeof entry.notes === 'string' && entry.notes.trim()
          ? `Manual override: ${entry.notes.trim()}`
          : 'Manual override.',
      confidence: 'manual-override'
    }
    summary.applied.push({ provider, modelId })
  }
  return { baseline: next, summary }
}

export function shouldRefreshProviderRateProbe(
  snapshot: ProviderRatesSnapshot,
  now: number = Date.now()
): boolean {
  const runAt = snapshot.probe?.runAt
  if (!runAt) return true
  const runAtMs = Date.parse(runAt)
  if (!Number.isFinite(runAtMs)) return true
  return now - runAtMs > PROBE_REFRESH_INTERVAL_MS
}

export function parsePersistedProviderRateProbe(
  raw: string
): ProviderRatesSnapshot['probe'] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const probe = parsed as Record<string, unknown>
  if (typeof probe.runAt !== 'string' || !Number.isFinite(Date.parse(probe.runAt))) return null
  const rawResults = probe.results
  if (!rawResults || typeof rawResults !== 'object') return null
  const results = {} as Record<ProviderId, ProviderRateProbeResult>
  for (const [providerRaw, resultRaw] of Object.entries(rawResults)) {
    if (!isProviderId(providerRaw)) return null
    if (!resultRaw || typeof resultRaw !== 'object') return null
    const result = resultRaw as Record<string, unknown>
    if (!Array.isArray(result.models)) return null
    if (result.fetchedAt !== undefined && typeof result.fetchedAt !== 'string') return null
    if (result.pageFetchError !== undefined && typeof result.pageFetchError !== 'string') {
      return null
    }
    const models: ModelRateProbeResult[] = []
    for (const modelRaw of result.models) {
      if (!modelRaw || typeof modelRaw !== 'object') return null
      const model = modelRaw as Record<string, unknown>
      const baseline = model.baseline as Record<string, unknown> | undefined
      if (!baseline || typeof baseline !== 'object') return null
      const confidence = baseline.confidence
      if (confidence !== undefined && !isProviderRateConfidence(confidence)) return null
      if (
        typeof model.modelId !== 'string' ||
        !isRateProbeStatus(model.status) ||
        !validUsdRate(baseline.inputUsdPerMillion) ||
        !validUsdRate(baseline.outputUsdPerMillion)
      ) {
        return null
      }
      if (
        model.matchedDollarStrings !== undefined &&
        (!Array.isArray(model.matchedDollarStrings) ||
          model.matchedDollarStrings.some((match) => typeof match !== 'string'))
      ) {
        return null
      }
      if (model.errorMessage !== undefined && typeof model.errorMessage !== 'string') return null
      const inputUsdPerMillion = baseline.inputUsdPerMillion
      const outputUsdPerMillion = baseline.outputUsdPerMillion
      const longContextThresholdTokens = baseline.longContextThresholdTokens
      const longContextInputUsdPerMillion = baseline.longContextInputUsdPerMillion
      const longContextOutputUsdPerMillion = baseline.longContextOutputUsdPerMillion
      const longContextCachedInputUsdPerMillion = baseline.longContextCachedInputUsdPerMillion
      const hasLongContextMetadata =
        longContextThresholdTokens !== undefined ||
        longContextInputUsdPerMillion !== undefined ||
        longContextOutputUsdPerMillion !== undefined ||
        longContextCachedInputUsdPerMillion !== undefined
      if (
        hasLongContextMetadata &&
        (!Number.isInteger(longContextThresholdTokens) ||
          !(typeof longContextThresholdTokens === 'number' && longContextThresholdTokens > 0) ||
          !validUsdRate(longContextInputUsdPerMillion) ||
          !validUsdRate(longContextOutputUsdPerMillion) ||
          longContextOutputUsdPerMillion < longContextInputUsdPerMillion ||
          !validUsdRate(longContextCachedInputUsdPerMillion) ||
          longContextCachedInputUsdPerMillion >= longContextInputUsdPerMillion)
      ) {
        return null
      }
      const matchedDollarStrings = Array.isArray(model.matchedDollarStrings)
        ? (model.matchedDollarStrings as string[])
        : undefined
      models.push({
        modelId: model.modelId,
        status: model.status,
        baseline: {
          inputUsdPerMillion,
          outputUsdPerMillion,
          ...(hasLongContextMetadata
            ? {
                longContextThresholdTokens: longContextThresholdTokens as number,
                longContextInputUsdPerMillion: longContextInputUsdPerMillion as number,
                longContextOutputUsdPerMillion: longContextOutputUsdPerMillion as number,
                longContextCachedInputUsdPerMillion: longContextCachedInputUsdPerMillion as number
              }
            : {}),
          confidence: confidence || 'baked-in'
        },
        matchedDollarStrings,
        errorMessage: model.errorMessage
      })
    }
    results[providerRaw] = {
      provider: providerRaw,
      pricingUrl: typeof result.pricingUrl === 'string' ? result.pricingUrl : '',
      fetchedAt: result.fetchedAt,
      models,
      pageFetchError: result.pageFetchError
    }
  }
  return { runAt: probe.runAt, results }
}

async function loadManualOverrideBaseline(): Promise<{
  baseline: Record<ProviderId, ProviderRateTable>
  manualOverrides?: ProviderRateManualOverrideSummary
}> {
  try {
    const raw = await fs.readFile(manualOverridesPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    const result = applyManualProviderRateOverrides(BAKED_IN_RATES, parsed)
    return { baseline: result.baseline, manualOverrides: result.summary }
  } catch {
    return { baseline: BAKED_IN_RATES }
  }
}

/**
 * Best-effort fetch + parse of one provider's pricing page.
 * Returns a probe result with per-model `verified` / `not-verified`
 * statuses. The probe NEVER throws — every error mode is captured
 * on the returned object.
 */
async function probeOneProvider(table: ProviderRateTable): Promise<ProviderRateProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let pageText = ''
  try {
    const response = await fetch(table.pricingUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'TaskWraith/1.0.5 (provider-rate-probe; respects robots.txt; contact: noreply@anthropic.com)'
      }
    })
    clearTimeout(timer)
    if (!response.ok) {
      return {
        provider: table.provider,
        pricingUrl: table.pricingUrl,
        pageFetchError: `HTTP ${response.status}`,
        models: table.models.map((m) => ({
          modelId: m.modelId,
          status: 'fetch-failed',
          baseline: modelProbeBaseline(m),
          errorMessage: `Pricing page returned HTTP ${response.status}.`
        }))
      }
    }
    pageText = await response.text()
  } catch (error) {
    clearTimeout(timer)
    const message = error instanceof Error ? error.message : 'fetch failed'
    return {
      provider: table.provider,
      pricingUrl: table.pricingUrl,
      pageFetchError: message,
      models: table.models.map((m) => ({
        modelId: m.modelId,
        status: 'fetch-failed',
        baseline: modelProbeBaseline(m),
        errorMessage: message
      }))
    }
  }
  return {
    provider: table.provider,
    pricingUrl: table.pricingUrl,
    fetchedAt: new Date().toISOString(),
    models: table.models.map((m) => {
      const matchedInput = findDollarRateNearTokenPhrase(pageText, m.inputUsdPerMillion)
      const matchedOutput = findDollarRateNearTokenPhrase(pageText, m.outputUsdPerMillion)
      const matched: string[] = []
      if (matchedInput) matched.push(matchedInput)
      if (matchedOutput) matched.push(matchedOutput)
      // Require at least ONE of input/output to match — if both miss,
      // the rate likely drifted or the page format changed.
      const status: RateProbeStatus = matched.length > 0 ? 'verified' : 'not-verified'
      return {
        modelId: m.modelId,
        status,
        baseline: modelProbeBaseline(m),
        matchedDollarStrings: matched.length > 0 ? matched : undefined,
        errorMessage:
          matched.length === 0
            ? `Neither $${m.inputUsdPerMillion} nor $${m.outputUsdPerMillion} matched a per-1M-tokens phrase on the pricing page. Page format may have changed, or rates may have drifted.`
            : undefined
      }
    })
  }
}

/**
 * Run the probe across every provider. Best-effort — failures on
 * one provider don't affect the others. Updates the in-memory
 * snapshot + persists to disk for next-boot warm-start.
 */
export async function probeAllProviderRates(
  options: { force?: boolean } = {}
): Promise<ProviderRatesSnapshot> {
  const { baseline, manualOverrides } = await loadManualOverrideBaseline()
  const probe = cachedSnapshot.probe
  cachedSnapshot = {
    rateTableVersion: RATE_TABLE_VERSION,
    baseline,
    ...(manualOverrides ? { manualOverrides } : {}),
    ...(probe ? { probe } : {})
  }
  if (!options.force && !shouldRefreshProviderRateProbe(cachedSnapshot)) {
    return cachedSnapshot
  }

  // Skip providers with no baked-in models or a non-HTTP pricing URL.
  const providers = (Object.values(baseline) as ProviderRateTable[]).filter(
    (table) => table.models.length > 0 && /^https?:\/\//i.test(table.pricingUrl)
  )
  const results = await Promise.all(providers.map(probeOneProvider))
  const resultsMap: Record<ProviderId, ProviderRateProbeResult> = {} as Record<
    ProviderId,
    ProviderRateProbeResult
  >
  for (const result of results) {
    resultsMap[result.provider] = result
  }
  cachedSnapshot = {
    rateTableVersion: RATE_TABLE_VERSION,
    baseline,
    ...(manualOverrides ? { manualOverrides } : {}),
    probe: {
      runAt: new Date().toISOString(),
      results: resultsMap
    }
  }
  void persistSnapshot(cachedSnapshot)
  return cachedSnapshot
}

async function persistSnapshot(snapshot: ProviderRatesSnapshot): Promise<void> {
  if (!snapshot.probe) return
  try {
    await fs.writeFile(cachePath(), JSON.stringify(snapshot.probe, null, 2), 'utf-8')
  } catch {
    // Best-effort.
  }
}

/**
 * Load the persisted probe results (if any) into the in-memory
 * snapshot. Called on app boot so the renderer's first
 * `providerRates:get` returns useful data even before a fresh
 * probe completes.
 */
export async function loadPersistedProbeResults(): Promise<void> {
  const { baseline, manualOverrides } = await loadManualOverrideBaseline()
  let probe: ProviderRatesSnapshot['probe'] | null = null
  try {
    const raw = await fs.readFile(cachePath(), 'utf-8')
    probe = parsePersistedProviderRateProbe(raw)
  } catch {
    // No cache yet or malformed — baseline-only snapshot stays in memory until
    // the next eligible probe run.
  }
  cachedSnapshot = {
    rateTableVersion: RATE_TABLE_VERSION,
    baseline,
    ...(manualOverrides ? { manualOverrides } : {}),
    ...(probe ? { probe } : {})
  }
}

/**
 * Test-only reset. Clears the in-memory snapshot so each test
 * starts from baseline.
 */
export function __resetProviderRateServiceForTesting(): void {
  cachedSnapshot = {
    rateTableVersion: RATE_TABLE_VERSION,
    baseline: BAKED_IN_RATES
  }
}
