/**
 * Shared Pi upstream brand table — the twin of `ollamaBrandTable`, for the
 * other provider whose runtime id hides the brand the user actually picked.
 *
 * A Pi run is always `provider: 'pi'`, but the model wire id names the BYOK
 * upstream that will serve it (`deepseek/deepseek-v4-flash`). Presenting every
 * Pi row in one seat colour throws that away, so this table maps an upstream to
 * its brand LABEL and hue CLASS and the renderer composes
 * `var(--provider-${class}-color)` — exactly the spoof the Ollama table does
 * for local models.
 *
 * Lives in `src/shared` because BOTH processes need it and the architecture
 * guard forbids a new renderer -> src/main runtime edge ("New cross-process
 * contracts and pure helpers belong in src/shared"). It MUST stay free of node
 * builtins: a node import reachable from the renderer blanks the window.
 *
 * `qwen-token-plan` deliberately resolves to the EXISTING `qwen` hue class
 * rather than minting a new one, so Qwen reads the same whether it arrives via
 * Ollama or via Pi. Keep in lockstep with the iOS twin.
 */

/** Upstream id -> presentation. `hueClass` indexes `--provider-<class>-color`. */
export type PiUpstreamBrand = {
  label: string
  hueClass: string
}

export const PI_UPSTREAM_BRANDS: Readonly<Record<string, PiUpstreamBrand>> = {
  deepseek: { label: 'DeepSeek', hueClass: 'deepseek' },
  zai: { label: 'Z.ai', hueClass: 'zai' },
  // Reuses the Alibaba/Qwen purple already in the palette — see module note.
  'qwen-token-plan': { label: 'Qwen', hueClass: 'qwen' },
  minimax: { label: 'MiniMax', hueClass: 'minimax' },
  // The three Xiaomi token-plan regions share one brand hue; the region is
  // carried by the model label suffix, not a separate colour.
  'xiaomi-token-plan-cn': { label: 'Xiaomi', hueClass: 'xiaomi' },
  'xiaomi-token-plan-sgp': { label: 'Xiaomi', hueClass: 'xiaomi' },
  'xiaomi-token-plan-ams': { label: 'Xiaomi', hueClass: 'xiaomi' },
  mistral: { label: 'Mistral', hueClass: 'mistral' },
  groq: { label: 'Groq', hueClass: 'groq' },
  cerebras: { label: 'Cerebras', hueClass: 'cerebras' },
  openrouter: { label: 'OpenRouter', hueClass: 'openrouter' },
  // OpenRouter-specific overrides for models that should display with their original brand
  // Keyed by OpenRouter's own namespace, which is `z-ai` (hyphenated) —
  // NOT Z.ai's direct-route `zai`. Keep the two spellings apart.
  'openrouter/cohere': { label: 'Cohere', hueClass: 'cohere' },
  'openrouter/minimax': { label: 'MiniMax', hueClass: 'minimax' },
  'openrouter/z-ai': { label: 'Z.ai', hueClass: 'zai' },
  'openrouter/poolside': { label: 'Poolside', hueClass: 'poolside' },
  'openrouter/nvidia': { label: 'NVIDIA', hueClass: 'nvidia' },
  'openrouter/thinkingmachines': { label: 'Thinking Machines', hueClass: 'thinkingmachines' }
}

/**
 * Wire id -> human display label for the curated Pi catalog.
 *
 * The labels themselves live on `PI_STATIC_MODELS` (main), which the renderer
 * may not import; this is the renderer-reachable half, pinned equal to the
 * catalog by `piBrandTable.test.ts` so the two cannot drift as models are added.
 * Without it every Pi surface that holds only a wire id — above-composer chips,
 * the composer picker trigger, transcript headers, the usage tables — renders
 * the raw `mistral/devstral-2512` instead of `Devstral 2`.
 *
 * The `(Groq)` / `(Cerebras)` suffixes are load-bearing in the flat picker list,
 * where the same open-weights model is served by two upstreams and the rows
 * would otherwise be indistinguishable.
 */
