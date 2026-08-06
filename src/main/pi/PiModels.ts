/**
 * Curated static catalog for the Pi seat. Wire ids are `<upstream>/<modelId>`
 * using pi's own provider/id syntax; groq ids contain a second slash
 * (`groq/openai/gpt-oss-120b`), so always split on the FIRST slash only via
 * splitPiWireModelId.
 *
 * Static-floor rationale (the AntiGravity lesson): a provider whose model
 * list can transiently be empty vanishes from every picker, so the seat
 * ships a bundled list rather than shelling out to `pi --list-models`.
 * Metadata below is extracted verbatim from pi 0.82.1's bundled catalog
 * (@earendil-works/pi-ai providers/data); re-extract on pi upgrades.
 *
 * Curation is deliberate: flagship coder models per allowed upstream, no
 * resold duplicates (qwen-token-plan also carries deepseek/glm/minimax/kimi
 * copies — the kimi ones are policy-refused, the rest are pointless dupes).
 * Every entry must satisfy piModelPolicyVerdict; the test suite enforces it.
 */

import { isPiModelRetired } from '../../shared/piModelLifecycle'
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
  { wireId: 'deepseek/deepseek-v4-pro', upstream: 'deepseek', modelId: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxOutputTokens: 384_000, thinking: true, images: false },
  { wireId: 'deepseek/deepseek-v4-flash', upstream: 'deepseek', modelId: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxOutputTokens: 384_000, thinking: true, images: false },
  // Z.ai — GLM coding plan
  { wireId: 'zai/glm-5.2', upstream: 'zai', modelId: 'glm-5.2', label: 'GLM-5.2', contextWindow: 1_000_000, maxOutputTokens: 131_072, thinking: true, images: false },
  { wireId: 'zai/glm-5.1', upstream: 'zai', modelId: 'glm-5.1', label: 'GLM-5.1', contextWindow: 200_000, maxOutputTokens: 131_072, thinking: true, images: false },
  { wireId: 'zai/glm-4.7', upstream: 'zai', modelId: 'glm-4.7', label: 'GLM-4.7', contextWindow: 204_800, maxOutputTokens: 131_072, thinking: true, images: false },
  // Qwen token plan (Alibaba) — native Qwen models only, no resold copies
  { wireId: 'qwen-token-plan/qwen3.7-max', upstream: 'qwen-token-plan', modelId: 'qwen3.7-max', label: 'Qwen3.7 Max', contextWindow: 1_000_000, maxOutputTokens: 131_072, thinking: true, images: false },
  { wireId: 'qwen-token-plan/qwen3.7-plus', upstream: 'qwen-token-plan', modelId: 'qwen3.7-plus', label: 'Qwen3.7 Plus', contextWindow: 1_000_000, maxOutputTokens: 65_536, thinking: true, images: true },
  { wireId: 'qwen-token-plan/qwen3.8-max-preview', upstream: 'qwen-token-plan', modelId: 'qwen3.8-max-preview', label: 'Qwen3.8 Max Preview', contextWindow: 1_000_000, maxOutputTokens: 131_072, thinking: true, images: true },
  // MiniMax
  { wireId: 'minimax/MiniMax-M3', upstream: 'minimax', modelId: 'MiniMax-M3', label: 'MiniMax M3', contextWindow: 1_000_000, maxOutputTokens: 128_000, thinking: true, images: true },
  { wireId: 'minimax/MiniMax-M2.7', upstream: 'minimax', modelId: 'MiniMax-M2.7', label: 'MiniMax M2.7', contextWindow: 204_800, maxOutputTokens: 131_072, thinking: true, images: false },
  // Mistral
  { wireId: 'mistral/devstral-2512', upstream: 'mistral', modelId: 'devstral-2512', label: 'Devstral 2512', contextWindow: 262_144, maxOutputTokens: 262_144, thinking: false, images: false },
  { wireId: 'mistral/mistral-medium-3.5', upstream: 'mistral', modelId: 'mistral-medium-3.5', label: 'Mistral Medium 3.5', contextWindow: 262_144, maxOutputTokens: 262_144, thinking: true, images: true },
  // Mistral Large 3 (2512-01) — pi names it "Mistral Large 3"; the label keeps
  // the dated build because Mistral also ships `mistral-large-2411` and a
  // floating `mistral-large-latest`. `thinking: false` is pi's own
  // `reasoning: false`: Large 3 is NOT a reasoning model (Magistral and
  // mistral-medium-3.5 are), so it deliberately gets no reasoning options.
  { wireId: 'mistral/mistral-large-2512', upstream: 'mistral', modelId: 'mistral-large-2512', label: 'Mistral Large 3 (2512)', contextWindow: 262_144, maxOutputTokens: 262_144, thinking: false, images: true },
  // Groq — open-weights on fast inference silicon
  { wireId: 'groq/openai/gpt-oss-120b', upstream: 'groq', modelId: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Groq)', contextWindow: 131_072, maxOutputTokens: 65_536, thinking: true, images: false },
  { wireId: 'groq/qwen/qwen3-32b', upstream: 'groq', modelId: 'qwen/qwen3-32b', label: 'Qwen3 32B (Groq)', contextWindow: 131_072, maxOutputTokens: 40_960, thinking: true, images: false },
  // Cerebras — open-weights, ultra-fast
  { wireId: 'cerebras/zai-glm-4.7', upstream: 'cerebras', modelId: 'zai-glm-4.7', label: 'GLM-4.7 (Cerebras)', contextWindow: 131_072, maxOutputTokens: 40_960, thinking: true, images: false },
  { wireId: 'cerebras/gpt-oss-120b', upstream: 'cerebras', modelId: 'gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)', contextWindow: 131_072, maxOutputTokens: 40_960, thinking: true, images: false }
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
export { splitPiWireModelId } from '../../shared/piBrandTable'

export function findPiStaticModel(wireId: string): PiModelDefinition | undefined {
  return PI_STATIC_MODELS.find((model) => model.wireId === wireId)
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
