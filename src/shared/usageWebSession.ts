export const USAGE_WEB_SESSION_PROVIDER_IDS = ['meta', 'muse', 'cerebras', 'qwen', 'mimo'] as const

export type UsageWebSessionProviderId = (typeof USAGE_WEB_SESSION_PROVIDER_IDS)[number]

export interface UsageWebSessionReading {
  balance?: number
  spend?: number
  currency?: string
  quotaUsedPercent?: number
  /** Muse Code subscription "Current usage" meter (dev.meta.ai/usage). */
  currentUsedPercent?: number
  /** Muse Code subscription "Weekly limit" meter; `resetAt` carries its reset. */
  weeklyUsedPercent?: number
  planName?: string
  remainingDays?: number
  resetAt?: string
  capturedAt: string
}

export interface UsageWebSessionStatus {
  configured: boolean
  encryptionAvailable: boolean
  updatedAt?: string
}

export type UsageWebSessionImportOutcome =
  | { ok: true; status: UsageWebSessionStatus }
  | {
      ok: false
      reason: 'cancelled' | 'unavailable' | 'storeFailed'
      status?: UsageWebSessionStatus
    }

export function isUsageWebSessionProviderId(value: unknown): value is UsageWebSessionProviderId {
  return (
    typeof value === 'string' &&
    (USAGE_WEB_SESSION_PROVIDER_IDS as readonly string[]).includes(value)
  )
}
