import type {
  TaskWraithControlModelOffer,
  TaskWraithControlThreadOffers
} from '../../shared/taskWraithControlProtocol'
import { resolveTaskWraithProviderPresentation } from '../../shared/taskWraithProviderPresentation'
import { isLiveSelectableProvider } from '../../shared/retiredProviders'
import { getStaticProviderModels } from '../providers/StaticProviderModels'

/** Bounded so the complete picker remains comfortably inside local wire limits. */
const TUI_MODEL_OFFER_LIMIT = 40
const TUI_REASONING_OFFER_LIMIT = 12

interface CuratedModelOption {
  id: string
  label?: string
  isDefault?: boolean
  disabled?: boolean
  disabledReason?: string
  retiresAt?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    disabled?: boolean
    disabledReason?: string
  }>
  defaultReasoningEffort?: string | null
}

export interface TaskWraithThreadOffersInput {
  readonly threadId: string
  readonly provider: string
  readonly currentModel?: string
  readonly currentReasoningEffort?: string
  readonly ensemble?: boolean
  readonly archived?: boolean
}

export interface TaskWraithThreadSelection {
  readonly model?: string
  readonly reasoningEffort?: string
}

export type TaskWraithThreadSelectionResult =
  | { readonly ok: true; readonly value: TaskWraithThreadSelection }
  | { readonly ok: false; readonly error: string }

function normalizeProviderModelKey(model?: string | null): string {
  return String(model || '')
    .trim()
    .toLowerCase()
}

/**
 * The curated picker rows for one provider. Machine-dependent catalogues stay
 * App-side rather than advertising choices that may not exist at dispatch.
 */
function curatedRowsForProvider(provider: string): CuratedModelOption[] | { locked: string } {
  if (!isLiveSelectableProvider(provider)) {
    return { locked: 'This provider cannot be switched here — manage it in the App.' }
  }
  switch (provider) {
    case 'codex':
    case 'claude':
    case 'kimi':
    case 'grok':
    case 'cursor':
    case 'mistral':
      return getStaticProviderModels(provider) as CuratedModelOption[]
    case 'ollama':
      return { locked: 'Ollama models follow the local install — pick them in the App.' }
    case 'pi':
      return { locked: 'Pi upstream models follow your configured keys — pick them in the App.' }
    default:
      return { locked: 'This provider has no terminal picker yet — use the App.' }
  }
}

function offerFromRow(row: CuratedModelOption, currentKey: string): TaskWraithControlModelOffer {
  return {
    id: row.id,
    ...(row.label ? { label: row.label } : {}),
    ...(row.isDefault ? { isDefault: true } : {}),
    ...(currentKey && normalizeProviderModelKey(row.id) === currentKey ? { current: true } : {}),
    ...(row.disabled ? { disabled: true } : {}),
    ...(row.disabledReason ? { disabledReason: row.disabledReason } : {}),
    ...(row.retiresAt ? { retiresAt: row.retiresAt } : {}),
    reasoningEfforts: (row.supportedReasoningEfforts ?? [])
      .slice(0, TUI_REASONING_OFFER_LIMIT)
      .map((effort) => ({
        id: effort.reasoningEffort,
        ...(row.defaultReasoningEffort === effort.reasoningEffort ? { isDefault: true } : {}),
        ...(effort.disabled ? { disabled: true } : {}),
        ...(effort.disabledReason ? { disabledReason: effort.disabledReason } : {})
      })),
    ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {})
  }
}

/** One canonical offer projector shared by legacy control and Host v2. */
export function resolveTaskWraithThreadOffers(
  input: TaskWraithThreadOffersInput
): TaskWraithControlThreadOffers {
  const presentation = resolveTaskWraithProviderPresentation(input.provider, input.currentModel)
  const base: TaskWraithControlThreadOffers = {
    threadId: input.threadId,
    provider: presentation,
    ...(input.currentModel ? { currentModel: input.currentModel } : {}),
    ...(input.currentReasoningEffort
      ? { currentReasoningEffort: input.currentReasoningEffort }
      : {}),
    models: [],
    source: 'curated'
  }
  if (input.ensemble) {
    return {
      ...base,
      locked: 'Ensemble seats carry their own models — edit the roster in the App.'
    }
  }
  if (input.archived) {
    return { ...base, locked: 'Archived threads cannot switch models.' }
  }

  const rows = curatedRowsForProvider(presentation.runtimeProvider)
  if (!Array.isArray(rows)) return { ...base, locked: rows.locked }
  const currentKey = normalizeProviderModelKey(input.currentModel)
  const models = rows.slice(0, TUI_MODEL_OFFER_LIMIT).map((row) => offerFromRow(row, currentKey))
  if (input.currentModel && !models.some((model) => model.current)) {
    // A live-catalogue selection may sit outside static rows. Retaining the
    // current value makes "stay here" expressible without opening nomination.
    models.unshift({
      id: input.currentModel,
      ...(presentation.modelLabel ? { label: presentation.modelLabel } : {}),
      current: true,
      reasoningEfforts: input.currentReasoningEffort
        ? [{ id: input.currentReasoningEffort, isDefault: true }]
        : []
    })
  }
  return { ...base, models }
}

/** Validate a client selection against the exact offers projected right now. */
export function validateTaskWraithThreadSelection(
  offers: TaskWraithControlThreadOffers,
  selection: TaskWraithThreadSelection
): TaskWraithThreadSelectionResult {
  if (!selection.model && !selection.reasoningEffort) return { ok: true, value: {} }
  if (offers.locked) return { ok: false, error: offers.locked }

  const wantedModel = selection.model ?? offers.currentModel
  const offer = offers.models.find(
    (candidate) => candidate.id === wantedModel && !candidate.disabled
  )
  if (!offer) return { ok: false, error: 'That model is not offered for this thread.' }

  if (!selection.reasoningEffort) {
    return { ok: true, value: { model: offer.id } }
  }
  const effort = offer.reasoningEfforts.find(
    (candidate) => candidate.id === selection.reasoningEffort && !candidate.disabled
  )
  if (!effort) {
    return {
      ok: false,
      error: 'That reasoning effort is not offered for the selected model.'
    }
  }
  return { ok: true, value: { model: offer.id, reasoningEffort: effort.id } }
}
