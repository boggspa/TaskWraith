function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Raw Kimi membership identifier from the live `/coding/v1/usages` payload. */
export function extractKimiPlanType(payload: unknown): string | undefined {
  const root = record(payload)
  const user = record(root?.user)
  const membership = record(user?.membership) ?? record(root?.membership)
  return (
    nonEmptyString(membership?.level) ||
    nonEmptyString(membership?.subType ?? membership?.sub_type) ||
    nonEmptyString(root?.subType ?? root?.sub_type)
  )
}

/**
 * Claude Code keeps the exact rate-limit multiplier in `~/.claude.json` even
 * when the OAuth credential itself only says `subscriptionType: "max"`.
 */
export function extractClaudeAccountPlanType(payload: unknown): string | undefined {
  const root = record(payload)
  const account = record(root?.oauthAccount ?? root?.oauth_account)
  return (
    nonEmptyString(account?.organizationRateLimitTier ?? account?.organization_rate_limit_tier) ||
    nonEmptyString(account?.userRateLimitTier ?? account?.user_rate_limit_tier) ||
    nonEmptyString(account?.seatTier ?? account?.seat_tier)
  )
}
