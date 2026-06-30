import { normalizeOllamaModelKey } from '../../../shared/ollamaModelAvailability'
import type { CodexModelOption } from './providerModelDefaults'
import { OLLAMA_DEFAULT_MODELS } from './providerModelDefaults'
import { canonicalModelIdForProvider, humaniseModelId } from './modelDisplayName'

export function ollamaModelCatalogKey(modelId?: string | null): string {
  const canonical = canonicalModelIdForProvider('ollama', modelId)
  return normalizeOllamaModelKey(canonical || modelId)
}

function resolveOllamaCatalogLabel(
  model: CodexModelOption,
  previous?: CodexModelOption
): string {
  const id = String(model.id || '').trim()
  const humanLabel = humaniseModelId('ollama', id)
  if (humanLabel && normalizeOllamaModelKey(humanLabel) !== normalizeOllamaModelKey(id)) {
    return humanLabel
  }
  return model.label || previous?.label || id
}

export function mergeOllamaModelCatalog(models?: CodexModelOption[] | null): CodexModelOption[] {
  const byKey = new Map<string, CodexModelOption>()
  const add = (model: CodexModelOption): void => {
    if (!model?.id || model.id === 'custom') return
    const key = ollamaModelCatalogKey(model.id)
    if (!key) return
    const previous = byKey.get(key)
    byKey.set(key, {
      ...previous,
      ...model,
      label: resolveOllamaCatalogLabel(model, previous)
    })
  }
  for (const model of OLLAMA_DEFAULT_MODELS) add(model)
  const liveDefaultKey = Array.isArray(models)
    ? ollamaModelCatalogKey(models.find((model) => model.isDefault)?.id)
    : ''
  if (liveDefaultKey) {
    for (const [key, model] of byKey) {
      byKey.set(key, { ...model, isDefault: key === liveDefaultKey })
    }
  }
  if (Array.isArray(models)) {
    for (const model of models) add(model)
  }
  return [
    ...byKey.values(),
    OLLAMA_DEFAULT_MODELS.find((model) => model.id === 'custom') || {
      id: 'custom',
      label: 'Custom model ID'
    }
  ]
}
