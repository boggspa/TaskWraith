import type { ContextBudget } from '../PromptComposition'
import { resolveContextWindow } from '../../shared/contextWindows'
import { ollamaModelIdsMatch } from '../../shared/ollamaModelAvailability'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

/**
 * Read a daemon-measured context length out of the cache in
 * `AppSettings.ollamaModelContextTokens`.
 *
 * Takes the plain record rather than `AppSettings` so this module stays free of
 * settings types. Returns undefined when nothing usable is cached, which every
 * consumer must treat as "not measured" rather than as zero.
 */
export function resolveOllamaMeasuredContextTokens(
  measuredByModelId: Record<string, number> | undefined | null,
  modelId: string | null | undefined
): number | undefined {
  const trimmed = String(modelId || '').trim()
  if (!trimmed || !measuredByModelId) return undefined
  const usable = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
  const exact = measuredByModelId[trimmed]
  if (usable(exact)) return Math.trunc(exact)
  // The cache is written under the RESOLVED model id while callers usually hold
  // the REQUESTED one, and `gemma:7b` / `gemma:7b-latest` are the same model. Fall
  // back to the alias-aware matcher; the record holds one entry per installed
  // model, so this is a handful of comparisons rather than a scan of anything big.
  for (const [key, value] of Object.entries(measuredByModelId)) {
    if (usable(value) && ollamaModelIdsMatch(trimmed, key)) return Math.trunc(value)
  }
  return undefined
}

const OLLAMA_DEFAULT_BUDGET: ContextBudget = {
  maxTurns: 8,
  maxCharsPerTurn: 420,
  maxBlockChars: 6000
}

/**
 * A context length MEASURED from the running daemon (`/api/show` →
 * `model_info.*.context_length`, surfaced as `OllamaModelInfo.contextLength`),
 * as opposed to one looked up in a hand-maintained table or assumed from a
 * provider default. Only a measured value may widen a budget — see the
 * `default:` arm of `resolveOllamaContextBudget`.
 */
