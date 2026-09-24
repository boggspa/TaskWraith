/**
 * Remove opaque permission-opportunity ids from arbitrary durable payloads.
 *
 * Keep this module as a process-agnostic leaf: renderer-reachable prompt
 * composition uses the same redaction as main without importing Node-only
 * approval, gateway, or tool-catalogue modules.
 */
function redactPermissionOpportunityValue(
  value: unknown,
  ancestors: Set<object>,
  depth = 0
): {
  value: unknown
  redacted: boolean
} {
  if (depth > 24) return { value: '[redacted nested value]', redacted: true }
  if (typeof value === 'string') {
    const tokenRedacted = value.replace(
      /twp_[A-Za-z0-9_-]{43}/g,
      '[redacted permission opportunity]'
    )
    const tokenWasRedacted = tokenRedacted !== value
    const trimmed = tokenRedacted.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return { value: tokenRedacted, redacted: tokenWasRedacted }
    }
    try {
      const parsed = JSON.parse(tokenRedacted) as unknown
      const next = redactPermissionOpportunityValue(parsed, ancestors, depth + 1)
      return next.redacted || tokenWasRedacted
        ? { value: JSON.stringify(next.value), redacted: true }
        : { value, redacted: false }
    } catch {
      return { value: tokenRedacted, redacted: tokenWasRedacted }
    }
  }
  if (!value || typeof value !== 'object') return { value, redacted: false }
  if (ancestors.has(value)) return { value: '[redacted circular value]', redacted: true }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      let redacted = false
      const items = value.map((entry) => {
        const next = redactPermissionOpportunityValue(entry, ancestors, depth + 1)
        redacted ||= next.redacted
        return next.value
      })
      return { value: items, redacted }
    }
    const record = value as Record<string, unknown>
    let redacted = false
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      if (key === 'permissionOpportunityId') {
        redacted = true
        result.permissionOpportunityId = '[redacted]'
        continue
      }
      const next = redactPermissionOpportunityValue(entry, ancestors, depth + 1)
      redacted ||= next.redacted
      result[key] = next.value
    }
    if (redacted) result.permissionOpportunityIdRedacted = true
    return { value: result, redacted }
  } finally {
    ancestors.delete(value)
  }
}

export function redactPermissionOpportunityIdsForDurableStorage<T>(payload: T): T {
  return redactPermissionOpportunityValue(payload, new Set<object>()).value as T
}
