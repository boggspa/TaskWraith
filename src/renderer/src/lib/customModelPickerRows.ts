import {
  CUSTOM_MODEL_ENTRY_ID,
  customModelRowId,
  customModelsForProvider,
  normalizeCustomModelId
} from '../../../shared/customProviderModels'
import type { CustomProviderModels } from '../../../shared/customProviderModels'

/**
 * How a provider's saved custom model IDs are folded into the composer's model
 * picker.
 *
 * Kept out of Composer.tsx so the two rules that are easy to get subtly wrong —
 * where the saved rows sit, and which row wears the check mark — are testable
 * without standing up the composer.
 */

/** The subset of a picker row this module needs; the real type carries more. */
export interface CustomModelPickerRow {
  id: string
  label: string
}

/**
 * Splice a provider's saved ids in immediately above the "Custom model ID"
 * entry row, so the list reads as "curated models, your models, add one".
 *
 * Row ids are namespaced (`custom:<id>`) so a saved id can never collide with a
 * catalogue model id and the composer's change handler can tell a saved row
 * from the entry row.
 */
export function withSavedCustomModelRows<Row extends CustomModelPickerRow>(
  store: CustomProviderModels | null | undefined,
  provider: string,
  options: Row[]
): (Row | CustomModelPickerRow)[] {
  const saved = customModelsForProvider(store, provider)
  if (saved.length === 0) return options
  const rows: CustomModelPickerRow[] = saved.map((modelId) => ({
    id: customModelRowId(modelId),
    label: modelId
  }))
  const entryIndex = options.findIndex((option) => option.id === CUSTOM_MODEL_ENTRY_ID)
  // A provider whose catalogue has no entry row (the picker adds one only when
  // custom models are offered at all) still gets its saved rows, at the end.
  if (entryIndex < 0) return [...options, ...rows]
  return [...options.slice(0, entryIndex), ...rows, ...options.slice(entryIndex)]
}

/**
 * The id the picker should treat as selected.
 *
 * A custom selection whose value matches a SAVED id belongs to that row.
 * Anything else — a half-typed id, or one the user has not committed — stays on
 * the entry row, so the text field keeps its check mark while it is in use.
 */
export function customModelPickerSelectionId(
  store: CustomProviderModels | null | undefined,
  provider: string,
  selectedModelId: string,
  customModel: unknown
): string {
  if (selectedModelId !== CUSTOM_MODEL_ENTRY_ID) return selectedModelId
  const modelId = normalizeCustomModelId(customModel)
  if (!modelId) return selectedModelId
  if (!customModelsForProvider(store, provider).includes(modelId)) return selectedModelId
  return customModelRowId(modelId)
}
