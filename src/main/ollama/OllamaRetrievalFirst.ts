import { resolveOllamaModelFamily } from './OllamaModelPreflight'

const RETRIEVAL_FIRST_FAMILIES = new Set([
  'gpt_oss_20b',
  'qwen3_5_9b',
  'qwen3_5_4b',
  'qwen3_6_35b',
  'qwen3_4b',
  'minicpm_v45_8b',
  'gemma4_12b',
  'ornith_9b',
  'ornith_35b',
  'laguna_xs_2_1',
  'lfm2_5_8b',
  'granite4_1_3b',
  'granite4_1_30b',
  'nemotron3_33b',
  'devstral_small_2_24b',
  'ministral_3_14b'
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
