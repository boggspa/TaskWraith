import { matchOllamaBrand } from './ollamaBrandTable'
import { cursorGrokBaseModelId, isGrokReasoningModelId } from './grok45Models'
import { resolvePiModelLabel, resolvePiUpstreamBrand } from './piBrandTable'
import type { TaskWraithControlProviderPresentation } from './taskWraithControlProtocol'

/**
 * ANSI projection of TaskWraith's reviewed provider palette. These values are
 * intentionally pinned to renderer/src/styles/theme.css and iOS Theme.swift;
 * the TUI parity test fails on drift.
 */
export const TASKWRAITH_PROVIDER_ACCENTS = {
  gemini: '#346EEC',
  codex: '#705AFF',
  claude: '#B16105',
  kimi: '#0073E6',
  grok: '#757575',
  cursor: '#8C7508',
  ollama: '#1A8562',
  antigravity: '#308713',
  pi: '#68768C',
  muse: '#1671EA',
  ensemble: '#986781',
  mistral: '#D44404',
  alibaba: '#8C52EF',
  'deep-reinforce': '#BE5809',
  ibm: '#3079BC',
  liquid: '#D72D82',
  nvidia: '#538200',
  openbmb: '#E22B17',
  poolside: '#0C8194',
  meta: '#1671EA',
  cohere: '#5E7C6F',
  essential: '#8462CA',
  deepseek: '#4E6AEE',
  zai: '#177DAA',
  minimax: '#C044A4',
  cerebras: '#BB584A',
  groq: '#088482'
} as const

export const TASKWRAITH_PROVIDER_ACCENT_ALIASES = {
  qwen: 'alibaba',
  google: 'antigravity',
  openai: 'codex',
  ornith: 'deep-reinforce'
} as const

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama',
  antigravity: 'AntiGravity',
  pi: 'Pi',
  muse: 'Muse',
  mistral: 'Mistral',
  ensemble: 'Ensemble',
  meta: 'Meta',
  cohere: 'Cohere',
  essential: 'Essential AI'
}

const PROVIDER_SHORT_CODES: Record<string, string> = {
  gemini: 'GEM',
  codex: 'CDX',
  claude: 'CLA',
  kimi: 'KIM',
  grok: 'GRK',
  cursor: 'CUR',
  ollama: 'OLL',
  antigravity: 'AGY',
  pi: 'PI',
  muse: 'MUS',
  mistral: 'MST',
  ensemble: 'ENS',
  alibaba: 'QWN',
  'deep-reinforce': 'DRF',
  google: 'GGL',
  ibm: 'IBM',
  liquid: 'LQD',
  nvidia: 'NVD',
  openai: 'OAI',
  openbmb: 'BMB',
  poolside: 'PLS',
  meta: 'MTA',
  cohere: 'COH',
  essential: 'EAI',
  deepseek: 'DSK',
  zai: 'ZAI',
  qwen: 'QWN',
  minimax: 'MMX',
  cerebras: 'CBR',
  groq: 'GRQ'
}

type ProviderAccentKey = keyof typeof TASKWRAITH_PROVIDER_ACCENTS
type ProviderAccentAlias = keyof typeof TASKWRAITH_PROVIDER_ACCENT_ALIASES

function canonicalAccentKey(value: string): ProviderAccentKey | null {
  if (value in TASKWRAITH_PROVIDER_ACCENTS) return value as ProviderAccentKey
  if (value in TASKWRAITH_PROVIDER_ACCENT_ALIASES) {
    return TASKWRAITH_PROVIDER_ACCENT_ALIASES[value as ProviderAccentAlias]
  }
  return null
}

