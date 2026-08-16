export const PI_PROVIDER_MODEL_CATALOG_MUTATION_EVENT =
  'taskwraith-pi-provider-model-catalog-mutated'

type ProviderModelCatalogEventTarget = Pick<Window, 'dispatchEvent'>

/**
 * Invalidates the renderer's cached Pi model rows after a successful key
 * mutation. The event carries no key material or upstream details.
 */
export function notifyPiProviderModelCatalogMutation(
  target: ProviderModelCatalogEventTarget = window
): void {
  target.dispatchEvent(new Event(PI_PROVIDER_MODEL_CATALOG_MUTATION_EVENT))
}
