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
export const RATE_TABLE_VERSION = '2026-06-28'

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
  /** Where this rate lives in the canonical docs. */
  sourceUrl: string
  /** Date the rate was last hand-verified (ISO 8601). */
  lastVerified: string
  /** Optional notes — e.g. "subscription-only via Codex CLI",
   * "tier-1 only", "preview pricing". */
  notes?: string
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
 * reviewed 2026-06-23.
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
  // Grok (gated). IMPORTANT: TaskWraith drives Grok through the SuperGrok CLI
  // subscription (a credit pool — see GrokUsage's "Subscription credits"
  // meter), NOT the xAI per-token API. These rates are therefore a PROJECTED
  // API-equivalent ("what this run would have cost on the xAI API"), not actual
  // billing. Captured from xAI pricing docs 2026-06-23.
  grok: {
    provider: 'grok',
    pricingUrl: 'https://docs.x.ai/developers/pricing',
    models: [
      {
        modelId: 'grok-build',
        inputUsdPerMillion: 1.0,
        outputUsdPerMillion: 2.0,
        cachedInputUsdPerMillion: 0.2,
        sourceUrl: 'https://docs.x.ai/developers/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'xAI API pricing for grok-build-0.1 (256K ctx). PROJECTED API-equivalent; CLI auth bills via subscription credits.'
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
  // Cursor / Composer 2.5 (gated, CR). TaskWraith drives Cursor through the
  // cursor-agent CLI on the user's Cursor subscription. Individual plans bill
  // via a Composer usage pool; team/enterprise pass API rates through. Public
  // Fast-tier list pricing (default interactive tier) is published on Cursor's
  // model docs — we project ALL Cursor token rows against composer-2.5-fast
  // as a conservative interactive-session proxy (estimated, not billed).
  cursor: {
    provider: 'cursor',
    pricingUrl: 'https://cursor.com/docs/models/cursor-composer-2-5',
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
      }
    ]
  },
  codex: {
    provider: 'codex',
    pricingUrl: 'https://openai.com/api/pricing',
    models: [
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
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Frontier tier above Opus (added 2026-06-09). $10/$50 per published rate.'
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
        modelId: 'claude-opus-4-8',
        inputUsdPerMillion: 5.0,
        outputUsdPerMillion: 25.0,
        cachedInputUsdPerMillion: 0.5,
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Current-gen Opus. Published rate $5/$25 (2026-06-09 diligence cycle; replaces the $15/$75 placeholder assumed from the pre-4.5 Opus tier).'
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
        sourceUrl: 'https://www.anthropic.com/pricing',
        lastVerified: RATE_TABLE_VERSION,
        notes:
          'Current-gen Sonnet. Assumed Sonnet-tier billing ($3/$15/$0.3) pending published Sonnet 5 rates — it shares the Opus 4.8 reasoning ladder but NOT Opus billing. Verify against https://www.anthropic.com/pricing before release.'
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
        notes: 'Current Kimi Code CLI default; automatic context cache hit pricing recorded as cached input.'
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
        modelId: 'qwen3.5:9b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Qwen 3.5 9B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'qwen3.6:35b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Qwen 3.6 35B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gemma4:12b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Google Gemma 4 12B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Ornith 1.0 9B alias running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith:latest',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Ornith 1.0 9B alias running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith:9b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Ornith 1.0 9B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'ornith:35b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Ornith 1.0 35B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gemma4:12b-it-q4_K_M',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'Google Gemma 4 12B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gpt-oss',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gpt-oss:20b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'gpt-oss:latest',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'minicpm-v4.5:8b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'MiniCPM-V 4.5 8B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4.1:3b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'IBM Granite 4.1 3B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'granite4.1:30b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'IBM Granite 4.1 30B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'nemotron3:33b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'NVIDIA Nemotron 3 Nano Omni 33B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
      },
      {
        modelId: 'openai/gpt-oss-20b',
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        sourceUrl: 'local://ollama',
        lastVerified: RATE_TABLE_VERSION,
        notes: 'OpenAI gpt-oss 20B running through local Ollama. TaskWraith does not charge per token for local inference.',
        confidence: 'baked-in'
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
  'ollama'
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
  for (const [provider, table] of Object.entries(tables) as Array<[ProviderId, ProviderRateTable]>) {
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
      sourceUrl: typeof entry.sourceUrl === 'string' && entry.sourceUrl ? entry.sourceUrl : current.sourceUrl,
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

export function parsePersistedProviderRateProbe(raw: string): ProviderRatesSnapshot['probe'] | null {
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
      const matchedDollarStrings = Array.isArray(model.matchedDollarStrings)
        ? (model.matchedDollarStrings as string[])
        : undefined
      models.push({
        modelId: model.modelId,
        status: model.status,
        baseline: {
          inputUsdPerMillion,
          outputUsdPerMillion,
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
