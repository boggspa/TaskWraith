import type { EnsembleParticipant, ProviderId } from '../../../main/store/types'
import {
  findAllMentions,
  resolvePhraseToParticipant
} from '../../../main/services/EnsembleMentionAlias'
import { resolveProviderHueClass } from './ollamaDisplayBrand'

/**
 * Shared `@Token` mention tokeniser. Used by:
 *   - `ComposerHighlightOverlay` (composer textarea overlay)
 *   - `MentionHighlightedText` (user message bubbles + queued rows)
 *
 * Boundary + alias rules now live in
 * `src/main/services/EnsembleMentionAlias.ts` so the same logic
 * powers the renderer-side overlay AND the orchestrator's auto-
 * promotion path — no more drift between the two when we extend
 * the matcher (e.g. multi-word model aliases).
 *
 * Resolution priority (longest-prefix wins):
 *   1. 4-word phrase ("gpt 5 codex spark")
 *   2. 3-word phrase ("kimi k2 thinking")
 *   3. 2-word phrase ("gpt 5.5", "sonnet 4.7", "flash lite")
 *   4. 1-word phrase ("codex", "claude", "planner", "5.5")
 *
 * Reserved words (me/self/user/human) never resolve — agents
 * referencing the user shouldn't paint as a participant.
 */

export type MentionTokenSegment =
  | { kind: 'text'; text: string }
  | {
      /** Participant mention — renders with the participant's
       * provider tint via `var(--provider-{name}-color)`. */
      kind: 'mention'
      text: string
      participant: EnsembleParticipant
      provider: ProviderId
      /** CSS hue class. Equals `provider` for most providers, but
       * Ollama-backed display brands resolve to their spoofed upstream
       * brand class (e.g. `alibaba`) so the chip wears the brand hue. */
      providerClass: string
    }
  | {
      /** 1.0.4 — user-mention (`@user` / `@human` / `@you`).
       * Renders with `var(--user-bubble-color)` so the chip echoes
       * the user's chosen identity colour rather than any
       * provider. No `participant` field. */
      kind: 'user-mention'
      text: string
    }

interface StructuredParticipantMention {
  sourceStart: number
  sourceEnd: number
  text: string
  participant: EnsembleParticipant
}

// Picker-selected participants retain their exact id in the draft as a custom
// markdown link. That identity is essential when roles or providers collide,
// but it is transport syntax rather than user-facing composer text. Treat the
// full link as one mention segment so the overlay renders only `@Role`.
const STRUCTURED_PARTICIPANT_MENTION_REGEX =
  /\[@((?:\\.|[^\]\\])+)\]\(ensemble-dm:\/\/([^\s)]+)\)/g

function unescapeStructuredMentionLabel(label: string): string {
  return label.replace(/\\([\\\]])/g, '$1').trim()
}

function findStructuredParticipantMentions(
  value: string,
  participants: EnsembleParticipant[]
): StructuredParticipantMention[] {
  if (!value.includes('ensemble-dm://')) return []
  const matches: StructuredParticipantMention[] = []
  STRUCTURED_PARTICIPANT_MENTION_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = STRUCTURED_PARTICIPANT_MENTION_REGEX.exec(value)) !== null) {
    const structuredMatch = match
    const participant = participants.find((candidate) => candidate.id === structuredMatch[2])
    if (!participant) continue
    matches.push({
      sourceStart: structuredMatch.index,
      sourceEnd: structuredMatch.index + structuredMatch[0].length,
      text: `@${unescapeStructuredMentionLabel(structuredMatch[1])}`,
      participant
    })
  }
  return matches
}

/**
 * Legacy single-token resolver. Kept for callers that already
 * extracted the bare token (no leading `@`, no multi-word phrase).
 * New code should prefer the multi-word `findFirstMention` /
 * `findAllMentions` path via this module's higher-level functions.
 */
export function resolveParticipantToken(
  token: string,
  participants: EnsembleParticipant[]
): EnsembleParticipant | null {
  return resolvePhraseToParticipant(token, participants)
}

export function tokeniseMentions(
  value: string,
  participants: EnsembleParticipant[]
): MentionTokenSegment[] {
  if (!value) return []
  // User-mentions resolve even when the ensemble has no
  // participants, so we don't short-circuit on participants.length
  // anymore — only on the absence of `@` in the value.
  if (!value.includes('@')) {
    return [{ kind: 'text', text: value }]
  }
  const structuredMentions = findStructuredParticipantMentions(value, participants)
  const mentions = findAllMentions(value, participants).filter(
    (mention) =>
      !structuredMentions.some(
        (structured) =>
          mention.atIndex >= structured.sourceStart && mention.atIndex < structured.sourceEnd
      )
  )
  if (structuredMentions.length === 0 && mentions.length === 0) {
    return [{ kind: 'text', text: value }]
  }
  const resolvedMentions = [
    ...structuredMentions.map((structured) => ({ kind: 'structured' as const, ...structured })),
    ...mentions.map((mention) => ({ kind: 'plain' as const, mention }))
  ].sort((left, right) => {
    const leftStart = left.kind === 'structured' ? left.sourceStart : left.mention.atIndex
    const rightStart = right.kind === 'structured' ? right.sourceStart : right.mention.atIndex
    return leftStart - rightStart
  })
  const segments: MentionTokenSegment[] = []
  let lastIndex = 0
  for (const resolved of resolvedMentions) {
    if (resolved.kind === 'structured') {
      if (resolved.sourceStart > lastIndex) {
        segments.push({ kind: 'text', text: value.slice(lastIndex, resolved.sourceStart) })
      }
      segments.push({
        kind: 'mention',
        text: resolved.text,
        participant: resolved.participant,
        provider: resolved.participant.provider,
        providerClass: resolveProviderHueClass(
          resolved.participant.provider,
          resolved.participant.model
        )
      })
      lastIndex = resolved.sourceEnd
      continue
    }
    const match = resolved.mention
    if (match.atIndex > lastIndex) {
      segments.push({ kind: 'text', text: value.slice(lastIndex, match.atIndex) })
    }
    if (match.kind === 'user') {
      segments.push({
        kind: 'user-mention',
        text: `@${match.text}`
      })
    } else {
      segments.push({
        kind: 'mention',
        text: `@${match.text}`,
        participant: match.participant,
        provider: match.participant.provider,
        providerClass: resolveProviderHueClass(
          match.participant.provider,
          match.participant.model
        )
      })
    }
    lastIndex = match.atIndex + match.consumedLength
  }
  if (lastIndex < value.length) {
    segments.push({ kind: 'text', text: value.slice(lastIndex) })
  }
  return segments
}

/** Does this value contain at least one resolved `@Token` mention?
 * Used by the composer to decide whether to activate the overlay
 * (and zero-out the textarea's text colour). This intentionally
 * tokenises the value so legacy structured mentions remain visible
 * even when their display label would be ambiguous as plain text.
 *
 * 1.0.4 — user-mentions count too (`@user` / `@human` / `@you`),
 * so the overlay activates and renders the chip even in chats
 * with no ensemble participants. */
export function hasResolvedMention(value: string, participants: EnsembleParticipant[]): boolean {
  if (!value || !value.includes('@')) return false
  return tokeniseMentions(value, participants).some((segment) => segment.kind !== 'text')
}
