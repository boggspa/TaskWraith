export function formatParticipantWorkingElapsed(startedAt: string | null, nowMs: number): string {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN
  const totalSeconds = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
    : 0
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function compactWorkingTokenOdometer(value: number): {
  value: number
  decimalPlaces: number
  suffix: string
  label: string
} {
  const tokens = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  if (tokens < 1_000) {
    return { value: tokens, decimalPlaces: 0, suffix: ' tokens', label: `${tokens} tokens` }
  }
  if (tokens < 1_000_000) {
    const scaled = Math.floor(tokens / 100)
    return {
      value: scaled,
      decimalPlaces: 1,
      suffix: 'k tokens',
      label: `${(scaled / 10).toFixed(1)}k tokens`
    }
  }
  if (tokens < 10_000_000) {
    const scaled = Math.floor(tokens / 100_000)
    return {
      value: scaled,
      decimalPlaces: 1,
      suffix: 'M tokens',
      label: `${(scaled / 10).toFixed(1)}M tokens`
    }
  }
  const scaled = Math.floor(tokens / 1_000_000)
  return { value: scaled, decimalPlaces: 0, suffix: 'M tokens', label: `${scaled}M tokens` }
}

/**
 * Tool results observed after the latest authoritative provider snapshot are
 * new context for the next invocation. Layer only that monotonic delta onto
 * the provider total; the next provider snapshot replaces the estimate.
 */
export function unreportedWorkingTokenEstimate(current: number, atSnapshot: number): number {
  const currentTokens = Number.isFinite(current) && current > 0 ? Math.trunc(current) : 0
  const snapshotTokens = Number.isFinite(atSnapshot) && atSnapshot > 0 ? Math.trunc(atSnapshot) : 0
  return Math.max(0, currentTokens - snapshotTokens)
}

/** A completed compaction outranks every earlier live snapshot. Once a token
 * epoch has a compaction boundary, only an atomic context receipt observed
 * strictly after that boundary can resume the Working counter. */
export function workingSnapshotBelongsToTokenEpoch(
  snapshot:
    | {
        provider: string
        contextUsage?: { observedAt?: number }
      }
    | null
    | undefined,
  provider: string | null | undefined,
  epochObservedAt: number | null
): boolean {
  if (!snapshot || (provider && snapshot.provider !== provider)) return false
  if (epochObservedAt === null) return true
  const snapshotObservedAt = snapshot.contextUsage?.observedAt
  return snapshotObservedAt !== undefined && snapshotObservedAt > epochObservedAt
}

export interface WorkingTokenDisplayState {
  tokenEpochKey: string
  tokens: number
}

/** Preserve the odometer's monotonic display inside an epoch, but allow a new
 * provider/model or successful-compaction epoch to reset it downward. */
export function reconcileWorkingTokenDisplayEpoch(
  current: WorkingTokenDisplayState,
  tokenEpochKey: string,
  targetTokens: number
): WorkingTokenDisplayState {
  if (current.tokenEpochKey === tokenEpochKey) return current
  return {
    tokenEpochKey,
    tokens: Number.isFinite(targetTokens) && targetTokens > 0 ? Math.trunc(targetTokens) : 0
  }
}
