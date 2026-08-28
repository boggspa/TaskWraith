/**
 * MOVED from src/main/pi/PiModels.ts (120 lines) — this is now the single
 * definition, shared by the pure-Node Host and Electron main.
 *
 * src/main/pi/PiModels.ts is a re-export shim, so its public API is byte-identical
 * and src/main/index.ts needs no change. Node-pure: node: builtins and
 * src/shared/** only.
 */
/**
 * Curated static catalog for the Pi seat. Wire ids are `<upstream>/<modelId>`
 * using pi's own provider/id syntax; groq ids contain a second slash
 * (`groq/openai/gpt-oss-120b`), so always split on the FIRST slash only via
 * splitPiWireModelId.
 *
 * Static-floor rationale (the AntiGravity lesson): a provider whose model
 * list can transiently be empty vanishes from every picker, so the seat
 * ships a bundled list rather than shelling out to `pi --list-models`.
 * Built-in metadata below is extracted from pi 0.84.2's bundled catalog
 * (@earendil-works/pi-ai providers/data). Newer Mistral deployments and the
 * curated OpenRouter routes are registered per run; re-check both sources on
 * pi upgrades.
 *
 * Curation is deliberate: flagship coder models per allowed upstream. Resold
 * duplicates stay out unless they expose a distinct user-paid entitlement
 * lane (Mistral-hosted GLM-5.2 is the explicit exception); qwen-token-plan's
 * hosted copies remain omitted. Every entry must satisfy piModelPolicyVerdict;
 * the test suite enforces it.
 */

import { isPiModelRetired } from '../../shared/piModelLifecycle'
import { canonicalPiWireModelId, splitPiWireModelId } from '../../shared/piBrandTable'
import type { PiUpstreamId } from './PiModelPolicy'

export interface PiModelDefinition {
  /** TaskWraith wire id: `<upstream>/<modelId>` (pi's own syntax). */
  wireId: string
  upstream: PiUpstreamId
  /** The id pi expects after `--provider <upstream> --model ...`. */
  modelId: string
  label: string
  contextWindow: number
  maxOutputTokens: number
  thinking: boolean
  images: boolean
}

