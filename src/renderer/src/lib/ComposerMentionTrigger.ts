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
import { findAllMentions } from '../../../main/services/EnsembleMentionAlias'

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
 *      Legacy from the first pass of the @-mention work — kept so
 *      historical prompts still route correctly.
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
  // Markdown form — always wins because the link unambiguously
  // carries the participant id. Multiple explicit links mean the
  // prompt is addressed to multiple participants, so leave it as a
  // normal ensemble round.
  const linkMatches = Array.from(prompt.matchAll(/\]\(ensemble-dm:\/\/([^)\s]+)\)/g))
    .map((match) => match[1])
    .filter(Boolean)
  const uniqueLinkTargets = [...new Set(linkMatches)]
  if (uniqueLinkTargets.length === 1) {
    const linkedParticipant = participants?.find(
      (participant) => participant.id === uniqueLinkTargets[0]
    )
    if (linkedParticipant?.stageRole === 'background') return null
    return uniqueLinkTargets[0]
  }
  if (uniqueLinkTargets.length > 1) return null

  if (!participants || participants.length === 0) return null
  // Shared multi-word matcher — same logic that powers the composer
  // overlay tokeniser AND the orchestrator's auto-promotion path, so
  // a prompt that says `@GPT 5.5 take a look` routes identically
  // whether the renderer or the main process is doing the resolving.
  // EnsembleDmCandidate is a structural subset of EnsembleParticipant;
  // cast through unknown because the matcher only reads id /
  // provider / role / model.
  const mentions = findAllMentions(
    prompt,
    participants as unknown as Parameters<typeof findAllMentions>[1]
  )
  const participantMentions = mentions.filter((match) => match.kind === 'participant')
  if (participantMentions.some((match) => match.participant.stageRole === 'background')) {
    return null
  }
  const participantIds = [
    ...new Set(
      participantMentions.map((match) => match.participant.id)
    )
  ]
  // User mentions are informational in this send path. They do not
  // create a DM target.
  return participantIds.length === 1 ? participantIds[0] : null
}
