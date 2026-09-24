/**
 * Saved custom model IDs, per provider.
 *
 * The composer's "Custom model ID" row hands the user a free-text field. That
 * field holds exactly one value and forgets it the moment the chat moves to a
 * curated model, so running a locally installed Ollama tag meant retyping the
 * tag every time. These helpers back a small per-provider list instead: what
 * the user types is remembered, listed in the picker beside the curated rows,
 * and removable.
 *
 * Kept provider-neutral and free of renderer/main imports so both sides share
 * one definition of what a saved id is and how a picker row encodes it.
 */

/** Persisted shape: provider id to saved model ids, oldest first. */
export type CustomProviderModels = Record<string, string[]>

/**
 * Picker rows for saved ids are namespaced so they cannot collide with a
 * catalogue model id, and so the composer can tell "user picked a saved custom
 * model" apart from "user picked the row that opens the text field" (`custom`).
 */
export const CUSTOM_MODEL_ROW_PREFIX = 'custom:'

/** The picker row that reveals the free-text field. */
export const CUSTOM_MODEL_ENTRY_ID = 'custom'

/** Beyond this the picker stops being a shortlist; the oldest id is dropped. */
export const MAX_CUSTOM_MODELS_PER_PROVIDER = 20

const MAX_MODEL_ID_LENGTH = 200

/** True when the string carries a C0/C7 control byte. */
function hasControlByte(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * A usable model id: trimmed, single-token, no control bytes, and not the
 * `custom` sentinel itself. Returns '' for anything unusable so callers can
 * treat "nothing to save" as one case.
 */
export function normalizeCustomModelId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_MODEL_ID_LENGTH) return ''
  if (trimmed === CUSTOM_MODEL_ENTRY_ID) return ''
  // A model id is a single wire token. Interior whitespace or a control byte
  // means the value came from a paste accident, not from a tag a daemon would
  // accept, and saving it would put an unpickable row in the list forever.
  if (/\s/.test(trimmed)) return ''
  if (hasControlByte(trimmed)) return ''
  return trimmed
}

/** Encode a saved id as a picker row id. */
export function customModelRowId(modelId: string): string {
  return `${CUSTOM_MODEL_ROW_PREFIX}${modelId}`
}

/**
 * Decode a picker row id, or '' when the row is not a saved custom model.
 * Note the id itself normally contains ':' (`qwen3:4b`), so this strips the
 * leading prefix rather than splitting on the separator.
 */
export function customModelIdFromRowId(rowId: unknown): string {
  if (typeof rowId !== 'string') return ''
  if (!rowId.startsWith(CUSTOM_MODEL_ROW_PREFIX)) return ''
  return normalizeCustomModelId(rowId.slice(CUSTOM_MODEL_ROW_PREFIX.length))
}

/** True for the row that opens the free-text field, not for a saved id. */
export function isCustomModelEntryId(modelId: unknown): boolean {
  return modelId === CUSTOM_MODEL_ENTRY_ID
}

/** Saved ids for one provider, oldest first. Never returns the caller's array. */
export function customModelsForProvider(
  store: CustomProviderModels | null | undefined,
  provider: string
): string[] {
  const saved = store?.[provider]
  if (!Array.isArray(saved)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of saved) {
    const id = normalizeCustomModelId(entry)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.slice(-MAX_CUSTOM_MODELS_PER_PROVIDER)
}

/**
 * Remember `modelId` for `provider`. Re-saving an id already present keeps its
 * position rather than reordering the list under the user's cursor; a new id
 * appends and evicts the oldest once the cap is reached.
 *
 * Returns a store equal to the input when nothing would change, so a caller can
 * compare and skip a pointless settings write.
 */
export function addCustomProviderModel(
  store: CustomProviderModels | null | undefined,
  provider: string,
  modelId: unknown
): CustomProviderModels {
  const base = sanitizeCustomProviderModels(store)
  const id = normalizeCustomModelId(modelId)
  if (!id || !provider) return base
  const current = customModelsForProvider(base, provider)
  if (current.includes(id)) return base
  const next = [...current, id].slice(-MAX_CUSTOM_MODELS_PER_PROVIDER)
  return { ...base, [provider]: next }
}

/** Forget one saved id. Returns an equal store when it was not there. */
export function removeCustomProviderModel(
  store: CustomProviderModels | null | undefined,
  provider: string,
  modelId: unknown
): CustomProviderModels {
  const base = sanitizeCustomProviderModels(store)
  const id = normalizeCustomModelId(modelId)
  if (!id || !provider) return base
  const current = customModelsForProvider(base, provider)
  if (!current.includes(id)) return base
  const next = current.filter((entry) => entry !== id)
  if (next.length > 0) return { ...base, [provider]: next }
  const { [provider]: _dropped, ...rest } = base
  return rest
}

/**
 * Coerce persisted/IPC input into the stored shape. Anything unrecognised is
 * dropped rather than thrown on: this feeds a picker, and a malformed settings
 * blob must not cost the user their composer.
 */
export function sanitizeCustomProviderModels(raw: unknown): CustomProviderModels {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: CustomProviderModels = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!provider) continue
    const ids = customModelsForProvider({ [provider]: value as string[] }, provider)
    if (ids.length > 0) out[provider] = ids
  }
  return out
}