export const PI_STATIC_MODELS: readonly PiModelDefinition[] = [
  // DeepSeek — first-party API
  {
    wireId: 'deepseek/deepseek-v4-pro',
    upstream: 'deepseek',
    modelId: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinking: true,
    images: false
  },
  {
    wireId: 'deepseek/deepseek-v4-flash',
    upstream: 'deepseek',
    modelId: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    thinking: true,
    images: false
  },
  // Z.ai — GLM coding plan
  {
    wireId: 'zai/glm-5.2',
    upstream: 'zai',
    modelId: 'glm-5.2',
    label: 'GLM-5.2',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'zai/glm-5.1',
    upstream: 'zai',
    modelId: 'glm-5.1',
    label: 'GLM-5.1',
    contextWindow: 200_000,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'zai/glm-4.7',
    upstream: 'zai',
    modelId: 'glm-4.7',
    label: 'GLM-4.7',
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  // Qwen token plan (Alibaba) — native Qwen models only, no resold copies
  {
    wireId: 'qwen-token-plan/qwen3.7-max',
    upstream: 'qwen-token-plan',
    modelId: 'qwen3.7-max',
    label: 'Qwen3.7 Max',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'qwen-token-plan/qwen3.7-plus',
    upstream: 'qwen-token-plan',
    modelId: 'qwen3.7-plus',
    label: 'Qwen3.7 Plus',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    thinking: true,
    images: true
  },
  {
    wireId: 'qwen-token-plan/qwen3.8-max',
    upstream: 'qwen-token-plan',
    modelId: 'qwen3.8-max',
    label: 'Qwen3.8 Max',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    thinking: true,
    images: true
  },
  // MiniMax
  {
    wireId: 'minimax/MiniMax-M3',
    upstream: 'minimax',
    modelId: 'MiniMax-M3',
    label: 'MiniMax M3',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinking: true,
    images: true
  },
  {
    wireId: 'minimax/MiniMax-M2.7',
    upstream: 'minimax',
    modelId: 'MiniMax-M2.7',
    label: 'MiniMax M2.7',
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  // Xiaomi token plan — three regional deployments of the SAME catalog; the
  // Settings card's region picker files the key under exactly one of them.
  // Metadata from pi 0.84.2's bundled xiaomi-token-plan-{cn,sgp,ams} catalogs.
  {
    wireId: 'xiaomi-token-plan-cn/mimo-v2-pro',
    upstream: 'xiaomi-token-plan-cn',
    modelId: 'mimo-v2-pro',
    label: 'MiMo V2 Pro (CN)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'xiaomi-token-plan-cn/mimo-v2.5',
    upstream: 'xiaomi-token-plan-cn',
    modelId: 'mimo-v2.5',
    label: 'MiMo V2.5 (CN)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: true
  },
  {
    wireId: 'xiaomi-token-plan-cn/mimo-v2.5-pro',
    upstream: 'xiaomi-token-plan-cn',
    modelId: 'mimo-v2.5-pro',
    label: 'MiMo V2.5 Pro (CN)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'xiaomi-token-plan-sgp/mimo-v2-pro',
    upstream: 'xiaomi-token-plan-sgp',
    modelId: 'mimo-v2-pro',
    label: 'MiMo V2 Pro (SGP)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'xiaomi-token-plan-sgp/mimo-v2.5',
    upstream: 'xiaomi-token-plan-sgp',
    modelId: 'mimo-v2.5',
    label: 'MiMo V2.5 (SGP)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: true
  },
  {
    wireId: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
    upstream: 'xiaomi-token-plan-sgp',
    modelId: 'mimo-v2.5-pro',
    label: 'MiMo V2.5 Pro (SGP)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'xiaomi-token-plan-ams/mimo-v2-pro',
    upstream: 'xiaomi-token-plan-ams',
    modelId: 'mimo-v2-pro',
    label: 'MiMo V2 Pro (AMS)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  {
    wireId: 'xiaomi-token-plan-ams/mimo-v2.5',
    upstream: 'xiaomi-token-plan-ams',
    modelId: 'mimo-v2.5',
    label: 'MiMo V2.5 (AMS)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: true
  },
  {
    wireId: 'xiaomi-token-plan-ams/mimo-v2.5-pro',
    upstream: 'xiaomi-token-plan-ams',
    modelId: 'mimo-v2.5-pro',
    label: 'MiMo V2.5 Pro (AMS)',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: false
  },
  // Mistral API — includes Mistral-hosted third-party and Labs deployments.
  // Pi 0.82.1 does not bundle six of these ids; PiMistralModelRegistration
  // registers only the selected missing row inside its isolated per-run home.
  {
    wireId: 'mistral/zai-glm-5-2',
    upstream: 'mistral',
    modelId: 'zai-glm-5-2',
    label: 'GLM-5.2 (via Mistral)',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    thinking: false,
    images: false
  },
  {
    wireId: 'mistral/mistral-medium-3.5',
    upstream: 'mistral',
    modelId: 'mistral-medium-3.5',
    label: 'Mistral Medium 3.5',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: true,
    images: true
  },
  {
    wireId: 'mistral/mistral-medium-latest',
    upstream: 'mistral',
    modelId: 'mistral-medium-latest',
    label: 'Mistral Medium (Latest)',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: true,
    images: true
  },
  {
    wireId: 'mistral/mistral-small-2603',
    upstream: 'mistral',
    modelId: 'mistral-small-2603',
    label: 'Mistral Small 4',
    contextWindow: 256_000,
    maxOutputTokens: 256_000,
    thinking: true,
    images: true
  },
  {
    wireId: 'mistral/mistral-large-2512',
    upstream: 'mistral',
    modelId: 'mistral-large-2512',
    label: 'Mistral Large 3',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: false,
    images: true
  },
  {
    wireId: 'mistral/devstral-2512',
    upstream: 'mistral',
    modelId: 'devstral-2512',
    label: 'Devstral 2',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: false,
    images: false
  },
  {
    wireId: 'mistral/codestral-2508',
    upstream: 'mistral',
    modelId: 'codestral-2508',
    label: 'Codestral (Aug 2025)',
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
    thinking: false,
    images: false
  },
  {
    wireId: 'mistral/labs-leanstral-1-5',
    upstream: 'mistral',
    modelId: 'labs-leanstral-1-5',
    label: 'Leanstral 1.5 (Labs)',
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    thinking: false,
    images: false
  },
  {
    wireId: 'mistral/mistral-medium-2508',
    upstream: 'mistral',
    modelId: 'mistral-medium-2508',
    label: 'Mistral Medium 3.1',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: false,
    images: true
  },
  {
    wireId: 'mistral/mistral-medium-2505',
    upstream: 'mistral',
    modelId: 'mistral-medium-2505',
    label: 'Mistral Medium 3',
    contextWindow: 131_072,
    maxOutputTokens: 131_072,
    thinking: false,
    images: true
  },
  {
    wireId: 'mistral/ministral-14b-2512',
    upstream: 'mistral',
    modelId: 'ministral-14b-2512',
    label: 'Ministral 3 (14B)',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: false,
    images: true
  },
  {
    wireId: 'mistral/ministral-8b-2512',
    upstream: 'mistral',
    modelId: 'ministral-8b-2512',
    label: 'Ministral 3 (8B)',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: false,
    images: true
  },
  {
    wireId: 'mistral/ministral-3b-2512',
    upstream: 'mistral',
    modelId: 'ministral-3b-2512',
    label: 'Ministral 3 (3B)',
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
    thinking: false,
    images: true
  },
  // Groq — open-weights on fast inference silicon
  {
    wireId: 'groq/openai/gpt-oss-120b',
    upstream: 'groq',
    modelId: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    thinking: true,
    images: false
  },
  {
    wireId: 'groq/qwen/qwen3-32b',
    upstream: 'groq',
    modelId: 'qwen/qwen3-32b',
    label: 'Qwen3 32B (Groq)',
    contextWindow: 131_072,
    maxOutputTokens: 40_960,
    thinking: true,
    images: false
  },
  // Cerebras — open-weights, ultra-fast
  {
    wireId: 'cerebras/zai-glm-4.7',
    upstream: 'cerebras',
    modelId: 'zai-glm-4.7',
    label: 'GLM-4.7 (Cerebras)',
    contextWindow: 131_072,
    maxOutputTokens: 40_960,
    thinking: true,
    images: false
  },
  {
    wireId: 'cerebras/gpt-oss-120b',
    upstream: 'cerebras',
    modelId: 'gpt-oss-120b',
    label: 'GPT-OSS 120B (Cerebras)',
    contextWindow: 131_072,
    maxOutputTokens: 40_960,
    thinking: true,
    images: false
  },
  // OpenRouter — user-approved exceptions only. Pi 0.82.1 does not bundle
  // these models, so PiOpenRouterModelRegistration writes active metadata in
  // the selected run's isolated home before Pi starts.
  {
    // Historical metadata only: lifecycle filtering hides this from current
    // offers and policy refuses a new run, while saved chats/seats retain its
    // original label and context window.
    wireId: 'openrouter/stealth/ox-alpha',
    upstream: 'openrouter',
    modelId: 'stealth/ox-alpha',
    label: 'Ox Alpha',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    thinking: true,
    images: true
  },
  {
    wireId: 'openrouter/zai/glm-5.2',
    upstream: 'openrouter',
    modelId: 'zai/glm-5.2',
    label: 'GLM 5.2',
    contextWindow: 256_000,
    maxOutputTokens: 131_072,
    thinking: false,
    images: false
  },
  {
    wireId: 'openrouter/poolside/laguna-s-2.1',
    upstream: 'openrouter',
    modelId: 'poolside/laguna-s-2.1',
    label: 'Laguna S 2.1',
    contextWindow: 256_000,
    maxOutputTokens: 131_072,
    thinking: false,
    images: false
  },
  {
    wireId: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    upstream: 'openrouter',
    modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    label: 'Nemotron 3 Ultra',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    thinking: false,
    images: false
  }
]

export { PI_DEFAULT_MODEL_WIRE_ID } from '../../shared/piBrandTable'

/**
 * Split a wire id on the FIRST slash: upstream vs pi model id.
 *
 * The implementation moved to `shared/piBrandTable` when the renderer needed it
 * for sub-provider hue tinting (the architecture guard forbids a renderer ->
 * src/main runtime edge). Re-exported here so main call sites are unchanged and
 * there is exactly ONE splitter — the Groq two-slash rule cannot drift.
 */
export { canonicalPiWireModelId, splitPiWireModelId }

export function findPiStaticModel(wireId: string): PiModelDefinition | undefined {
  const canonicalWireId = canonicalPiWireModelId(wireId)
  return PI_STATIC_MODELS.find((model) => model.wireId === canonicalWireId)
}

/** Models whose upstream has a configured key (the picker's visible set). */
export function piModelsForConfiguredUpstreams(
  configured: ReadonlySet<string>,
  now: Date = new Date()
): PiModelDefinition[] {
  return PI_STATIC_MODELS.filter(
    (model) => configured.has(model.upstream) && !isPiModelRetired(model.wireId, now)
  )
}
