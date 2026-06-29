import type { ContextBudget } from '../PromptComposition'
import { resolveContextWindow } from '../../shared/contextWindows'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

const OLLAMA_DEFAULT_BUDGET: ContextBudget = {
  maxTurns: 8,
  maxCharsPerTurn: 420,
  maxBlockChars: 6000
}

function scaledBudget(
  modelId: string,
  input: {
    maxTurns: number
    maxCharsPerTurn: number
    contextShare: number
    maxBlockChars: number
  }
): ContextBudget {
  const contextWindow = resolveContextWindow('ollama', modelId)
  return {
    maxTurns: input.maxTurns,
    maxCharsPerTurn: input.maxCharsPerTurn,
    maxBlockChars: Math.max(
      OLLAMA_DEFAULT_BUDGET.maxBlockChars,
      Math.min(input.maxBlockChars, Math.round(contextWindow * input.contextShare))
    )
  }
}

function qwen4Budget(modelId: string): ContextBudget {
  return scaledBudget(modelId, {
    maxTurns: 8,
    maxCharsPerTurn: 520,
    contextShare: 0.04,
    maxBlockChars: 12_000
  })
}

function midCodingBudget(modelId: string): ContextBudget {
  return scaledBudget(modelId, {
    maxTurns: 10,
    maxCharsPerTurn: 720,
    contextShare: 0.06,
    maxBlockChars: 18_000
  })
}

function largeCodingBudget(modelId: string): ContextBudget {
  return scaledBudget(modelId, {
    maxTurns: 14,
    maxCharsPerTurn: 1000,
    contextShare: 0.14,
    maxBlockChars: 30_000
  })
}

function multimodalBudget(modelId: string): ContextBudget {
  return scaledBudget(modelId, {
    maxTurns: 12,
    maxCharsPerTurn: 900,
    contextShare: 0.08,
    maxBlockChars: 26_000
  })
}

function compactToolBudget(modelId: string): ContextBudget {
  return scaledBudget(modelId, {
    maxTurns: 8,
    maxCharsPerTurn: 560,
    contextShare: 0.08,
    maxBlockChars: 12_000
  })
}

function gptOssBudget(modelId: string): ContextBudget {
  return scaledBudget(modelId, {
    maxTurns: 10,
    maxCharsPerTurn: 800,
    contextShare: 0.12,
    maxBlockChars: 20_000
  })
}

/**
 * Per-family caps for the compact conversation-context block injected on
 * Ollama solo runs. Known large-window local models get a larger memory block;
 * unknown tags stay conservative because their real num_ctx may be tiny.
 */
export function resolveOllamaContextBudget(modelId?: string | null): ContextBudget {
  const trimmedModelId = String(modelId || '').trim()
  const family = resolveOllamaModelFamily(trimmedModelId)
  switch (family) {
    case 'qwen3_4b':
      return qwen4Budget(trimmedModelId)
    case 'qwen3_5_9b':
    case 'ornith_9b':
    case 'lfm2_5_8b':
      return midCodingBudget(trimmedModelId)
    case 'qwen3_6_35b':
    case 'ornith_35b':
    case 'granite4_1_30b':
    case 'nemotron3_33b':
      return largeCodingBudget(trimmedModelId)
    case 'minicpm_v45_8b':
    case 'granite4_1_3b':
      return compactToolBudget(trimmedModelId)
    case 'gemma4_12b':
      return multimodalBudget(trimmedModelId)
    case 'gpt_oss_20b':
      return gptOssBudget(trimmedModelId)
    default:
      return OLLAMA_DEFAULT_BUDGET
  }
}
