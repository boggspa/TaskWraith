/**
 * Local, per-thread preference learning for composer suggestions.
 *
 * This deliberately stores aggregate counts only. User prompts are inspected
 * transiently to update a tiny style profile, then discarded; no prompt text,
 * telemetry, model output, or workspace content is retained here.
 */

import type { ComposerSuggestionCandidate, ComposerSuggestionTrigger } from './composerSuggestion'

const STORAGE_PREFIX = 'taskwraith.composerSuggestionPersonalization.v1:'
const MAX_TRIGGER_COUNT = 10_000

export interface ComposerSuggestionFeedbackStats {
  shown: number
  accepted: number
  dismissed: number
}

export interface ComposerSuggestionStyleProfile {
  sentPrompts: number
  questionPrompts: number
  tersePrompts: number
  acceptedSuggestionSends: number
  editedAcceptedSuggestionSends: number
}

export interface ComposerSuggestionPersonalizationProfile {
  schemaVersion: 1
  byTrigger: Partial<Record<ComposerSuggestionTrigger, ComposerSuggestionFeedbackStats>>
  style: ComposerSuggestionStyleProfile
}

export type ComposerSuggestionFeedbackAction = 'shown' | 'accepted' | 'dismissed'

export type ComposerSuggestionSelectionSource =
  | 'deterministic'
  | 'local-preference'
  | 'foundation-model-proposal'

export interface ComposerSuggestionSelection {
  candidate: ComposerSuggestionCandidate
  source: ComposerSuggestionSelectionSource
}

export function emptyComposerSuggestionPersonalizationProfile(): ComposerSuggestionPersonalizationProfile {
  return {
    schemaVersion: 1,
    byTrigger: {},
    style: {
      sentPrompts: 0,
      questionPrompts: 0,
      tersePrompts: 0,
      acceptedSuggestionSends: 0,
      editedAcceptedSuggestionSends: 0
    }
  }
}

export function readComposerSuggestionPersonalization(
  chatId: string | null | undefined
): ComposerSuggestionPersonalizationProfile {
  if (!chatId || typeof window === 'undefined')
    return emptyComposerSuggestionPersonalizationProfile()
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(chatId)) || '') as unknown
    return normalizeProfile(parsed)
  } catch {
    return emptyComposerSuggestionPersonalizationProfile()
  }
}

export function recordComposerSuggestionFeedback(
  chatId: string | null | undefined,
  trigger: ComposerSuggestionTrigger,
  action: ComposerSuggestionFeedbackAction
): ComposerSuggestionPersonalizationProfile {
  const next = updateComposerSuggestionFeedback(
    readComposerSuggestionPersonalization(chatId),
    trigger,
    action
  )
  persistProfile(chatId, next)
  return next
}

/**
 * Update style counts from a user-authored prompt. The text is never stored;
 * this only records a few coarse writing preferences for the current thread.
 */
export function recordComposerSuggestionSentPrompt(
  chatId: string | null | undefined,
  text: string,
  acceptedSuggestionText?: string | null
): ComposerSuggestionPersonalizationProfile {
  const next = updateComposerSuggestionStyle(
    readComposerSuggestionPersonalization(chatId),
    text,
    acceptedSuggestionText
  )
  persistProfile(chatId, next)
  return next
}

export function updateComposerSuggestionFeedback(
  profile: ComposerSuggestionPersonalizationProfile,
  trigger: ComposerSuggestionTrigger,
  action: ComposerSuggestionFeedbackAction
): ComposerSuggestionPersonalizationProfile {
  const current = profile.byTrigger[trigger] || { shown: 0, accepted: 0, dismissed: 0 }
  const nextStats = {
    ...current,
    [action]: boundedCount(current[action] + 1)
  }
  return {
    ...profile,
    byTrigger: { ...profile.byTrigger, [trigger]: nextStats }
  }
}

export function updateComposerSuggestionStyle(
  profile: ComposerSuggestionPersonalizationProfile,
  text: string,
  acceptedSuggestionText?: string | null
): ComposerSuggestionPersonalizationProfile {
  const normalized = normalizeForMeasurement(text)
  if (!normalized) return profile
  const words = normalized.split(' ')
  const exactAccepted =
    acceptedSuggestionText && normalizeForMeasurement(acceptedSuggestionText) === normalized
  const wasAccepted = Boolean(acceptedSuggestionText)
  const style = profile.style
  return {
    ...profile,
    style: {
      sentPrompts: boundedCount(style.sentPrompts + 1),
      questionPrompts: boundedCount(style.questionPrompts + (isQuestion(normalized) ? 1 : 0)),
      tersePrompts: boundedCount(style.tersePrompts + (words.length <= 8 ? 1 : 0)),
      acceptedSuggestionSends: boundedCount(style.acceptedSuggestionSends + (wasAccepted ? 1 : 0)),
      editedAcceptedSuggestionSends: boundedCount(
        style.editedAcceptedSuggestionSends + (wasAccepted && !exactAccepted ? 1 : 0)
      )
    }
  }
}

