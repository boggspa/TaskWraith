/**
 * Structured transcript payload for run-authored Blackboard mutations.
 *
 * Main persists this beside the existing plain-text status sentence. Desktop
 * promotes valid records into a provider-accented tool-call-style row; older
 * clients and text exports continue to read the sentence unchanged.
 */
export const BLACKBOARD_CHANGE_KIND = 'ensembleBlackboardChange'

/** Fresh records share the short entrance animation used by seat changes. */
export const BLACKBOARD_CHANGE_FRESH_WINDOW_MS = 120_000

export type BlackboardChangeAction = 'updated' | 'pollOpened' | 'cleaned'
export type BlackboardChangeCategory = 'decision' | 'fact' | 'risk' | 'do-not-repeat' | 'note'
export type BlackboardChangeScope = 'round' | 'session' | 'chat'

interface BlackboardChangeAttribution {
  /** Runtime provider that made the tool call. */
  provider: string
  /** Frozen user-facing provider/upstream brand label for accessibility. */
  displayProviderLabel: string
  /** Frozen CSS hue slug (for example `claude`, `alibaba`, or `deepseek`). */
  displayHueClass: string
  changedAt: string
}

export interface BlackboardEntryUpdatedPayload extends BlackboardChangeAttribution {
  action: 'updated'
  key: string
  category: BlackboardChangeCategory
  scope: BlackboardChangeScope
}

export interface BlackboardPollOpenedPayload extends BlackboardChangeAttribution {
  action: 'pollOpened'
  key: string
  category: BlackboardChangeCategory
  scope: BlackboardChangeScope
  optionCount: number
}

export interface BlackboardCleanedPayload extends BlackboardChangeAttribution {
  action: 'cleaned'
  removedCount: number
}

export type BlackboardChangePayload =
  | BlackboardEntryUpdatedPayload
  | BlackboardPollOpenedPayload
  | BlackboardCleanedPayload

const CATEGORIES = new Set<BlackboardChangeCategory>([
  'decision',
  'fact',
  'risk',
  'do-not-repeat',
  'note'
])
const SCOPES = new Set<BlackboardChangeScope>(['round', 'session', 'chat'])
const MAX_KEY_LENGTH = 80
const MAX_POLL_OPTIONS = 6
const MAX_REMOVED_ENTRIES = 60

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

/**
 * Persisted metadata is untrusted data. Invalid records fall back to their
 * carrier sentence instead of painting misleading mutation details or an
 * attacker-controlled CSS custom-property reference.
 */
export function isBlackboardChangePayload(value: unknown): value is BlackboardChangePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<BlackboardChangePayload>
  if (
    !boundedText(payload.provider, 64) ||
    !boundedText(payload.displayProviderLabel, 80) ||
    !boundedText(payload.displayHueClass, 64) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.displayHueClass) ||
    !boundedText(payload.changedAt, 64) ||
    !Number.isFinite(Date.parse(payload.changedAt))
  ) {
    return false
  }

  if (payload.action === 'cleaned') {
    return (
      Number.isInteger(payload.removedCount) &&
      (payload.removedCount ?? 0) > 0 &&
      (payload.removedCount ?? 0) <= MAX_REMOVED_ENTRIES
    )
  }

  if (payload.action !== 'updated' && payload.action !== 'pollOpened') return false
  if (
    !boundedText(payload.key, MAX_KEY_LENGTH) ||
    !CATEGORIES.has(payload.category as BlackboardChangeCategory) ||
    !SCOPES.has(payload.scope as BlackboardChangeScope)
  ) {
    return false
  }
  if (payload.action === 'pollOpened') {
    return (
      Number.isInteger(payload.optionCount) &&
      (payload.optionCount ?? 0) >= 2 &&
      (payload.optionCount ?? 0) <= MAX_POLL_OPTIONS
    )
  }
  return true
}
