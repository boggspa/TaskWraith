/**
 * Pi upstream model lifecycle policy shared by main-process launch gates and
 * renderer catalogue fallbacks.
 *
 * Add a model only when its upstream publishes an actual shutdown date. Keep
 * historical rows in the underlying catalogue so saved transcripts retain
 * their labels; offer surfaces and new-run gates apply this policy instead.
 */
export const PI_MODEL_RETIREMENTS: Readonly<Record<string, string>> = Object.freeze({
  // Cerebras public model catalogue, verified 2026-07-29:
  // https://inference-docs.cerebras.ai/models/overview
  'cerebras/zai-glm-4.7': '2026-08-17'
})

const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function normalizeWireModelId(wireModelId?: string | null): string {
  return String(wireModelId || '')
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
 * Date-only upstream sunsets take effect at the start of that calendar day in
 * the host's local timezone. Malformed dates fail open so bad metadata cannot
 * accidentally hide a runnable model.
 */
export function hasReachedPiModelRetirementDate(
  retirementDate: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!retirementDate || !validIsoCalendarDate(retirementDate)) return false
  const today = localCalendarDate(now)
  return today !== null && today >= retirementDate
}

export function piModelRetiresAt(wireModelId?: string | null): string | undefined {
  return PI_MODEL_RETIREMENTS[normalizeWireModelId(wireModelId)]
}

/** True on every new-run and offer surface once a dated sunset applies. */
export function isPiModelRetired(wireModelId?: string | null, now: Date = new Date()): boolean {
  const retirementDate = piModelRetiresAt(wireModelId)
  return hasReachedPiModelRetirementDate(retirementDate, now)
}

/**
 * Apply the lifecycle policy to picker/catalogue rows: future sunsets receive
 * a warning date, while reached rows disappear automatically.
 */
export function activePiModelRows<T extends { id: string }>(
  models: readonly T[],
  now: Date = new Date()
): Array<T & { retiresAt?: string }> {
  const active: Array<T & { retiresAt?: string }> = []
  for (const model of models) {
    if (isPiModelRetired(model.id, now)) continue
    const retiresAt = piModelRetiresAt(model.id)
    active.push(retiresAt ? { ...model, retiresAt } : model)
  }
  return active
}
