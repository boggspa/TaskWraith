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
  'cerebras/zai-glm-4.7': '2026-08-17',
  // OpenRouter withdrew this route; the user approved its retirement on 2026-08-28.
  'openrouter/stealth/ox-alpha': '2026-08-28',
  // Xiaomi sunset MiMo V2 Pro across all three token-plan regions in favor of
  // MiMo V2.5 and MiMo V2.5 Pro.
  'xiaomi-token-plan-cn/mimo-v2-pro': '2026-08-30',
  'xiaomi-token-plan-sgp/mimo-v2-pro': '2026-08-30',
  'xiaomi-token-plan-ams/mimo-v2-pro': '2026-08-30',
  // Xiaomi's Token Plan pricing page (https://mimo.mi.com/docs/en-US/price/token-plan,
  // read 2026-09-22) lists V2.5 and V2.5 Pro as legacy behind the V2.6 pair and
  // says both "will be officially taken offline at 10:00 on October 21, 2026
  // Beijing Time" — 02:00 UTC. The date-only convention drops the rows from the
  // start of that local calendar day, a few hours ahead of the cutoff.
  'xiaomi-token-plan-cn/mimo-v2.5': '2026-10-21',
  'xiaomi-token-plan-cn/mimo-v2.5-pro': '2026-10-21',
  'xiaomi-token-plan-sgp/mimo-v2.5': '2026-10-21',
  'xiaomi-token-plan-sgp/mimo-v2.5-pro': '2026-10-21',
  'xiaomi-token-plan-ams/mimo-v2.5': '2026-10-21',
  'xiaomi-token-plan-ams/mimo-v2.5-pro': '2026-10-21',
  // Stealth preview listed 2026-09-16. OpenRouter publishes no sunset for it
  // (the Models API carries a 2098 placeholder), so this was the seven-day
  // window the user approved on 2026-09-16, not a vendor date. The user ended
  // that window early on 2026-09-18, so the date moved in from 2026-09-23 and
  // the row is retired as of today. Saved chats keep the label.
  'openrouter/stealth/union-alpha': '2026-09-18'
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
