/*
 * ensembleSeatIngest — per-seat shared-transcript ingest budget, derived from
 * the seat model's context window instead of the retired chat-wide "Chars"
 * slider (2026-09-01 product decision).
 *
 * Policy:
 *   - Most models inherit the MAXIMUM ingest their window can carry: the
 *     transcript budget is (window − output/shell reserves) × chars-per-token,
 *     so capable (200k–1M+) models effectively stop truncating the shared
 *     panel history.
 *   - Two model classes stay hand-tunable because a full-window ingest is a
 *     poor default for them: Codex GPT-5.3 Spark, and 4B–12B-parameter local
 *     Ollama models. They default to a 50K-char ingest and accept a per-model
 *     override (stored app-wide in `AppSettings.ensembleModelIngestChars`,
 *     keyed `provider:modelId`), surfaced as a slider on their rows in the
 *     composer's Context · per participant panel.
 *   - Ollama seats additionally keep their existing measured-window clamp
 *     (`resolveOllamaEnsembleTranscriptBudget`), so a window-derived or
 *     overridden request can only ever shrink there, never blow a local
 *     model's context.
 *
 * Pure and renderer-safe: imports only shared modules.
 */

import { resolveContextWindow, type ContextWindowProviderId } from './contextWindows'

/** Floor for any seat ingest budget (parity with the retired slider's min). */
export const ENSEMBLE_SEAT_INGEST_MIN_CHARS = 5_000

/**
 * Ceiling for a window-derived budget. ~4M chars ≈ a fully-used 1.1M-token
 * window at 3.5 chars/token; also the new clamp ceiling inside
 * `projectTaggedTranscript` (which previously hard-clamped to 256K).
 */
export const ENSEMBLE_SEAT_INGEST_MAX_CHARS = 4_000_000

/** Override slider bounds + default for the two hand-tunable model classes. */
export const ENSEMBLE_INGEST_OVERRIDE_MIN_CHARS = 5_000
export const ENSEMBLE_INGEST_OVERRIDE_MAX_CHARS = 256_000
export const ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS = 50_000

/**
 * Window→chars derivation constants. 3.5 chars/token matches the
 * deliberately-conservative ratio the Ollama ensemble budget already uses
 * (code-heavy ensemble transcripts tokenize denser than prose); the reserves
 * leave room for the seat's own output/thinking and the non-transcript prompt
 * shell so a full ingest cannot fill the window to the brim.
 */
export const ENSEMBLE_INGEST_CHARS_PER_TOKEN = 3.5
export const ENSEMBLE_INGEST_OUTPUT_RESERVE_TOKENS = 16_384
export const ENSEMBLE_INGEST_SHELL_RESERVE_TOKENS = 4_096

export interface EnsembleSeatIngestInput {
  provider: string
  modelId?: string | null
  /**
   * Known parameter size in billions, when the caller has better data than
   * the model id (Ollama /api/show `parameter_size`, preflight family
   * defaults). Falls back to parsing the id's `:4b` / `-12b` style suffix.
   */
  parameterBillions?: number | null
  /** Measured/live context window in tokens (e.g. Ollama daemon probe). */
  liveContextTokens?: number
  /** `AppSettings.ensembleModelIngestChars` — keys `provider:modelId`. */
  overrides?: Readonly<Record<string, number>> | null
}

export interface EnsembleSeatIngestResolution {
  chars: number
  source: 'override' | 'exception-default' | 'window-derived'
  /** True when this model class offers the per-model override slider. */
  overrideEligible: boolean
  windowTokens: number
}

export function ensembleIngestOverrideKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`
}

/**
 * Parse a parameter-count out of a model id/tag ("qwen3:4b",
 * "gemma3:4b-instruct", "devstral-small-2:24b", "granite4.1:800m").
 * Returns billions, or null when the id carries no size token.
 */
export function parseParameterBillionsFromModelId(
  modelId: string | null | undefined
): number | null {
  if (!modelId) return null
  const match = /(?:^|[:\-/])(\d+(?:\.\d+)?)\s*([bm])(?=$|[^a-z0-9])/i.exec(modelId)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return match[2].toLowerCase() === 'm' ? value / 1000 : value
}

/** Parse an Ollama `parameter_size` label ("8.2B", "780M") to billions. */
export function parseParameterSizeLabel(label: string | null | undefined): number | null {
  if (!label) return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*([bm])\s*$/i.exec(label)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return match[2].toLowerCase() === 'm' ? value / 1000 : value
}

function isCodexSparkModel(modelId: string): boolean {
  return /(?:^|[:\-/])spark(?:$|[:\-/])|spark$/i.test(modelId)
}

/**
 * The ONLY model classes with a per-model ingest slider: Codex GPT-5.3
 * Spark, and 4B–12B-parameter Ollama locals. Everything else inherits the
 * window-derived maximum.
 */
export function ensembleIngestOverrideEligible(input: {
  provider: string
  modelId?: string | null
  parameterBillions?: number | null
}): boolean {
  const modelId = input.modelId?.trim()
  if (!modelId) return false
  if (input.provider === 'codex') return isCodexSparkModel(modelId)
  if (input.provider === 'ollama') {
    const billions =
      typeof input.parameterBillions === 'number' && Number.isFinite(input.parameterBillions)
        ? input.parameterBillions
        : parseParameterBillionsFromModelId(modelId)
    return billions !== null && billions >= 4 && billions <= 12
  }
  return false
}

export function clampEnsembleIngestOverrideChars(value: number): number {
  return Math.max(
    ENSEMBLE_INGEST_OVERRIDE_MIN_CHARS,
    Math.min(ENSEMBLE_INGEST_OVERRIDE_MAX_CHARS, Math.round(value))
  )
}

function windowDerivedChars(windowTokens: number): number {
  const usableTokens =
    windowTokens - ENSEMBLE_INGEST_OUTPUT_RESERVE_TOKENS - ENSEMBLE_INGEST_SHELL_RESERVE_TOKENS
  const chars = Math.floor(usableTokens * ENSEMBLE_INGEST_CHARS_PER_TOKEN)
  return Math.max(ENSEMBLE_SEAT_INGEST_MIN_CHARS, Math.min(ENSEMBLE_SEAT_INGEST_MAX_CHARS, chars))
}

/**
 * Resolve the requested shared-transcript ingest budget for one seat. For
 * Ollama seats the result is a REQUEST — the model-aware ensemble budget
 * (`resolveOllamaEnsembleTranscriptBudget`) still clamps it to what the local
 * window actually carries.
 */
export function resolveEnsembleSeatIngestChars(
  input: EnsembleSeatIngestInput
): EnsembleSeatIngestResolution {
  const modelId = input.modelId?.trim() || ''
  const windowTokens = resolveContextWindow(
    input.provider as ContextWindowProviderId,
    modelId || undefined,
    undefined,
    input.liveContextTokens
  )
  const overrideEligible = ensembleIngestOverrideEligible({
    provider: input.provider,
    modelId,
    parameterBillions: input.parameterBillions
  })
  if (overrideEligible) {
    const raw = modelId
      ? input.overrides?.[ensembleIngestOverrideKey(input.provider, modelId)]
      : undefined
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return {
        chars: clampEnsembleIngestOverrideChars(raw),
        source: 'override',
        overrideEligible,
        windowTokens
      }
    }
    return {
      chars: ENSEMBLE_INGEST_EXCEPTION_DEFAULT_CHARS,
      source: 'exception-default',
      overrideEligible,
      windowTokens
    }
  }
  return {
    chars: windowDerivedChars(windowTokens),
    source: 'window-derived',
    overrideEligible,
    windowTokens
  }
}
