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
 * Spoofed upstream brand label for a model whose provider id hides the brand
 * the user actually picked — "Alibaba" for an Ollama-hosted Qwen, "Mistral" for
 * a Pi run served by the Mistral API. Null for every other provider, and for
 * models of these two whose brand we cannot identify.
 *
 * Callers pair this with the plain provider name
 * (`resolveProviderBrandLabel(...) || getProviderName(provider)`), so the spoof
 * is OPT-IN per surface. That split is deliberate: presentation surfaces — the
 * composer picker trigger, above-composer chips, transcript headers, mention
 * chips — name the brand, while the surfaces that group models by seat or
 * authenticate one (Mode/Reasoning picker, Settings sign-in, first launch)
 * keep calling the seat "Pi" / "Ollama", because that IS the thing being
 * grouped and signed into. Do not fold this into `getProviderName`.
 */
export function resolveProviderBrandLabel(
  provider: string | undefined | null,
  modelId?: string | null,
  modelLabel?: string | null
): string | null {
  const id = String(provider || '').trim()
  if (id === 'ollama') {
    const brand = resolveOllamaDisplayBrand(modelId, modelLabel)
    if (brand) return brand.providerLabel
  }
  if (id === 'pi') {
    const brand = resolvePiUpstreamBrand(modelId)
    if (brand) return brand.label
  }
  return null
}

export { OLLAMA_DISPLAY_BRANDS }
export type { OllamaDisplayBrand, OllamaDisplayBrandDefinition }
