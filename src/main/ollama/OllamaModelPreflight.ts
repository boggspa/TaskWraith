import type { OllamaModelInfo } from './OllamaProvider'
import type { ProviderCapabilityWarning } from '../store/types'

export type OllamaModelFamily =
  | 'qwen3_4b'
  | 'qwen3_5_2b'
  | 'qwen3_5_4b'
  | 'qwen3_5_9b'
  | 'qwen3_6_35b'
  | 'qwen3_8_27b'
  | 'gemma3_4b'
  | 'gemma4_12b'
  | 'ornith_9b'
  | 'ornith_35b'
  | 'laguna_xs_2_1'
  | 'gpt_oss_20b'
  | 'lfm2_5_thinking_1_2b'
  | 'lfm2_5_8b'
  | 'minicpm_v45_8b'
  | 'granite4_3b'
  | 'granite4_1_3b'
  | 'granite4_1_30b'
  | 'nemotron3_nano_4b'
  | 'nemotron3_33b'
  | 'nemotron3_5_lightning_30b'
  | 'devstral_small_2_24b'
  | 'ministral_3_3b'
  | 'ministral_3_14b'
  | 'muse_glimmer_30b'
  | 'llama3_1_8b'
  | 'deepseek_r1_1_5b'
  | 'deepseek_r1_8b'
  | 'rnj_1_8b'
  | 'glm_4_7_flash'
  | 'north_mini_code_1_0'
  | 'llama3_2_3b'
  | 'unknown'

export interface OllamaModelPreflightInput {
  modelId: string
  modelLabel: string
  /** Resolved model metadata from /api/tags when the requested id is installed. */
  modelInfo?: OllamaModelInfo | null
  installedModelIds: string[]
  totalMemoryBytes: number
}

export interface OllamaModelPreflightCheck {
  id: string
  ok: boolean
  detail: string
}

export interface OllamaModelPreflightResult {
  family: OllamaModelFamily
  checks: OllamaModelPreflightCheck[]
  guidance: string
  delegateHint?: string
  warnings: ProviderCapabilityWarning[]
}

function warning(
  id: string,
  severity: ProviderCapabilityWarning['severity'],
  title: string,
  message: string
): ProviderCapabilityWarning {
  return { id, severity, title, message }
}