/**
 * A bounded contextual-bandit-style ranker. Hard candidates (fresh picker
 * intent and all-seat failure recovery) remain absolute; other candidates can
 * move by at most 48 points based on the user's explicit feedback. A valid
 * Foundation Models proposal gets a modest 24-point boost, never authority.
 */
export function selectPersonalizedComposerSuggestion(
  candidates: readonly ComposerSuggestionCandidate[],
  profile: ComposerSuggestionPersonalizationProfile,
  proposedCandidateId?: string | null
): ComposerSuggestionSelection | null {
  if (candidates.length === 0) return null
  const hard = candidates.filter((candidate) => candidate.hard)
  if (hard.length > 0) {
    return {
      candidate: hard.reduce((best, candidate) =>
        candidate.baselineScore > best.baselineScore ? candidate : best
      ),
      source: 'deterministic'
    }
  }

  const baseline = candidates[0]
  let winner = baseline
  let winnerScore = candidateScore(baseline, profile, proposedCandidateId)
  for (const candidate of candidates.slice(1)) {
    const score = candidateScore(candidate, profile, proposedCandidateId)
    if (score > winnerScore) {
      winner = candidate
      winnerScore = score
    }
  }

  if (winner.suggestion.id === proposedCandidateId && winner !== baseline) {
    return { candidate: winner, source: 'foundation-model-proposal' }
  }
  return {
    candidate: winner,
    source: winner === baseline ? 'deterministic' : 'local-preference'
  }
}

/** Style rendering is intentionally limited to the continuation template. */
export function personalizeComposerSuggestionText(
  candidate: ComposerSuggestionCandidate,
  profile: ComposerSuggestionPersonalizationProfile
): string {
  const text = candidate.suggestion.text
  if (candidate.suggestion.trigger !== 'task-continuation') return text
  if (profile.style.sentPrompts < 5 || questionRatio(profile.style) < 0.7) return text
  const prefix = 'Continue with: '
  if (!text.startsWith(prefix)) return text
  const subject = lowerCaseSentenceStart(text.slice(prefix.length))
  return subject ? `Can we continue with ${subject}?` : text
}

export function clearComposerSuggestionPersonalization(chatId: string | null | undefined): void {
  if (!chatId || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(storageKey(chatId))
  } catch {
    // Personalization is optional; a disabled localStorage must not affect the composer.
  }
}

function candidateScore(
  candidate: ComposerSuggestionCandidate,
  profile: ComposerSuggestionPersonalizationProfile,
  proposedCandidateId?: string | null
): number {
  const stats = profile.byTrigger[candidate.suggestion.trigger]
  const localDelta = stats ? clamp((stats.accepted - stats.dismissed) * 12, -48, 48) : 0
  const modelDelta = candidate.suggestion.id === proposedCandidateId ? 24 : 0
  return candidate.baselineScore + localDelta + modelDelta
}

function normalizeProfile(value: unknown): ComposerSuggestionPersonalizationProfile {
  if (!value || typeof value !== 'object') return emptyComposerSuggestionPersonalizationProfile()
  const record = value as Partial<ComposerSuggestionPersonalizationProfile>
  const style = record.style || ({} as Partial<ComposerSuggestionStyleProfile>)
  const profile = emptyComposerSuggestionPersonalizationProfile()
  for (const trigger of [
    'picker-dismissed',
    'task-continuation',
    'lane-failed',
    'uncommitted-changes'
  ] as const) {
    const stats = record.byTrigger?.[trigger]
    if (!stats) continue
    profile.byTrigger[trigger] = {
      shown: boundedCount(stats.shown),
      accepted: boundedCount(stats.accepted),
      dismissed: boundedCount(stats.dismissed)
    }
  }
  profile.style = {
    sentPrompts: boundedCount(style.sentPrompts),
    questionPrompts: boundedCount(style.questionPrompts),
    tersePrompts: boundedCount(style.tersePrompts),
    acceptedSuggestionSends: boundedCount(style.acceptedSuggestionSends),
    editedAcceptedSuggestionSends: boundedCount(style.editedAcceptedSuggestionSends)
  }
  return profile
}

function persistProfile(
  chatId: string | null | undefined,
  profile: ComposerSuggestionPersonalizationProfile
): void {
  if (!chatId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(chatId), JSON.stringify(profile))
  } catch {
    // The deterministic suggestion system must continue when local storage is unavailable.
  }
}

function storageKey(chatId: string): string {
  return `${STORAGE_PREFIX}${chatId}`
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_TRIGGER_COUNT, Math.round(value)))
    : 0
}

function normalizeForMeasurement(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isQuestion(text: string): boolean {
  return /\?$/.test(text) || /^(can|could|would|should|why|what|when|where|how)\b/i.test(text)
}

function questionRatio(style: ComposerSuggestionStyleProfile): number {
  return style.sentPrompts > 0 ? style.questionPrompts / style.sentPrompts : 0
}

function lowerCaseSentenceStart(value: string): string {
  if (!value) return ''
  const first = value[0]
  const second = value[1] || ''
  // Preserve acronyms and product names such as API or TaskWraith.
  if (!/[A-Z]/.test(first) || (second && /[A-Z]/.test(second))) return value
  return `${first.toLowerCase()}${value.slice(1)}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