export const PI_MODEL_LABELS: Readonly<Record<string, string>> = {
  'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
  'zai/glm-5.2': 'GLM-5.2',
  'zai/glm-5.1': 'GLM-5.1',
  'zai/glm-4.7': 'GLM-4.7',
  'qwen-token-plan/qwen3.7-max': 'Qwen3.7 Max',
  'qwen-token-plan/qwen3.7-plus': 'Qwen3.7 Plus',
  'qwen-token-plan/qwen3.8-max': 'Qwen3.8 Max',
  'minimax/MiniMax-M3': 'MiniMax M3',
  'minimax/MiniMax-M2.7': 'MiniMax M2.7',
  'xiaomi-token-plan-cn/mimo-v2-pro': 'MiMo V2 Pro (CN)',
  'xiaomi-token-plan-cn/mimo-v2.5': 'MiMo V2.5 (CN)',
  'xiaomi-token-plan-cn/mimo-v2.5-pro': 'MiMo V2.5 Pro (CN)',
  'xiaomi-token-plan-sgp/mimo-v2-pro': 'MiMo V2 Pro (SGP)',
  'xiaomi-token-plan-sgp/mimo-v2.5': 'MiMo V2.5 (SGP)',
  'xiaomi-token-plan-sgp/mimo-v2.5-pro': 'MiMo V2.5 Pro (SGP)',
  'xiaomi-token-plan-ams/mimo-v2-pro': 'MiMo V2 Pro (AMS)',
  'xiaomi-token-plan-ams/mimo-v2.5': 'MiMo V2.5 (AMS)',
  'xiaomi-token-plan-ams/mimo-v2.5-pro': 'MiMo V2.5 Pro (AMS)',
  'mistral/zai-glm-5-2': 'GLM-5.2 (via Mistral)',
  'mistral/mistral-medium-3.5': 'Mistral Medium 3.5',
  'mistral/mistral-medium-latest': 'Mistral Medium (Latest)',
  'mistral/mistral-small-2603': 'Mistral Small 4',
  'mistral/mistral-large-2512': 'Mistral Large 3',
  'mistral/devstral-2512': 'Devstral 2',
  'mistral/codestral-2508': 'Codestral (Aug 2025)',
  'mistral/labs-leanstral-1-5': 'Leanstral 1.5 (Labs)',
  'mistral/mistral-medium-2508': 'Mistral Medium 3.1',
  'mistral/mistral-medium-2505': 'Mistral Medium 3',
  'mistral/ministral-14b-2512': 'Ministral 3 (14B)',
  'mistral/ministral-8b-2512': 'Ministral 3 (8B)',
  'mistral/ministral-3b-2512': 'Ministral 3 (3B)',
  'groq/openai/gpt-oss-120b': 'GPT-OSS 120B (Groq)',
  'groq/qwen/qwen3-32b': 'Qwen3 32B (Groq)',
  'cerebras/zai-glm-4.7': 'GLM-4.7 (Cerebras)',
  'cerebras/gpt-oss-120b': 'GPT-OSS 120B (Cerebras)',
  'openrouter/stealth/ox-alpha': 'Ox Alpha',
  'openrouter/cohere/north-mini-code:free': 'North Mini Code (OpenRouter Free)',
  'openrouter/minimax/minimax-m3:free': 'MiniMax M3 (OpenRouter Free)',
  'openrouter/z-ai/glm-5.2': 'GLM 5.2',
  'openrouter/poolside/laguna-s-2.1': 'Laguna S 2.1',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra',
  'openrouter/thinkingmachines/inkling:free': 'Inkling (OpenRouter Free)',
  'openrouter/thinkingmachines/inkling-small:free': 'Inkling Small (OpenRouter Free)'
}

/**
 * The seat's default wire id. Lives here rather than in `main/pi/PiModels`
 * because the renderer needs a floor for "Pi is selected but no upstream key is
 * stored yet", and it may not import from main. `PiModels` re-exports it, so
 * there is exactly one literal.
 */
export const PI_DEFAULT_MODEL_WIRE_ID = 'deepseek/deepseek-v4-flash'

