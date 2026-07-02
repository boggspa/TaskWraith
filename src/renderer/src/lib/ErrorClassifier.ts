import { isContextOverflowErrorText } from '../../../shared/contextCompaction'

export type ErrorCategory =
  | 'context_overflow'
  | 'model_capacity_exhausted'
  | 'quota_or_rate_limited'
  | 'untrusted_workspace'
  | 'permission_or_approval_required'
  | 'auth_error'
  | 'missing_cli'
  | 'unknown_error'

export function classifyError(stderr: string): ErrorCategory {
  const lower = stderr.toLowerCase()

  // Checked first: an overflow message can mention token counts that would
  // otherwise pattern-match the capacity/quota buckets, and the remedies
  // differ completely (compact/fresh-thread vs wait/reroute).
  if (isContextOverflowErrorText(stderr)) {
    return 'context_overflow'
  }

  if (
    lower.includes('model_capacity_exhausted') ||
    lower.includes('no capacity available for model') ||
    (lower.includes('resource_exhausted') && lower.includes('429')) ||
    lower.includes('status 429') ||
    lower.includes('too many requests')
  ) {
    return 'model_capacity_exhausted'
  }

  if (
    lower.includes('ratelimitexceeded') ||
    lower.includes('resource exhausted') ||
    lower.includes('quota')
  ) {
    return 'quota_or_rate_limited'
  }

  if (
    lower.includes('fataluntrustedworkspaceerror') ||
    lower.includes('untrusted workspace') ||
    lower.includes('trust workspace')
  ) {
    return 'untrusted_workspace'
  }

  if (
    lower.includes('approval required') ||
    lower.includes('permission required') ||
    lower.includes('requires confirmation') ||
    lower.includes('tool approval')
  ) {
    return 'permission_or_approval_required'
  }

  if (
    lower.includes('unauthenticated') ||
    lower.includes('authorization') ||
    lower.includes('login required')
  ) {
    return 'auth_error'
  }

  if (lower.includes('command not found') || lower.includes('enoent')) {
    return 'missing_cli'
  }

  return 'unknown_error'
}

export function redactLog(log: string): string {
  // Redact Bearer tokens, emails loosely
  let redacted = log.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
  redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL REDACTED]')
  // Hide home paths like /Users/username/.gemini -> ~/.gemini
  redacted = redacted.replace(/\/Users\/[^/ \n]+/g, '~')
  redacted = redacted.replace(/\/home\/[^/ \n]+/g, '~')
  return redacted
}
