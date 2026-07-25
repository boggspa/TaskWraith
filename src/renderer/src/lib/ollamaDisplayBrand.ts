import { humaniseModelId } from './modelDisplayName'
import {
  OLLAMA_DISPLAY_BRANDS,
  matchOllamaBrand,
  type OllamaDisplayBrandDefinition
} from '../../../shared/ollamaBrandTable'
import { resolvePiUpstreamBrand } from '../../../shared/piBrandTable'

type OllamaDisplayBrand = {
  providerLabel: string
  providerClass: string
  modelLabel: string
}

export function resolveOllamaDisplayBrand(
  modelId: string | undefined | null,
  modelLabel?: string | null
): OllamaDisplayBrand | null {
  const id = String(modelId || '').trim()
  const label = String(modelLabel || humaniseModelId('ollama', id) || '').trim()
  const match = matchOllamaBrand(id, label)
  if (!match) return null
  return {
    providerLabel: match.providerLabel,
    providerClass: match.providerClass,
    modelLabel: label || match.fallbackModelLabel
  }
}

/**
 * Resolve the CSS hue class for a provider + model. Returns the runtime
 * provider id for everything except the two providers whose id hides the brand
 * the user actually picked:
 *
 * - **Ollama** — local models resolve to their spoofed upstream brand class
 *   (e.g. `alibaba`).
 * - **Pi** — a BYOK seat whose wire id names the upstream serving it, so
 *   `deepseek/deepseek-v4-flash` resolves to `deepseek`.
 *
 * Callers compose this into `var(--provider-${class}-color)` for tinting — used
 * by the @-mention chips so a `@Planner` running Qwen paints Alibaba purple
 * instead of generic Ollama green, matching the transcript header.
 *
 * Unknown upstreams/models fall through to the plain provider id, so a Pi model
 * this build does not surface simply wears the Pi seat colour.
 */
export function resolveProviderHueClass(
  provider: string | undefined | null,
  modelId?: string | null,
  modelLabel?: string | null
): string {
  const id = String(provider || '').trim()
  if (id === 'ollama') {
    const brand = resolveOllamaDisplayBrand(modelId, modelLabel)
    if (brand) return brand.providerClass
  }
  if (id === 'pi') {
    const brand = resolvePiUpstreamBrand(modelId)
    if (brand) return brand.hueClass
  }
  return id
}

/**
 * Spoofed upstream brand label for an Ollama-backed model (e.g. "Alibaba"),
 * or null for non-Ollama providers / unbranded Ollama models. Lets mention
 * chips fall back to the brand name instead of "Ollama" when a participant
 * has no explicit role.
 */
export function resolveProviderBrandLabel(
  provider: string | undefined | null,
  modelId?: string | null,
  modelLabel?: string | null
): string | null {
  if (String(provider || '').trim() === 'ollama') {
    const brand = resolveOllamaDisplayBrand(modelId, modelLabel)
    if (brand) return brand.providerLabel
  }
  return null
}

export { OLLAMA_DISPLAY_BRANDS }
export type { OllamaDisplayBrand, OllamaDisplayBrandDefinition }