/**
 * Persisted Pi model ids whose upstream renamed the same offered model. Keep
 * these out of PI_MODEL_LABELS/PI_STATIC_MODELS so dead rows never reappear in
 * pickers; dispatch and historical presentation canonicalize through here.
 */
export const PI_MODEL_WIRE_ID_ALIASES: Readonly<Record<string, string>> = {
  'qwen-token-plan/qwen3.8-max-preview': 'qwen-token-plan/qwen3.8-max',
  // OpenRouter's Z.ai namespace is `z-ai`; TaskWraith shipped the
  // unhyphenated form, which 404s. Without this alias a saved seat pinned to
  // the old id falls through `normalizePiWireModelId` to the Pi DEFAULT model
  // — a different vendor, key and bill, with no error.
  'openrouter/zai/glm-5.2': 'openrouter/z-ai/glm-5.2'
}

export function canonicalPiWireModelId(wireModelId: string): string {
  const wire = wireModelId.trim()
  return PI_MODEL_WIRE_ID_ALIASES[wire] ?? wire
}

/**
 * Split a Pi wire id on the FIRST slash: upstream vs pi model id.
 *
 * Splitting on the LAST slash silently breaks Groq, whose ids carry a SECOND
 * slash (`groq/openai/gpt-oss-120b`). Single authority for both processes —
 * `main/pi/PiModels` re-exports this rather than keeping a second copy.
 */
export function splitPiWireModelId(wireId: string): { upstream: string; modelId: string } | null {
  const idx = wireId.indexOf('/')
  if (idx <= 0 || idx === wireId.length - 1) return null
  return { upstream: wireId.slice(0, idx), modelId: wireId.slice(idx + 1) }
}

/**
 * Brand for a Pi wire model id, or null when the id is malformed or names an
 * upstream this build does not surface. Callers fall back to the plain `pi`
 * hue, so an unknown upstream degrades to the seat colour rather than throwing.
 *
 * Special case: OpenRouter models that are resold from other providers (e.g.,
 * `openrouter/z-ai/glm-5.2`) should display with the original provider's brand
 * rather than the generic OpenRouter brand.
 */
export function resolvePiUpstreamBrand(
  wireModelId: string | null | undefined
): PiUpstreamBrand | null {
  const wire = canonicalPiWireModelId(String(wireModelId || '').trim())
  const split = splitPiWireModelId(wire)
  if (!split) return null

  // Special case: OpenRouter resold models use original brand
  if (split.upstream === 'openrouter') {
    const nestedSplit = splitPiWireModelId(split.modelId)
    if (nestedSplit) {
      const openRouterBrandKey = `openrouter/${nestedSplit.upstream}`
      const overrideBrand = PI_UPSTREAM_BRANDS[openRouterBrandKey]
      if (overrideBrand) return overrideBrand
    }
  }

  return PI_UPSTREAM_BRANDS[split.upstream] ?? null
}

/**
 * Human label for a Pi wire id, or null when the id is malformed / names no
 * surfaced upstream.
 *
 * A wire id from an upstream we DO surface but a model we have not catalogued
 * (a mid-cycle upstream release) falls back to the model half alone: the
 * upstream is already rendered beside this label as the brand name, so
 * repeating it — "Mistral · mistral/some-new-model" — is pure noise. Unknown
 * upstreams return null so the caller keeps the raw id rather than showing a
 * fragment of an id we cannot vouch for.
 */
export function resolvePiModelLabel(wireModelId: string | null | undefined): string | null {
  const wire = canonicalPiWireModelId(String(wireModelId || ''))
  if (!wire) return null
  const known = PI_MODEL_LABELS[wire]
  if (known) return known
  const split = splitPiWireModelId(wire)
  if (!split || !resolvePiUpstreamBrand(wire)) return null
  if (split.upstream === 'openrouter') {
    const nestedSplit = splitPiWireModelId(split.modelId)
    const brandKey = nestedSplit ? `openrouter/${nestedSplit.upstream}` : ''
    if (nestedSplit && PI_UPSTREAM_BRANDS[brandKey]) return nestedSplit.modelId
  }
  return split.modelId
}
