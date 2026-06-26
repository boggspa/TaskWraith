export interface PositiveIntArgOptions {
  min?: number
  max?: number
  fallback: number
}

/**
 * Return the raw remainder after the first whitespace-delimited argument token.
 *
 * This is useful for command parsers that need "arg1" and optional
 * trailing content (e.g. "/compact foo bar baz" -> "bar baz").
 */
export function remainingTextAfterFirstArg(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  const match = trimmed.match(/^\S+(?:\s+(.*))?$/)
  return match?.[1]?.trim() || ''
}

/**
 * Parse `/on`, `/off`, `/toggle`, or bare command toggle intent.
 * - "on" => true
 * - "off" => false
 * - "toggle" => !current
 * - missing/unknown => current (unchanged)
 */
export function parseSlashToggleArg(input: string, current: boolean): boolean {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return !current

  const firstToken = normalized.split(/\s+/)[0]
  if (firstToken === 'on') return true
  if (firstToken === 'off') return false
  if (firstToken === 'toggle') return !current

  return current
}

/**
 * Parse a positive integer from the first token.
 *
 * Returns a clamped value when in-range constraints are provided.
 * Falls back when the first token is missing, not an integer, non-positive,
 * or otherwise unparsable.
 */
export function parsePositiveIntArg(input: string, options: PositiveIntArgOptions): number {
  const { min, max, fallback } = options
  const firstToken = input.trim().split(/\s+/)[0]

  if (!firstToken || !/^\d+$/.test(firstToken)) return fallback

  const parsed = Number.parseInt(firstToken, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback

  if (typeof min === 'number' && Number.isFinite(min) && parsed < min) return min
  if (typeof max === 'number' && Number.isFinite(max) && parsed > max) return max

  return parsed
}
