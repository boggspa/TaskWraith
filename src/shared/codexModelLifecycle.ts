/**
 * Codex model lifecycle policy shared by main-process launch gates and the
 * renderer's pre-IPC fallback catalog.
 *
 * Add a model here only when OpenAI publishes an actual shutdown date. A model
 * disappearing from `model/list` is not sufficient: discovery-hidden models
 * can remain runnable when explicitly requested.
 */
export const CODEX_MODEL_RETIREMENTS: Readonly<Record<string, string>> = Object.freeze({
  // Actual Codex-family shutdowns in OpenAI's 2026-04-22 deprecation notice.
  'gpt-5-codex': '2026-07-23',
  'gpt-5.1-codex': '2026-07-23',
  'gpt-5.1-codex-max': '2026-07-23',
  'gpt-5.1-codex-mini': '2026-07-23',
  'gpt-5.2-codex': '2026-07-23',
  // Historical dates stay here after hard retirement so diagnostics can name
  // the sunset that applied.
  'gpt-5.2': '2026-06-02',
  'gpt-5.3-codex': '2026-06-02'
  // Intentionally no gpt-5.4 / gpt-5.4-mini entry. On 2026-07-18, OpenAI's
  // model cards still marked both active; the 2026-07-23 deprecations table
  // named 5.4 mini as a substitute and neither model as a shutdown target.
})

/** Models already known to reject new requests, retained for history only. */
export const CODEX_RETIRED_MODEL_IDS: ReadonlySet<string> = new Set(['gpt-5.2', 'gpt-5.3-codex'])

const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function normalizeModelId(modelId?: string | null): string {
  return String(modelId || '')
    .trim()
    .toLowerCase()
}

function validIsoCalendarDate(value: string): boolean {
  const match = ISO_CALENDAR_DATE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function localCalendarDate(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) return null
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Date-only provider sunsets take effect at the start of that calendar day in
 * the host's local timezone. Malformed dates fail open so bad metadata cannot
 * accidentally hide a runnable model.
 */
export function hasReachedCodexRetirementDate(
  retirementDate: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!retirementDate || !validIsoCalendarDate(retirementDate)) return false
  const today = localCalendarDate(now)
  return today !== null && today >= retirementDate
}

export function codexModelRetiresAt(modelId?: string | null): string | undefined {
  return CODEX_MODEL_RETIREMENTS[normalizeModelId(modelId)]
}

/** True at every new-run and offer surface once a hard or dated sunset applies. */
export function isCodexModelRetired(modelId?: string | null, now: Date = new Date()): boolean {
  const normalized = normalizeModelId(modelId)
  if (!normalized) return false
  if (CODEX_RETIRED_MODEL_IDS.has(normalized)) return true
  return hasReachedCodexRetirementDate(CODEX_MODEL_RETIREMENTS[normalized], now)
}

/**
 * Apply the lifecycle policy to picker/catalog rows: future sunsets receive a
 * warning date, while reached and hard-retired rows disappear automatically.
 */
export function activeCodexModelRows<T extends { id: string }>(
  models: readonly T[],
  now: Date = new Date()
): Array<T & { retiresAt?: string }> {
  const active: Array<T & { retiresAt?: string }> = []
  for (const model of models) {
    if (isCodexModelRetired(model.id, now)) continue
    const retiresAt = codexModelRetiresAt(model.id)
    active.push(retiresAt ? { ...model, retiresAt } : model)
  }
  return active
}
