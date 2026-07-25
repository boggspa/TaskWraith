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
  mistral: { label: 'Mistral', hueClass: 'mistral' },
  groq: { label: 'Groq', hueClass: 'groq' },
  cerebras: { label: 'Cerebras', hueClass: 'cerebras' }
}

/**
 * Wire id -> human display label for the curated Pi catalog.
 *
 * The labels themselves live on `PI_STATIC_MODELS` (main), which the renderer
 * may not import; this is the renderer-reachable half, pinned equal to the
 * catalog by `piBrandTable.test.ts` so the two cannot drift as models are added.
 * Without it every Pi surface that holds only a wire id — above-composer chips,
 * the composer picker trigger, transcript headers, the usage tables — renders
 * the raw `mistral/devstral-2512` instead of `Devstral 2512`.
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
  'qwen-token-plan/qwen3.8-max-preview': 'Qwen3.8 Max Preview',
  'minimax/MiniMax-M3': 'MiniMax M3',
  'minimax/MiniMax-M2.7': 'MiniMax M2.7',
  'mistral/devstral-2512': 'Devstral 2512',
  'mistral/mistral-medium-3.5': 'Mistral Medium 3.5',
  'groq/openai/gpt-oss-120b': 'GPT-OSS 120B (Groq)',
  'groq/qwen/qwen3-32b': 'Qwen3 32B (Groq)',
  'cerebras/zai-glm-4.7': 'GLM-4.7 (Cerebras)',
  'cerebras/gpt-oss-120b': 'GPT-OSS 120B (Cerebras)'
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
 */
export function resolvePiUpstreamBrand(
  wireModelId: string | null | undefined
): PiUpstreamBrand | null {
  const split = splitPiWireModelId(String(wireModelId || '').trim())
  if (!split) return null
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
  const wire = String(wireModelId || '').trim()
  if (!wire) return null
  const known = PI_MODEL_LABELS[wire]
  if (known) return known
  const split = splitPiWireModelId(wire)
  if (!split || !PI_UPSTREAM_BRANDS[split.upstream]) return null
  return split.modelId
}
