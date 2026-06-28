import type { OllamaModelInfo } from './OllamaProvider'
import type { ProviderCapabilityWarning } from '../store/types'

export type OllamaModelFamily =
  | 'qwen3_4b'
  | 'qwen3_5_9b'
  | 'qwen3_6_35b'
  | 'gemma4_12b'
  | 'ornith_9b'
  | 'ornith_35b'
  | 'gpt_oss_20b'
  | 'minicpm_v45_8b'
  | 'granite4_1_3b'
  | 'granite4_1_30b'
  | 'nemotron3_33b'
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
    ...(Array.isArray(modelInfo?.show?.details?.families) ? modelInfo.show.details.families : [])
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
  if (key === 'qwen3.6:35b' || key.startsWith('qwen3.6:35b-')) return 'qwen3_6_35b'
  if (key === 'minicpm-v4.5:8b' || key.startsWith('minicpm-v4.5:8b-')) return 'minicpm_v45_8b'
  if (key === 'granite4.1:3b' || key.startsWith('granite4.1:3b-')) return 'granite4_1_3b'
  if (key === 'granite4.1:30b' || key.startsWith('granite4.1:30b-')) return 'granite4_1_30b'
  if (key === 'nemotron3:33b' || key.startsWith('nemotron3:33b-')) return 'nemotron3_33b'
  if (key === 'qwen3:4b-instruct' || key.startsWith('qwen3:4b')) return 'qwen3_4b'
  if (key === 'qwen3.5:9b' || key.startsWith('qwen3.5:9b')) return 'qwen3_5_9b'
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
  if (
    key === 'gpt-oss' ||
    key === 'gpt-oss:20b' ||
    key === 'gpt-oss:latest' ||
    key.startsWith('gpt-oss') ||
    key === 'openai/gpt-oss-20b'
  ) {
    return 'gpt_oss_20b'
  }
  const meta = metadataText(modelInfo)
  if (meta.includes('gptoss') || meta.includes('gpt-oss')) {
    return 'gpt_oss_20b'
  }
  if (meta.includes('ornith') && meta.includes('35b')) return 'ornith_35b'
  if (meta.includes('ornith') && meta.includes('9b')) return 'ornith_9b'
  if (meta.includes('ornith')) return 'ornith_9b'
  if (meta.includes('qwen35moe') || meta.includes('qwen3.6')) return 'qwen3_6_35b'
  if (meta.includes('nemotron')) return 'nemotron3_33b'
  if (meta.includes('granite') && (meta.includes('3.4b') || meta.includes('3b'))) {
    return 'granite4_1_3b'
  }
  if (meta.includes('granite')) return 'granite4_1_30b'
  if (meta.includes('qwen3') && meta.includes('9b')) return 'qwen3_5_9b'
  if (meta.includes('qwen3')) return 'qwen3_4b'
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
  const bytesPerParam = quant.includes('MXFP4')
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
        guidance: `${modelLabel} is a capable local scout for scoped tasks — search, read files, and single-file edits with approval.`,
        delegateHint:
          'For multi-file refactors, broad test-suite fixes, or long autonomous loops, delegate implementation to Codex or Claude.'
      }
    case 'qwen3_6_35b':
      return {
        guidance: `${modelLabel} is a strong local reasoning model with a large context window and native tool support.`,
        delegateHint:
          'For long implementation loops or release-critical edits, keep Codex/Claude delegation available as the verification pass.'
      }
    case 'qwen3_4b':
      return {
        guidance: `${modelLabel} is best for quick lookups, narrow reads, and short answers.`,
        delegateHint:
          'For edits, shell work, or multi-step refactors, use a larger local model or delegate to a cloud provider.'
      }
    case 'minicpm_v45_8b':
      return {
        guidance: `${modelLabel} is a compact multimodal local model with tools and thinking support.`,
        delegateHint:
          'Use it for scoped reads, visual/local checks, and quick analysis; delegate broad code edits to a stronger implementation model.'
      }
    case 'gemma4_12b':
      return {
        guidance: `${modelLabel} handles moderate local tasks well — exploration, planning, and smaller edits.`,
        delegateHint:
          'For large refactors or repo-wide test fixes, consider Codex or Claude for implementation.'
      }
    case 'ornith_9b':
      return {
        guidance: `${modelLabel} is an agentic-coding local model; keep tasks scoped, search first, and verify generated edits carefully.`,
        delegateHint:
          'Use it for local planning and focused patches; delegate broad refactors or long test-fix loops to Codex or Claude.'
      }
    case 'ornith_35b':
      return {
        guidance: `${modelLabel} is a larger agentic-coding local model with a broad context window for deeper repo review and focused implementation.`,
        delegateHint:
          'For release-critical changes, pair it with Codex or Claude verification before landing broad edits.'
      }
    case 'granite4_1_3b':
      return {
        guidance: `${modelLabel} is a lightweight tool-capable local model for fast reads and small planning tasks.`,
        delegateHint:
          'For edits, shell verification, or long reasoning chains, use a larger Ollama tag or delegate to Codex/Claude.'
      }
    case 'granite4_1_30b':
      return {
        guidance: `${modelLabel} is a larger tool-capable local model suited to deeper local review and planning.`,
        delegateHint:
          'For release-critical patches, use it as a local reviewer or pair it with Codex/Claude verification.'
      }
    case 'nemotron3_33b':
      return {
        guidance: `${modelLabel} is a multimodal local reasoning model with native tools and thinking support.`,
        delegateHint:
          'Use it for deep local analysis and visual checks; delegate broad multi-file implementation when latency or reliability matters.'
      }
    case 'gpt_oss_20b':
      return {
        guidance: `${modelLabel} has stronger reasoning but can be finicky with tool calls; TaskWraith will nudge it when it stalls.`,
        delegateHint:
          'For heavy multi-file implementation, a cloud sub-thread (Codex/Claude) is often faster and more reliable.'
      }
    default:
      return {
        guidance: `${modelLabel} is a local model — great for privacy and quick workspace reads, but smaller than frontier cloud agents.`,
        delegateHint:
          'For ambitious refactors or long tool chains, delegate the implementation pass to Codex or Claude.'
      }
  }
}

function defaultParameterBillionsForFamily(family: OllamaModelFamily): number | null {
  switch (family) {
    case 'qwen3_4b':
      return 4
    case 'qwen3_5_9b':
      return 9
    case 'qwen3_6_35b':
      return 36
    case 'minicpm_v45_8b':
      return 8
    case 'gemma4_12b':
      return 12
    case 'ornith_9b':
      return 9
    case 'ornith_35b':
      return 35
    case 'granite4_1_3b':
      return 3
    case 'granite4_1_30b':
      return 30
    case 'nemotron3_33b':
      return 33
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
