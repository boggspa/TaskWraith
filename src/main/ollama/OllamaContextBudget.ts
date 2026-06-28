import type { ContextBudget } from '../PromptComposition'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

const OLLAMA_DEFAULT_BUDGET: ContextBudget = {
  maxTurns: 8,
  maxCharsPerTurn: 260,
  maxBlockChars: 3200
}

const OLLAMA_QWEN_4B_BUDGET: ContextBudget = {
  maxTurns: 4,
  maxCharsPerTurn: 180,
  maxBlockChars: 1800
}

const OLLAMA_QWEN_9B_BUDGET: ContextBudget = {
  maxTurns: 6,
  maxCharsPerTurn: 220,
  maxBlockChars: 2600
}

const OLLAMA_LARGE_REASONING_BUDGET: ContextBudget = {
  maxTurns: 8,
  maxCharsPerTurn: 260,
  maxBlockChars: 3600
}

const OLLAMA_GEMMA_BUDGET: ContextBudget = {
  maxTurns: 7,
  maxCharsPerTurn: 240,
  maxBlockChars: 3000
}

const OLLAMA_GPT_OSS_BUDGET: ContextBudget = {
  maxTurns: 6,
  maxCharsPerTurn: 200,
  maxBlockChars: 2400
}

/** Per-family caps for the compact conversation-context block injected on Ollama runs. */
export function resolveOllamaContextBudget(modelId?: string | null): ContextBudget {
  const family = resolveOllamaModelFamily(modelId || '')
  switch (family) {
    case 'qwen3_4b':
      return OLLAMA_QWEN_4B_BUDGET
    case 'qwen3_5_9b':
    case 'ornith_9b':
      return OLLAMA_QWEN_9B_BUDGET
    case 'qwen3_6_35b':
    case 'ornith_35b':
    case 'granite4_1_30b':
    case 'nemotron3_33b':
      return OLLAMA_LARGE_REASONING_BUDGET
    case 'minicpm_v45_8b':
    case 'granite4_1_3b':
      return OLLAMA_DEFAULT_BUDGET
    case 'gemma4_12b':
      return OLLAMA_GEMMA_BUDGET
    case 'gpt_oss_20b':
      return OLLAMA_GPT_OSS_BUDGET
    default:
      return OLLAMA_DEFAULT_BUDGET
  }
}
