/**
 * Composer mention trigger detection.
 *
 * Two triggers, each preceded by whitespace or start-of-line so they
 * don't fire inside ordinary words like `email@example.com` or
 * `flag--@disabled`:
 *
 *   - `@<query>` → mention trigger. In normal chats this surfaces
 *     active sub-agents; in ensemble chats it surfaces participants
 *     so the user can DM-target a specific provider for the next
 *     round (routed via `dmTargetParticipantId`).
 *   - `-@<query>` → file mention trigger. Lists workspace files
 *     and already-granted external paths — the legacy behaviour
 *     that `@` used to own before participant-DM mentions took
 *     it over.
 *
 * The order matters: file trigger checked first so `-@` doesn't
 * accidentally match the plain `@` regex (the regex requires
 * whitespace before `@`, which `-` doesn't satisfy, so the
 * disambiguation is mechanical — but checking explicitly leaves no
 * room for someone tightening the regex later and creating a
 * silent overlap).
 */
import { resolveEnsembleDmTargetForDispatch } from '../../../main/services/EnsembleMentionAlias'

export type ComposerMentionTriggerKind = 'mention' | 'file-mention'

export interface ComposerMentionTrigger {
  /** Index in `value` where the trigger character(s) begin. The
   * caller uses this + `triggerLength` + `query.length` to splice
   * the inserted mention text in place. */
  anchorIndex: number
  /** 1 for `@`, 2 for `-@`. The pick handler needs this to know
   * how many characters to strip when replacing the trigger with
   * the picked mention's markdown. */
  triggerLength: number
  kind: ComposerMentionTriggerKind
  query: string
}

export function parseComposerMentionTrigger(
  value: string,
  caretIndex: number = value.length
): ComposerMentionTrigger | null {
  const caret = Math.max(0, Math.min(caretIndex, value.length))
  const before = value.slice(0, caret)

  // File trigger: `-@<query>` preceded by whitespace or start-of-line.
  // Anchor lands at the index of the `-`.
  const fileMatch = before.match(/(^|\s)-@([^\s@]*)$/)
  if (fileMatch) {
    return {
      anchorIndex: caret - (fileMatch[2].length + 2),
      triggerLength: 2,
      kind: 'file-mention',
      query: fileMatch[2]
    }
  }

  // Plain mention: `@<query>` preceded by whitespace or start-of-line.
  // Anchor lands at the index of the `@`.
  const mentionMatch = before.match(/(^|\s)@([^\s@]*)$/)
  if (mentionMatch) {
    return {
      anchorIndex: caret - (mentionMatch[2].length + 1),
      triggerLength: 1,
      kind: 'mention',
      query: mentionMatch[2]
    }
  }
  return null
}

export function formatComposerPathMention(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  if (/\s/.test(trimmed)) return `${JSON.stringify(trimmed)} `
  return `${trimmed} `
}

/**
 * Build a legacy durable participant marker. Retried/persisted prompts may
 * still contain this form, but the live composer picker now keeps its exact
 * identity separately and writes only visible plain `@Role` text to the
 * textarea.
 */
export function formatEnsembleDmMention(label: string, participantId: string): string {
  const trimmedParticipantId = participantId.trim()
  if (!trimmedParticipantId) return ''
  const trimmedLabel = label.trim() || trimmedParticipantId
  const escapedLabel = trimmedLabel.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
  return `[@${escapedLabel}](ensemble-dm://${trimmedParticipantId}) `
}

/**
 * Resolver shape for the participant lookup. Mirrors the subset of
 * `EnsembleParticipant` the matcher actually reads. Now includes
 * `model` so the shared mention-alias resolver can match `@GPT 5.5`,
 * `@Sonnet 4.7`, `@Flash Lite`, etc. — useful when 1.0.4 introduces
 * same-provider ensembles where role/provider alone won't
 * disambiguate.
 */
export interface EnsembleDmCandidate {
  id: string
  role?: string
  provider: string
  model?: string
  stageRole?: string
  enabled?: boolean
}

/**
 * Extract the first ensemble-dm participant id mentioned in a
 * composer prompt. Used on send to translate an `@participant`
 * mention into the `dmTargetParticipantId` field on the run
 * payload — the orchestrator scopes the round to just that
 * participant when set.
 *
 * Two recognised forms (in priority order):
 *
 *   1. Markdown link form `[@Role](ensemble-dm://participant-id)`.
 *      This remains supported for legacy retry/persisted prompts.
 *
 *   2. Plain `@Token` (multi-word + model-name aliases supported).
 *      Resolved via the shared `EnsembleMentionAlias` module so the
 *      composer's DM routing stays in lockstep with the orchestrator's
 *      auto-promotion path and the overlay tokeniser. Recognises
 *      `@codex` / `@Planner` (legacy single-token), plus the new
 *      `@GPT 5.5` / `@Sonnet 4.7` / `@Flash Lite` / `@Kimi K2.7 Coding`
 *      model-name forms.
 *
 * Returns a DM target only when the prompt addresses exactly one participant.
 * Multiple participant mentions are a panel-routing request, not a DM.
 */
export function extractFirstEnsembleDmTarget(
  prompt: string,
  participants?: EnsembleDmCandidate[]
): string | null {
  // This renderer result only controls optimistic fan-out UI and becomes an
  // advisory IPC field. MAIN runs this resolver again against its current
  // roster before dispatching any participant.
  const resolution = resolveEnsembleDmTargetForDispatch({
    text: prompt,
    participants:
      (participants as unknown as Parameters<
        typeof resolveEnsembleDmTargetForDispatch
      >[0]['participants']) ?? []
  })
  if (resolution.kind === 'target') return resolution.participantId
  // Legacy callers used the structured link as the identity carrier before
  // they had a roster snapshot. MAIN never takes this branch: desktop/remote
  // dispatch always provide the canonical roster and reject stale ids.
  if (resolution.kind === 'invalid-structured-target' && !participants?.length) {
    return resolution.participantId
  }
  return null
}
