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
