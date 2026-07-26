/**
 * Local acceptance log for composer prefill suggestions.
 *
 * Exists so the feature can be judged rather than believed in. Each
 * trigger in `composerSuggestion.ts` is a guess about what the user
 * wants next; without a per-trigger accept rate there is no way to
 * tell a suggestion that earns its pixels from one that is quietly
 * ignored a hundred times a week, and no evidence with which to
 * delete the latter.
 *
 * It is also the baseline a generative predictor would have to beat.
 * A trigger sitting at a low accept rate is where a template can't
 * fill the blank and a model might — pointed at one measurable gap
 * rather than sprayed across the whole composer.
 *
 * Renderer-local and never transmitted: this is a bounded ring in
 * `localStorage`, holding trigger names and coarse outcomes. No draft
 * text, no prompt content, no model output.
 */

import type { ComposerSuggestionTrigger } from './composerSuggestion'

const STORAGE_KEY = 'taskwraith.composerSuggestionLog.v1'

/** Ring capacity. Roughly a fortnight of heavy use; costs ~20KB. */
const MAX_ENTRIES = 500

export type ComposerSuggestionAction = 'shown' | 'accepted' | 'dismissed'

export interface ComposerSuggestionLogEntry {
  /** Epoch ms. */
  at: number
  trigger: ComposerSuggestionTrigger
  action: ComposerSuggestionAction
}

export interface ComposerSuggestionTriggerStats {
  shown: number
  accepted: number
  dismissed: number
  /** accepted / shown, or 0 when never shown. */
  acceptRate: number
}

function isLogEntry(value: unknown): value is ComposerSuggestionLogEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<ComposerSuggestionLogEntry>
  return (
    typeof entry.at === 'number' &&
    typeof entry.trigger === 'string' &&
    (entry.action === 'shown' || entry.action === 'accepted' || entry.action === 'dismissed')
  )
}

export function readComposerSuggestionLog(): ComposerSuggestionLogEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isLogEntry)
  } catch {
    return []
  }
}

/**
 * Append one outcome. Fails silent by design — a full or unavailable
 * storage quota must never surface as a composer error, since the log
 * is diagnostic and the suggestion itself still works without it.
 */
export function recordComposerSuggestionEvent(
  trigger: ComposerSuggestionTrigger,
  action: ComposerSuggestionAction,
  at: number = Date.now()
): void {
  if (typeof window === 'undefined') return
  try {
    const next = readComposerSuggestionLog()
    next.push({ at, trigger, action })
    const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    /* diagnostic only — never break the composer over it */
  }
}

export function readComposerSuggestionStats(): Record<string, ComposerSuggestionTriggerStats> {
  const stats: Record<string, ComposerSuggestionTriggerStats> = {}
  for (const entry of readComposerSuggestionLog()) {
    const bucket = (stats[entry.trigger] ??= {
      shown: 0,
      accepted: 0,
      dismissed: 0,
      acceptRate: 0
    })
    if (entry.action === 'shown') bucket.shown += 1
    else if (entry.action === 'accepted') bucket.accepted += 1
    else bucket.dismissed += 1
  }
  for (const bucket of Object.values(stats)) {
    bucket.acceptRate = bucket.shown > 0 ? bucket.accepted / bucket.shown : 0
  }
  return stats
}

export function clearComposerSuggestionLog(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* no-op */
  }
}