const KNOWN_MODEL_LABELS: Record<string, string> = {
  'gpt-5.6-sol': 'GPT-5.6-Sol',
  'gpt-5.6-terra': 'GPT-5.6-Terra',
  'gpt-5.6-luna': 'GPT-5.6-Luna',
  'preview:openai:gpt-5.6:sol': 'GPT-5.6-Sol',
  'preview:openai:gpt-5.6:terra': 'GPT-5.6-Terra',
  'preview:openai:gpt-5.6:luna': 'GPT-5.6-Luna',
  'kimi-k3': 'K3',
  'kimi-k2.7-code': 'K2.7 Coding',
  'kimi-k2.7-code-thinking': 'K2.7 Coding Thinking',
  'grok-4.6': 'Grok 4.6',
  'grok-4.5': 'Grok 4.5',
  'grok-build': 'Grok 4.5 Fast',
  'grok-build-0.1': 'Grok 4.5 Fast',
  'composer-2.5': 'Composer 2.5',
  'composer-2.5-fast': 'Composer 2.5 Fast',
  'mistral-medium-3.5': 'Mistral Medium 3.5',
  'mistral-vibe-cli-latest': 'Mistral Medium 3.5',
  'muse-spark-1.2': 'Muse Spark 1.2',
  'devstral-small': 'Devstral Small',
  'mistral-large-2512': 'Mistral Large 3',
  'zai-glm-5-2': 'GLM-5.2 (via Mistral)',
  'codestral-2508': 'Codestral (Aug 2025)',
  'mistral-small-2603': 'Mistral Small 4',
  'devstral-2512': 'Devstral 2',
  'labs-leanstral-1-5': 'Leanstral 1.5 (Labs)',
  'mistral-medium-latest': 'Mistral Medium (Latest)',
  'mistral-medium-2508': 'Mistral Medium 3.1',
  'mistral-medium-2505': 'Mistral Medium 3',
  'ministral-14b-2512': 'Ministral 3 (14B)',
  'ministral-8b-2512': 'Ministral 3 (8B)',
  'ministral-3b-2512': 'Ministral 3 (3B)'
}

function titleWords(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

function ollamaModelLabel(model: string): string | undefined {
  const key = model.trim().toLowerCase()
  const known: Array<[RegExp, string]> = [
    [/^qwen3\.8:27b-mlx(?:-|$)/, 'Qwen 3.8 (27B-MLX)'],
    [/^qwen3\.6:35b(?:-|$)/, 'Qwen 3.6 (35B-A3B)'],
    [/^qwen3\.5:9b(?:-|$)/, 'Qwen 3.5 (9B Param)'],
    [/^qwen3\.5:4b(?:-|$)/, 'Qwen 3.5 (4B Param)'],
    [/^qwen3\.5:2b(?:-|$)/, 'Qwen 3.5 (2B Param)'],
    [/^qwen3(?::4b)?(?:-|$)/, 'Qwen 3 (4B Param)'],
    [/^gemma3:4b(?:-|$)/, 'Gemma 3 (4B Param)'],
    [/^gemma4:12b(?:-|$)/, 'Gemma 4 (12B Param)'],
    [/^ornith(?::(?:latest|9b))?(?:-|$)/, 'Ornith 1.0 (9B Param)'],
    [/^ornith:35b(?:-|$)/, 'Ornith 1.0 (35B Param)'],
    [/^lfm2\.5-thinking:1\.2b(?:-|$)/, 'LFM 2.5 Thinking (1.2B Param)'],
    [/^lfm2\.5(?::(?:latest|8b))?(?:-|$)/, 'LFM 2.5 (8B-A1B)'],
    [/^(?:gpt-oss(?::(?:latest|20b))?|openai\/gpt-oss-20b)$/, 'GPT OSS (20B Param)'],
    [/^minicpm-v4\.5:8b(?:-|$)/, 'MiniCPM-V 4.5 (8B Param)'],
    [/^granite4\.1:3b(?:-|$)/, 'Granite 4.1 (3B Param)'],
    [/^granite4\.1:30b(?:-|$)/, 'Granite 4.1 (30B Param)'],
    [/^granite4:3b(?:-|$)/, 'Granite 4.0 (3B Param)'],
    [/^nemotron-3-nano:4b(?:-|$)/, 'Nemotron 3 Nano (4B Param)'],
    [/^nemotron3:33b(?:-|$)/, 'Nemotron 3 Nano Omni (33B Param)'],
    [/^nemotron-3\.5-lightning:30b-mlx(?:-|$)/, 'Nemotron 3.5 Lightning (30B-MLX)'],
    [/^laguna-xs-2\.1:q8_0$/, 'Laguna XS 2.1 (33B-A3B Q8)'],
    [/^devstral-small-2:24b(?:-|$)/, 'Devstral Small 2 (24B Param)'],
    [/^ministral-3:3b(?:-|$)/, 'Ministral 3 (3B Param)'],
    [/^ministral-3:14b(?:-|$)/, 'Ministral 3 (14B Param)'],
    [/^muse-glimmer:30b-mlx(?:-|$)/, 'Muse Glimmer (30B-MLX)'],
    [/^llama3\.1:8b(?:-|$)/, 'Llama 3.1 (8B Param)'],
    [/^deepseek-r1:1\.5b(?:-|$)/, 'DeepSeek R1 (1.5B Param)'],
    [/^deepseek-r1:8b(?:-|$)/, 'DeepSeek R1 (8B Param)'],
    [/^rnj-1(?::(?:latest|8b))?(?:-|$)/, 'Rnj-1 (8B Param)'],
    [/^glm-4\.7-flash:q4_k_m(?:-|$)/, 'GLM-4.7-Flash (30B-A3B Q4)'],
    [/^north-mini-code-1\.0:q4_k_m(?:-|$)/, 'North Mini Code 1.0 (30B-A3B Q4)'],
    [/^llama3\.2:3b(?:-|$)/, 'Llama 3.2 (3B Param)']
  ]
  return known.find(([pattern]) => pattern.test(key))?.[1]
}

export function taskWraithModelLabel(
  provider: string,
  model: string | null | undefined
): string | undefined {
  const raw = String(model || '').trim()
  if (!raw) return undefined
  const runtimeProvider = String(provider || '')
    .trim()
    .toLowerCase()
  if (runtimeProvider === 'pi') return resolvePiModelLabel(raw) || raw
  if (runtimeProvider === 'ollama') return ollamaModelLabel(raw) || raw
  const key = raw.toLowerCase()
  if (runtimeProvider === 'cursor') {
    const base = cursorGrokBaseModelId(key)
    if (base) return base === 'grok-4.6' ? 'Grok 4.6' : 'Grok 4.5'
  }
  if (runtimeProvider === 'grok' && isGrokReasoningModelId(key)) {
    return key === 'grok-4.6' ? 'Grok 4.6 Fast' : 'Grok 4.5 Fast'
  }
  if (KNOWN_MODEL_LABELS[key]) return KNOWN_MODEL_LABELS[key]
  const claude = key
    .replace(/^preview:anthropic:/, '')
    .match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(-1m)?$/)
  if (claude) {
    return `${titleWords(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}${
      claude[4] ? ' 1M' : ''
    }`
  }
  if (/^gpt-\d/.test(key)) {
    const [version, ...suffix] = key.slice(4).split('-')
    return `GPT-${version}${suffix.length ? ` ${titleWords(suffix.join('-'))}` : ''}`
  }
  if (/^kimi-k/i.test(raw)) {
    return raw
      .replace(/^kimi-/i, '')
      .replace(/^k/i, 'K')
      .replace(/-code$/i, ' Coding')
  }
  if (/^gemini-/i.test(raw)) return titleWords(raw)
  return raw
}