function normalizeMeasuredWindow(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

function scaledBudget(
  modelId: string,
  input: {
    maxTurns: number
    maxCharsPerTurn: number
    contextShare: number
    maxBlockChars: number
  },
  measuredContextTokens?: number
): ContextBudget {
  // `liveModelContextLength` is `resolveContextWindow`'s 4th parameter and takes
  // priority over the static `CONTEXT_WINDOWS_BY_MODEL` table for ollama. Every
  // ollama call site historically passed only two arguments, so the whole budget
  // family ran off the table and never the daemon.
  const contextWindow = resolveContextWindow('ollama', modelId, undefined, measuredContextTokens)
  return {
    maxTurns: input.maxTurns,
    maxCharsPerTurn: input.maxCharsPerTurn,
    maxBlockChars: Math.max(
      OLLAMA_DEFAULT_BUDGET.maxBlockChars,
      Math.min(input.maxBlockChars, Math.round(contextWindow * input.contextShare))
    )
  }
}

function qwen4Budget(modelId: string, measured?: number): ContextBudget {
  return scaledBudget(
    modelId,
    { maxTurns: 8, maxCharsPerTurn: 520, contextShare: 0.04, maxBlockChars: 12_000 },
    measured
  )
}

function midCodingBudget(modelId: string, measured?: number): ContextBudget {
  return scaledBudget(
    modelId,
    { maxTurns: 10, maxCharsPerTurn: 720, contextShare: 0.06, maxBlockChars: 18_000 },
    measured
  )
}

function largeCodingBudget(modelId: string, measured?: number): ContextBudget {
  return scaledBudget(
    modelId,
    { maxTurns: 14, maxCharsPerTurn: 1000, contextShare: 0.14, maxBlockChars: 30_000 },
    measured
  )
}

function multimodalBudget(modelId: string, measured?: number): ContextBudget {
  return scaledBudget(
    modelId,
    { maxTurns: 12, maxCharsPerTurn: 900, contextShare: 0.08, maxBlockChars: 26_000 },
    measured
  )
}

function compactToolBudget(modelId: string, measured?: number): ContextBudget {
  return scaledBudget(
    modelId,
    { maxTurns: 8, maxCharsPerTurn: 560, contextShare: 0.08, maxBlockChars: 12_000 },
    measured
  )
}

function gptOssBudget(modelId: string, measured?: number): ContextBudget {
  return scaledBudget(
    modelId,
    { maxTurns: 10, maxCharsPerTurn: 800, contextShare: 0.12, maxBlockChars: 20_000 },
    measured
  )
}

/**
 * Budget for a tag matching no family arm, used ONLY when the window was
 * measured. Shares the most conservative known arm's `contextShare` (0.04) and a
 * modest ceiling, so an unrecognised model with a genuinely large measured window
 * stops being pinned to the floor while a small one still lands there via
 * `scaledBudget`'s existing 6,000-char minimum.
 */
function measuredUnknownBudget(modelId: string, measured: number): ContextBudget {
  return scaledBudget(
    modelId,
    {
      maxTurns: OLLAMA_DEFAULT_BUDGET.maxTurns,
      maxCharsPerTurn: OLLAMA_DEFAULT_BUDGET.maxCharsPerTurn,
      contextShare: 0.04,
      maxBlockChars: 12_000
    },
    measured
  )
}

/**
 * Per-family caps for the compact conversation-context block injected on
 * Ollama solo runs. Known large-window local models get a larger memory block;
 * unknown tags stay conservative because their real num_ctx may be tiny.
 *
 * DO NOT scale the `default:` arm off an UNMEASURED window (tried 2026-07-30 and
 * both tests below caught it). An unknown tag is absent from
 * `CONTEXT_WINDOWS_BY_MODEL`, so `resolveContextWindow` returns the ollama
 * PROVIDER DEFAULT of 262,144 — fabricated, not measured. Scaling off that hands
 * every unrecognised model a ~10.5k block including genuinely 8K-context ones,
 * and erases the distinction the family arms exist to draw. The floor is
 * load-bearing precisely BECAUSE the window is unknown.
 *
 * `measuredContextTokens` is the escape hatch the guarding test always implied
 * ("until live model metadata is known"): a value read from the running daemon,
 * not a table. When it is present the unknown arm may scale, because the window
 * is now a fact; when it is absent the floor stands. That is the ONLY condition
 * under which widening is sound.
 */
export function resolveOllamaContextBudget(
  modelId?: string | null,
  liveContextTokens?: number | null
): ContextBudget {
  const trimmedModelId = String(modelId || '').trim()
  const measured = normalizeMeasuredWindow(liveContextTokens)
  const family = resolveOllamaModelFamily(trimmedModelId)
  switch (family) {
    case 'qwen3_4b':
    case 'qwen3_5_2b':
    case 'qwen3_5_4b':
      return qwen4Budget(trimmedModelId, measured)
    case 'qwen3_5_9b':
    case 'ornith_9b':
    case 'lfm2_5_8b':
    case 'ministral_3_14b':
    case 'llama3_1_8b':
    case 'deepseek_r1_8b':
    case 'rnj_1_8b':
      return midCodingBudget(trimmedModelId, measured)
    case 'qwen3_6_35b':
    case 'ornith_35b':
    case 'laguna_xs_2_1':
    case 'granite4_1_30b':
    case 'nemotron3_33b':
    case 'nemotron3_5_lightning_30b':
    case 'devstral_small_2_24b':
    case 'glm_4_7_flash':
    case 'north_mini_code_1_0':
    case 'muse_glimmer_30b':
      return largeCodingBudget(trimmedModelId, measured)
    case 'minicpm_v45_8b':
    case 'lfm2_5_thinking_1_2b':
    case 'granite4_3b':
    case 'granite4_1_3b':
    case 'nemotron3_nano_4b':
    case 'ministral_3_3b':
    case 'deepseek_r1_1_5b':
    case 'llama3_2_3b':
      return compactToolBudget(trimmedModelId, measured)
    case 'gemma3_4b':
    case 'gemma4_12b':
      return multimodalBudget(trimmedModelId, measured)
    case 'gpt_oss_20b':
      return gptOssBudget(trimmedModelId, measured)
    default:
      return measured
        ? measuredUnknownBudget(trimmedModelId, measured)
        : OLLAMA_DEFAULT_BUDGET
  }
}
