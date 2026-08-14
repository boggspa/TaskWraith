import { resolveOllamaModelFamily } from './OllamaModelPreflight'

const RETRIEVAL_FIRST_FAMILIES = new Set([
  'gpt_oss_20b',
  'qwen3_5_9b',
  'qwen3_5_2b',
  'qwen3_5_4b',
  'qwen3_6_35b',
  'qwen3_8_27b',
  'qwen3_4b',
  'minicpm_v45_8b',
  'gemma3_4b',
  'gemma4_12b',
  'ornith_9b',
  'ornith_35b',
  'laguna_xs_2_1',
  'lfm2_5_thinking_1_2b',
  'lfm2_5_8b',
  'granite4_3b',
  'granite4_1_3b',
  'granite4_1_30b',
  'nemotron3_nano_4b',
  'nemotron3_33b',
  'nemotron3_5_lightning_30b',
  'devstral_small_2_24b',
  'ministral_3_3b',
  'ministral_3_14b',
  'llama3_1_8b',
  'deepseek_r1_1_5b',
  'deepseek_r1_8b',
  'rnj_1_8b',
  'glm_4_7_flash',
  'north_mini_code_1_0',
  'muse_glimmer_30b',
  'llama3_2_3b'
])

const EXEMPT_READ_PATHS = new Set([
  'readme.md',
  'readme',
  'license',
  'license.md',
  'changelog.md',
  'package.json',
  'cargo.toml',
  'go.mod'
])

export function ollamaEnforcesRetrievalFirst(modelId?: string | null): boolean {
  return RETRIEVAL_FIRST_FAMILIES.has(resolveOllamaModelFamily(modelId || ''))
}

function basenamePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter(Boolean)
  return (parts[parts.length - 1] || normalized).toLowerCase()
}

export function ollamaReadFileExemptFromRetrievalFirst(pathValue: string): boolean {
  const base = basenamePath(pathValue)
  return EXEMPT_READ_PATHS.has(base)
}

export function ollamaSuggestedSearchQueryForRead(pathValue: string): string {
  const base = basenamePath(pathValue).replace(/\.[^.]+$/, '')
  return base || pathValue
}

export function ollamaRetrievalFirstBlockedMessage(pathValue: string): string {
  const query = ollamaSuggestedSearchQueryForRead(pathValue)
  return [
    'Retrieval-first policy: run workspace_search or list_directory before read_file on unfamiliar paths.',
    `Suggested next step: workspace_search({"query":"${query}","path":".","maxResults":25,"contextLines":1})`,
    'Then read only the highest-ranked file you actually need.'
  ].join(' ')
}