export function taskWraithProviderAccent(hueKey: string): string {
  const key = canonicalAccentKey(hueKey)
  return key ? TASKWRAITH_PROVIDER_ACCENTS[key] : TASKWRAITH_PROVIDER_ACCENTS.ensemble
}

export function taskWraithProviderLabel(provider: string): string {
  const id = String(provider || '')
    .trim()
    .toLowerCase()
  return PROVIDER_LABELS[id] ?? (id ? id[0].toUpperCase() + id.slice(1) : 'TaskWraith')
}

export function taskWraithProviderShortCode(provider: string, displayLabel?: string): string {
  const id = String(provider || '')
    .trim()
    .toLowerCase()
  if (PROVIDER_SHORT_CODES[id]) return PROVIDER_SHORT_CODES[id]
  const letters = String(displayLabel || provider)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
  return (letters.slice(0, 3) || 'TW').padEnd(3, 'W')
}

export function resolveTaskWraithProviderPresentation(
  provider: string | null | undefined,
  model?: string | null,
  modelLabel?: string | null
): TaskWraithControlProviderPresentation {
  const runtimeProvider = String(provider || 'ensemble')
    .trim()
    .toLowerCase()
  const rawModel = String(model || '').trim()
  const rawModelLabel = String(modelLabel || '').trim()
  let hueKey = runtimeProvider
  let displayProvider = taskWraithProviderLabel(runtimeProvider)
  let resolvedModelLabel = rawModelLabel || taskWraithModelLabel(runtimeProvider, rawModel)

  if (runtimeProvider === 'ollama') {
    const brand = matchOllamaBrand(rawModel, rawModelLabel)
    if (brand) {
      hueKey = brand.providerClass
      displayProvider = brand.providerLabel
      resolvedModelLabel =
        rawModelLabel || taskWraithModelLabel(runtimeProvider, rawModel) || brand.fallbackModelLabel
    }
  } else if (runtimeProvider === 'pi') {
    const brand = resolvePiUpstreamBrand(rawModel)
    if (brand) {
      hueKey = brand.hueClass
      displayProvider = brand.label
      resolvedModelLabel = rawModelLabel || resolvePiModelLabel(rawModel) || rawModel || undefined
    }
  }

  return {
    runtimeProvider,
    displayProvider,
    hueKey,
    accent: taskWraithProviderAccent(hueKey),
    ...(rawModel ? { model: rawModel } : {}),
    ...(resolvedModelLabel ? { modelLabel: resolvedModelLabel } : {}),
    shortCode: taskWraithProviderShortCode(hueKey, displayProvider)
  }
}
