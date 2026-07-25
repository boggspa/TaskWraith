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