function metadataText(modelInfo?: OllamaModelInfo | null): string {
  return [
    modelInfo?.family,
    modelInfo?.parameterSize,
    ...(Array.isArray(modelInfo?.families) ? modelInfo.families : []),
    modelInfo?.show?.details?.family,
    modelInfo?.show?.details?.parameter_size,
    ...(Array.isArray(modelInfo?.show?.details?.families) ? modelInfo.show.details.families : []),
    ...Object.entries(modelInfo?.show?.model_info || {})
      .filter(([key]) => /(?:architecture|basename)$/i.test(key))
      .map(([, value]) => String(value))
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** Normalize a pulled Ollama tag to a stable family key. */
export function resolveOllamaModelFamily(
  modelId: string,
  modelInfo?: OllamaModelInfo | null
): OllamaModelFamily {
  const key = modelId.trim().toLowerCase()
  if (key === 'llama3.1:8b' || key.startsWith('llama3.1:8b-')) return 'llama3_1_8b'
  if (key === 'deepseek-r1:1.5b' || key.startsWith('deepseek-r1:1.5b-')) {
    return 'deepseek_r1_1_5b'
  }
  if (key === 'deepseek-r1:8b' || key.startsWith('deepseek-r1:8b-')) return 'deepseek_r1_8b'
  if (key === 'rnj-1' || key === 'rnj-1:latest' || key === 'rnj-1:8b') return 'rnj_1_8b'
  if (key === 'glm-4.7-flash:q4_k_m' || key.startsWith('glm-4.7-flash:q4_k_m-')) {
    return 'glm_4_7_flash'
  }
  if (
    key === 'north-mini-code-1.0:q4_k_m' ||
    key.startsWith('north-mini-code-1.0:q4_k_m-')
  ) {
    return 'north_mini_code_1_0'
  }
  if (key === 'llama3.2:3b' || key.startsWith('llama3.2:3b-')) return 'llama3_2_3b'
  if (key === 'qwen3.8:27b-mlx' || key.startsWith('qwen3.8:27b-mlx-')) return 'qwen3_8_27b'
  if (key === 'qwen3.6:35b' || key.startsWith('qwen3.6:35b-')) return 'qwen3_6_35b'
  if (key === 'minicpm-v4.5:8b' || key.startsWith('minicpm-v4.5:8b-')) return 'minicpm_v45_8b'
  if (key === 'granite4:3b' || key.startsWith('granite4:3b-')) return 'granite4_3b'
  if (key === 'granite4.1:3b' || key.startsWith('granite4.1:3b-')) return 'granite4_1_3b'
  if (key === 'granite4.1:30b' || key.startsWith('granite4.1:30b-')) return 'granite4_1_30b'
  if (key === 'nemotron-3-nano:4b' || key.startsWith('nemotron-3-nano:4b-')) {
    return 'nemotron3_nano_4b'
  }
  if (key === 'nemotron3:33b' || key.startsWith('nemotron3:33b-')) return 'nemotron3_33b'
  if (
    key === 'nemotron-3.5-lightning:30b-mlx' ||
    key.startsWith('nemotron-3.5-lightning:30b-mlx-')
  ) {
    return 'nemotron3_5_lightning_30b'
  }
  if (key === 'qwen3:4b-instruct' || key.startsWith('qwen3:4b')) return 'qwen3_4b'
  // The dense 3.5 sizes must be matched BEFORE the bare `qwen3` metadata
  // fallbacks below; their order is cosmetic because the tags do not overlap.
  if (key === 'qwen3.5:2b' || key.startsWith('qwen3.5:2b')) return 'qwen3_5_2b'
  if (key === 'qwen3.5:4b' || key.startsWith('qwen3.5:4b')) return 'qwen3_5_4b'
  if (key === 'qwen3.5:9b' || key.startsWith('qwen3.5:9b')) return 'qwen3_5_9b'
  if (key === 'devstral-small-2:24b' || key.startsWith('devstral-small-2:24b-')) {
    return 'devstral_small_2_24b'
  }
  if (key === 'ministral-3:3b' || key.startsWith('ministral-3:3b-')) return 'ministral_3_3b'
  if (key === 'ministral-3:14b' || key.startsWith('ministral-3:14b-')) return 'ministral_3_14b'
  if (
    key === 'muse-glimmer' ||
    key === 'muse-glimmer:latest' ||
    key === 'muse-glimmer:30b-mlx' ||
    key.startsWith('muse-glimmer:30b-mlx-')
  ) {
    return 'muse_glimmer_30b'
  }
  if (
    key === 'gemma3' ||
    key === 'gemma3:latest' ||
    key === 'gemma3:4b' ||
    key.startsWith('gemma3:4b')
  ) {
    return 'gemma3_4b'
  }
  if (key === 'gemma4:12b' || key.startsWith('gemma4:12b')) return 'gemma4_12b'
  if (
    key === 'ornith' ||
    key === 'ornith:latest' ||
    key === 'ornith:9b' ||
    key.startsWith('ornith:9b-')
  ) {
    return 'ornith_9b'
  }
  if (key === 'ornith:35b' || key.startsWith('ornith:35b-')) return 'ornith_35b'
  if (key === 'laguna-xs-2.1:q8_0') return 'laguna_xs_2_1'
  if (
    key === 'gpt-oss' ||
    key === 'gpt-oss:20b' ||
    key === 'gpt-oss:latest' ||
    key.startsWith('gpt-oss') ||
    key === 'openai/gpt-oss-20b'
  ) {
    return 'gpt_oss_20b'
  }
  if (
    key === 'lfm2.5-thinking' ||
    key === 'lfm2.5-thinking:latest' ||
    key === 'lfm2.5-thinking:1.2b' ||
    key.startsWith('lfm2.5-thinking:1.2b-')
  ) {
    return 'lfm2_5_thinking_1_2b'
  }
  if (
    key === 'lfm2.5' ||
    key === 'lfm2.5:latest' ||
    key === 'lfm2.5:8b' ||
    key.startsWith('lfm2.5:8b-')
  ) {
    return 'lfm2_5_8b'
  }
  const meta = metadataText(modelInfo)
  if (meta.includes('deepseek-r1') || meta.includes('deepseek r1')) {
    const billions = parseOllamaParameterBillions(modelInfo?.parameterSize)
    return billions != null && billions < 4 ? 'deepseek_r1_1_5b' : 'deepseek_r1_8b'
  }
  if (meta.includes('rnj-1') || meta.includes('rnj 1')) return 'rnj_1_8b'
  if (meta.includes('glm4moelite') || meta.includes('glm-4.7-flash')) return 'glm_4_7_flash'
  if (meta.includes('cohere2moe') || meta.includes('north mini code')) {
    return 'north_mini_code_1_0'
  }
  if (meta.includes('meta-llama-3.1') || meta.includes('llama-3.1')) return 'llama3_1_8b'
  if (meta.includes('llama-3.2')) return 'llama3_2_3b'
  if (meta.includes('gptoss') || meta.includes('gpt-oss')) {
    return 'gpt_oss_20b'
  }
  if (meta.includes('lfm2.5') || meta.includes('lfm 2.5') || meta.includes('lfm2')) {
    return meta.includes('thinking') ? 'lfm2_5_thinking_1_2b' : 'lfm2_5_8b'
  }
  if (meta.includes('ornith') && meta.includes('35b')) return 'ornith_35b'
  if (meta.includes('ornith') && meta.includes('9b')) return 'ornith_9b'
  if (meta.includes('ornith')) return 'ornith_9b'
  if (meta.includes('laguna') || meta.includes('poolside')) return 'laguna_xs_2_1'
  // Live daemon (2026-07-30) reports `family: 'mistral3'` for BOTH local
  // Mistral tags, so the architecture alone cannot pick the family — split on
  // parameter size. An explicit brand word only appears when a custom tag
  // names it in its own metadata.
  if (meta.includes('mistral3') || meta.includes('devstral') || meta.includes('ministral')) {
    if (meta.includes('devstral')) return 'devstral_small_2_24b'
    const billions = parseOllamaParameterBillions(modelInfo?.parameterSize)
    if (meta.includes('ministral') && billions != null && billions < 6) return 'ministral_3_3b'
    if (meta.includes('ministral')) return 'ministral_3_14b'
    if (billions != null && billions < 6) return 'ministral_3_3b'
    return billions != null && billions < 20 ? 'ministral_3_14b' : 'devstral_small_2_24b'
  }
  if (
    meta.includes('museglimmer') ||
    meta.includes('muse glimmer') ||
    meta.includes('muse_glimmer')
  ) {
    return 'muse_glimmer_30b'
  }
  if (meta.includes('qwen3.8') || meta.includes('qwen38')) return 'qwen3_8_27b'
  if (meta.includes('qwen35moe') || meta.includes('qwen3.6')) return 'qwen3_6_35b'
  // `qwen35` covers all three dense 3.5 sizes (the 35B MoE tags report
  // `qwen35moe` and are caught above), so the family splits on parameter size.
  // Without this arm the generic `qwen3` fallbacks below sent every 3.5 tag to
  // the 4B profile — including the 9B, whose "9.7B" never matched its `9b` needle.
  if (meta.includes('qwen35') || meta.includes('qwen3.5')) {
    const billions = parseOllamaParameterBillions(modelInfo?.parameterSize)
    if (billions != null && billions < 3) return 'qwen3_5_2b'
    return billions != null && billions < 7 ? 'qwen3_5_4b' : 'qwen3_5_9b'
  }
  if (
    meta.includes('nemotron-3.5-lightning') ||
    meta.includes('nemotron 3.5 lightning') ||
    meta.includes('nemotron3.5lightning') ||
    meta.includes('nemotron_3_5_lightning')
  ) {
    return 'nemotron3_5_lightning_30b'
  }
  if (meta.includes('nemotron')) {
    const billions = parseOllamaParameterBillions(modelInfo?.parameterSize)
    return billions != null && billions < 10 ? 'nemotron3_nano_4b' : 'nemotron3_33b'
  }
  if (meta.includes('granite') && (meta.includes('3.4b') || meta.includes('3b'))) {
    return 'granite4_1_3b'
  }
  if (meta.includes('granite')) return 'granite4_1_30b'
  if (meta.includes('qwen3') && meta.includes('9b')) return 'qwen3_5_9b'
  if (meta.includes('qwen3')) return 'qwen3_4b'
  if (meta.includes('gemma3')) return 'gemma3_4b'
  if (meta.includes('gemma')) return 'gemma4_12b'
  return 'unknown'
}

export function ollamaModelIdAliases(modelId: string): string[] {
  const target = modelId.trim()
  if (!target) return []
  const lower = target.toLowerCase()
  const aliases = new Set<string>([lower])
  if (lower === 'gpt-oss' || lower === 'gpt-oss:20b' || lower === 'gpt-oss:latest') {
    aliases.add('gpt-oss')
    aliases.add('gpt-oss:20b')
    aliases.add('gpt-oss:latest')
    aliases.add('openai/gpt-oss-20b')
  }
  if (lower === 'ornith' || lower === 'ornith:latest' || lower === 'ornith:9b') {
    aliases.add('ornith')
    aliases.add('ornith:latest')
    aliases.add('ornith:9b')
  }
  if (lower === 'gemma3' || lower === 'gemma3:latest' || lower === 'gemma3:4b') {
    aliases.add('gemma3')
    aliases.add('gemma3:latest')
    aliases.add('gemma3:4b')
  }
  if (
    lower === 'lfm2.5-thinking' ||
    lower === 'lfm2.5-thinking:latest' ||
    lower === 'lfm2.5-thinking:1.2b'
  ) {
    aliases.add('lfm2.5-thinking')
    aliases.add('lfm2.5-thinking:latest')
    aliases.add('lfm2.5-thinking:1.2b')
  }
  if (lower === 'lfm2.5' || lower === 'lfm2.5:latest' || lower === 'lfm2.5:8b') {
    aliases.add('lfm2.5')
    aliases.add('lfm2.5:latest')
    aliases.add('lfm2.5:8b')
  }
  if (lower === 'rnj-1' || lower === 'rnj-1:latest' || lower === 'rnj-1:8b') {
    aliases.add('rnj-1')
    aliases.add('rnj-1:latest')
    aliases.add('rnj-1:8b')
  }
  return [...aliases]
}

export function parseOllamaParameterBillions(parameterSize?: string | null): number | null {
  const raw = String(parameterSize || '').trim()
  if (!raw) return null
  const match = raw.match(/([\d.]+)\s*B/i)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Rough resident-RAM estimate for a loaded quantised weights file (GB). */
export function estimateOllamaModelRamGb(input: {
  parameterBillions?: number | null
  quantizationLevel?: string | null
  sizeBytes?: number | null
}): number | null {
  if (typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes) && input.sizeBytes > 0) {
    return Math.round((input.sizeBytes / 1_000_000_000) * 1.25 * 10) / 10
  }
  const params = input.parameterBillions
  if (params == null) return null
  const quant = String(input.quantizationLevel || '').toUpperCase()
  const bytesPerParam = quant.includes('MXFP4') || quant.includes('NVFP4')
    ? 0.53125
    : quant.includes('Q8')
      ? 1.0
      : quant.includes('Q6')
        ? 0.75
        : 0.62
  // Add ~25% headroom for runtime/KV overhead on first load.
  return Math.round(params * bytesPerParam * 1.25 * 10) / 10
}

export function formatMemoryGb(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}

function modelInstalled(modelId: string, installedModelIds: string[]): boolean {
  const aliases = new Set(ollamaModelIdAliases(modelId))
  return installedModelIds.some((id) => aliases.has(id.trim().toLowerCase()))
}

function modelSupportsNativeTools(modelInfo?: OllamaModelInfo | null): boolean | null {
  if (!modelInfo?.capabilities?.length) return null
  return modelInfo.capabilities.some((cap) => cap.toLowerCase() === 'tools')
}

function familyGuidance(family: OllamaModelFamily, modelLabel: string): {
  guidance: string
  delegateHint?: string
} {
  switch (family) {
    case 'qwen3_5_9b':
      return {
        guidance: `${modelLabel} is a capable local workspace model for scoped tasks — search, read files, and focused edits with approval.`,
        delegateHint:
          'For multi-file refactors, broad test-suite fixes, or long autonomous loops, confirm the needed Ollama tier, context, and verification path before continuing.'
      }
    case 'qwen3_6_35b':
      return {
        guidance: `${modelLabel} is a strong local reasoning model with a large context window and native tool support.`,
        delegateHint:
          'For long implementation loops or release-critical edits, pair the run with an explicit verification pass before landing broad changes.'
      }
    case 'qwen3_8_27b':
      return {
        guidance: `${modelLabel} is a multimodal long-context agent model with native tools and configurable thinking.`,
        delegateHint:
          'Use it for scoped tool-driven work, preserve supplied thinking across turns, and close release-sensitive changes with explicit verification. This registry build requires Ollama 0.32.12 or newer.'
      }
    case 'qwen3_4b':
      return {
        guidance: `${modelLabel} is best for quick lookups, narrow reads, and short answers.`,
        delegateHint:
          'For edits, shell work, or multi-step refactors, choose an edit-capable Ollama tier and a model/profile sized for the scope.'
      }
    case 'qwen3_5_2b':
      return {
        guidance: `${modelLabel} is a very small long-context local model for chat, quick lookups, and tightly scoped reads.`,
        delegateHint:
          'Keep workspace work to one small step at a time; hand off a concise plan when the task becomes multi-file or verification-heavy.'
      }
    case 'qwen3_5_4b':
      return {
        guidance: `${modelLabel} is a small long-context local model — good for quick lookups, targeted reads, and short focused patches.`,
        delegateHint:
          'Keep the scope narrow; for multi-file refactors or long test-fix loops, hand off a short plan rather than looping locally.'
      }
    case 'minicpm_v45_8b':
      return {
        guidance: `${modelLabel} is a compact multimodal local model with tools and thinking support.`,
        delegateHint:
          'Use it for scoped reads, visual/local checks, and quick analysis; for broad code edits, confirm the coding model/profile or split the work into clear local slices.'
      }
    case 'gemma3_4b':
      return {
        guidance: `${modelLabel} is a lightweight multimodal local model for chat, image understanding, and focused analysis.`,
        delegateHint:
          'Use it for bounded tasks; split broad code changes into small verified slices or use a coding-tuned local model.'
      }
    case 'gemma4_12b':
      return {
        guidance: `${modelLabel} handles moderate local tasks well — exploration, planning, and focused edits.`,
        delegateHint:
          'For large refactors or repo-wide test fixes, confirm the required edit and shell permissions before starting the implementation pass.'
      }
    case 'ornith_9b':
      return {
        guidance: `${modelLabel} is an agentic-coding local model; keep tasks scoped, search first, and verify generated edits carefully.`,
        delegateHint:
          'Use it for local planning and focused patches; for broad refactors or long test-fix loops, claim explicit scope or pick a wider-context local profile.'
      }
    case 'ornith_35b':
      return {
        guidance: `${modelLabel} is a larger agentic-coding local model with a broad context window for deeper repo review and focused implementation.`,
        delegateHint:
          'For release-critical changes, pair it with an explicit verification pass before landing broad edits.'
      }
    case 'lfm2_5_thinking_1_2b':
      return {
        guidance: `${modelLabel} is an ultra-light reasoning model for private local chat and short tool-assisted tasks.`,
        delegateHint:
          'Keep prompts and tool results compact; stop with a concise handoff when the task grows beyond one focused slice.'
      }
    case 'lfm2_5_8b':
      return {
        guidance: `${modelLabel} is a compact local model with a long context window and tool-chaining training.`,
        delegateHint:
          'Use it for scoped local analysis, tool-assisted review, and focused patches; keep broad refactors sliced with explicit verification.'
      }
    case 'laguna_xs_2_1':
      return {
        guidance: `${modelLabel} is a long-context local reasoning model with native tools and thinking support.`,
        delegateHint:
          'Use it for deeper local review and scoped implementation; on macOS/Metal, watch for empty chat responses from this tag and verify the first run before long work.'
      }
    case 'granite4_3b':
      return {
        guidance: `${modelLabel} is a lightweight tool-capable local model for chat, retrieval, and small structured tasks.`,
        delegateHint:
          'Use it for fast reads and bounded actions; avoid long autonomous edit-and-test loops.'
      }
    case 'granite4_1_3b':
      return {
        guidance: `${modelLabel} is a lightweight tool-capable local model for fast reads and small planning tasks.`,
        delegateHint:
          'For edits, shell verification, or long reasoning chains, choose an edit-capable tier and a larger local tag when the scope needs it.'
      }
    case 'granite4_1_30b':
      return {
        guidance: `${modelLabel} is a larger tool-capable local model suited to deeper local review and planning.`,
        delegateHint:
          'For release-critical patches, use it as a local reviewer or pair it with a separate verification pass.'
      }
    case 'nemotron3_nano_4b':
      return {
        guidance: `${modelLabel} is a small local reasoning model with native tools and configurable thinking.`,
        delegateHint:
          'Keep tool calls narrow and verification explicit; slice multi-file implementation into separate passes.'
      }
    case 'nemotron3_33b':
      return {
        guidance: `${modelLabel} is a multimodal local reasoning model with native tools and thinking support.`,
        delegateHint:
          'Use it for deep local analysis and visual checks; pair broad multi-file implementation with an explicit verification plan when latency or reliability matters.'
      }
    case 'nemotron3_5_lightning_30b':
      return {
        guidance: `${modelLabel} is NVIDIA's 30B-A3B mixture-of-experts model for always-on agents, with native tools, thinking support, and a 262K context window.`,
        delegateHint:
          'Use it for sustained tool-driven workflows, checkpoint durable state between long steps, and close release-sensitive work with explicit verification.'
      }
    case 'devstral_small_2_24b':
      return {
        guidance: `${modelLabel} is an agentic-coding local model built for tool-driven workspace edits.`,
        delegateHint:
          'Use it for scoped implementation: search, read the exact target, patch, then state what you verified. Slice broad refactors rather than running them in one pass.'
      }
    case 'ministral_3_3b':
      return {
        guidance: `${modelLabel} is an edge-sized multimodal model with native tools for fast chat, reads, and small actions.`,
        delegateHint:
          'Use it as a lightweight local scout or patcher; keep changes localized and verification short.'
      }
    case 'ministral_3_14b':
      return {
        guidance: `${modelLabel} is a compact tool-capable local model for fast reads, planning, and small focused edits.`,
        delegateHint:
          'Use it as a local scout or patcher; for release-critical or multi-file work, pair it with a larger local tag or an explicit verification pass.'
      }
    case 'muse_glimmer_30b':
      return {
        guidance: `${modelLabel} is Meta's 30B multimodal agentic model with native tools, thinking support, failure recovery, and a 131K context window.`,
        delegateHint:
          'Use its long-horizon profile for scoped implementation, keep tool schemas precise, and finish release-sensitive work with an explicit verification pass.'
      }
    case 'llama3_1_8b':
      return {
        guidance: `${modelLabel} is a tool-capable general local model with a 131K context window.`,
        delegateHint:
          'Use it for scoped local exploration, planning, and focused edits; keep broad repository changes split into verified slices.'
      }
    case 'deepseek_r1_1_5b':
      return {
        guidance: `${modelLabel} is a tiny distilled reasoning model for private local chat and short, concrete tool steps.`,
        delegateHint:
          'Keep context and tool output compact; use a larger local model when the task needs reliable multi-file execution.'
      }
    case 'deepseek_r1_8b':
      return {
        guidance: `${modelLabel} is a compact reasoning model with native tools and thinking support.`,
        delegateHint:
          'Keep tool payloads focused and preserve the model reasoning channel between turns when the runtime supplies it.'
      }
    case 'rnj_1_8b':
      return {
        guidance: `${modelLabel} is an Essential AI agentic-coding model with native tools and a 32K context window; it requires Ollama 0.13.3 or newer.`,
        delegateHint:
          'Use it for scoped implementation and verification; keep context compact and split broad refactors into explicit slices.'
      }
    case 'glm_4_7_flash':
      return {
        guidance: `${modelLabel} is a 30B-A3B reasoning model with native tools, thinking support, and a 202,752-token window; this registry build requires Ollama 0.15.0 or newer.`,
        delegateHint:
          'Use it for deep local review and scoped implementation, with an explicit verification pass before release-sensitive edits.'
      }
    case 'north_mini_code_1_0':
      return {
        guidance: `${modelLabel} is Cohere's 30B-A3B agentic software-engineering model with native tools, thinking support, and a 500,000-token runtime window; this registry build requires Ollama 0.30.10 or newer.`,
        delegateHint:
          'Carry thinking content between turns when supplied, search before reading, and keep each tool action tied to the current implementation step.'
      }
    case 'llama3_2_3b':
      return {
        guidance: `${modelLabel} is a lightweight tool-capable local model with a 131K context window.`,
        delegateHint:
          'Use it for quick lookups, targeted reads, and small focused patches; hand off a concise plan when the task becomes broad.'
      }
    case 'gpt_oss_20b':
      return {
        guidance: `${modelLabel} has stronger reasoning but can be finicky with tool calls; TaskWraith will nudge it when it stalls.`,
        delegateHint:
          'For heavy multi-file implementation, confirm the tool tier and consider a separate reviewer or worker when parallel verification would reduce risk.'
      }
    default:
      return {
        guidance: `${modelLabel} is a local model. Match the selected tier, context window, and installed capabilities to the requested task.`,
        delegateHint:
          'For ambitious refactors or long tool chains, make the scope and verification path explicit before starting.'
      }
  }
}

function defaultParameterBillionsForFamily(family: OllamaModelFamily): number | null {
  switch (family) {
    case 'qwen3_4b':
    case 'qwen3_5_2b':
    case 'qwen3_5_4b':
      return family === 'qwen3_5_2b' ? 2 : 4
    case 'qwen3_5_9b':
      return 9
    case 'qwen3_6_35b':
      return 36
    case 'qwen3_8_27b':
      return 27
    case 'minicpm_v45_8b':
      return 8
    case 'gemma3_4b':
      return 4
    case 'gemma4_12b':
      return 12
    case 'ornith_9b':
      return 9
    case 'ornith_35b':
      return 35
    case 'laguna_xs_2_1':
      return 33
    case 'lfm2_5_thinking_1_2b':
      return 1.2
    case 'lfm2_5_8b':
      return 8
    case 'granite4_3b':
      return 3
    case 'granite4_1_3b':
      return 3
    case 'granite4_1_30b':
      return 30
    case 'nemotron3_nano_4b':
      return 4
    case 'nemotron3_33b':
      return 33
    case 'nemotron3_5_lightning_30b':
      return 30
    case 'devstral_small_2_24b':
      return 24
    case 'ministral_3_3b':
      return 3
    case 'ministral_3_14b':
      return 14
    case 'muse_glimmer_30b':
      return 30
    case 'deepseek_r1_1_5b':
      return 1.5
    case 'llama3_1_8b':
    case 'deepseek_r1_8b':
    case 'rnj_1_8b':
      return 8
    case 'glm_4_7_flash':
    case 'north_mini_code_1_0':
      return 30
    case 'llama3_2_3b':
      return 3
    case 'gpt_oss_20b':
      return 20
    default:
      return null
  }
}

/** Honest per-model capability preflight for the first Ollama run of each tag. */
export function evaluateOllamaModelPreflight(
  input: OllamaModelPreflightInput
): OllamaModelPreflightResult {
  const family = resolveOllamaModelFamily(input.modelId, input.modelInfo)
  const { guidance, delegateHint } = familyGuidance(family, input.modelLabel)
  const checks: OllamaModelPreflightCheck[] = []
  const warnings: ProviderCapabilityWarning[] = []

  const installed = modelInstalled(input.modelId, input.installedModelIds)
  checks.push({
    id: 'installed',
    ok: installed,
    detail: installed
      ? 'Model tag is present in the local Ollama library.'
      : 'Model tag was not found in /api/tags — run `ollama pull` before expecting reliable runs.'
  })
  if (!installed) {
    warnings.push(
      warning(
        'ollama-model-missing',
        'error',
        'Model not installed',
        `Pull ${input.modelId} with \`ollama pull ${input.modelId}\`, then refresh models.`
      )
    )
  }

  const paramB =
    parseOllamaParameterBillions(input.modelInfo?.parameterSize) ??
    defaultParameterBillionsForFamily(family)
  const estimatedRamGb = estimateOllamaModelRamGb({
    parameterBillions: paramB,
    quantizationLevel: input.modelInfo?.quantizationLevel,
    sizeBytes: input.modelInfo?.sizeBytes
  })
  const usableRamBytes = Math.floor(input.totalMemoryBytes * 0.55)
  const ramOk =
    estimatedRamGb == null ? true : estimatedRamGb <= usableRamBytes / 1024 ** 3 + 0.5
  checks.push({
    id: 'ram',
    ok: ramOk,
    detail:
      estimatedRamGb == null
        ? 'RAM headroom could not be estimated from model metadata.'
        : ramOk
          ? `Estimated load ~${estimatedRamGb} GB fits within ~${formatMemoryGb(usableRamBytes)} usable RAM.`
          : `Estimated load ~${estimatedRamGb} GB may exceed ~${formatMemoryGb(usableRamBytes)} usable RAM on this Mac — expect swapping or failed loads.`
  })
  if (!ramOk && estimatedRamGb != null) {
    warnings.push(
      warning(
        'ollama-ram-tight',
        'warning',
        'RAM may be tight',
        `This model may need ~${estimatedRamGb} GB resident while loaded. Close other heavy apps or pick a smaller quant/model.`
      )
    )
  }

  const nativeTools = modelSupportsNativeTools(input.modelInfo)
  checks.push({
    id: 'tools',
    ok: nativeTools !== false,
    detail:
      nativeTools === true
        ? 'Ollama reports native tool-calling support for this tag.'
        : nativeTools === false
          ? 'Ollama did not advertise tool-calling — TaskWraith will use the JSON-in-prose fallback (less reliable).'
          : 'Tool-calling support unknown — TaskWraith will try native tools first, then the JSON fallback.'
  })
  if (nativeTools === false) {
    warnings.push(
      warning(
        'ollama-tools-unadvertised',
        'warning',
        'Tool calling unverified',
        'This tag did not advertise `tools` in Ollama metadata. Expect occasional tool-intent stubs; TaskWraith will nudge and retry.'
      )
    )
  }

  const headline = delegateHint ? `${guidance} ${delegateHint}` : guidance
  warnings.unshift(
    warning('ollama-model-guidance', 'info', `${input.modelLabel} — local expectations`, headline)
  )

  return {
    family,
    checks,
    guidance: headline,
    delegateHint,
    warnings
  }
}

export function shouldRunOllamaModelPreflight(
  completedAtByModel: Record<string, number> | undefined,
  modelId: string
): boolean {
  const key = modelId.trim()
  if (!key) return false
  return !completedAtByModel?.[key]
}

export function ollamaModelPreflightKey(
  modelId: string,
  modelInfo?: Pick<OllamaModelInfo, 'digest'> | null
): string {
  const id = modelId.trim()
  if (!id) return ''
  const digest = String(modelInfo?.digest || '').trim()
  return digest ? `${id}@${digest}` : id
}
