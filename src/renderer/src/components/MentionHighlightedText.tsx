import { Fragment } from 'react'
import type { EnsembleParticipant } from '../../../main/store/types'
import { tokeniseMentions } from '../lib/mentionHighlight'

interface MentionHighlightedTextProps {
  value: string
  /** Ensemble participants for the chat. Undefined / empty disables
   * tokenisation — the value renders as plain text. */
  participants?: EnsembleParticipant[]
  /** Optional class added to the resolved mention spans on top of
   * the default `.mention-highlighted-token`. */
  mentionClassName?: string
}

/**
 * Inline mention-highlight renderer. Walks the value through the
 * shared `tokeniseMentions` helper and wraps each resolved `@Token`
 * in a bold, provider-tinted span. Plain text segments render
 * unchanged.
 *
 * Used in:
 *   - User message bubbles in the transcript (so sent prompts show
 *     `@Role` mentions with the same tint as the composer overlay
 *     and the assistant-side `ParticipantMention` chip).
 *   - Queued-messages above-row body text (so stacked prompts
 *     waiting in the queue show their @-tags too).
 *
 * Unlike `ParticipantMention` (which renders a pill/chip), this
 * component preserves inline-flow styling — just colour + weight —
 * so it slots into existing text contexts (bubbles, row labels)
 * without breaking line layout.
 */
export function MentionHighlightedText({
  value,
  participants,
  mentionClassName
}: MentionHighlightedTextProps): React.JSX.Element {
  const segments = tokeniseMentions(value, participants || [])
  if (segments.length === 0) return <></>
  return (
    <>
      {segments.map((segment, idx) => {
        if (segment.kind === 'text') {
          return <Fragment key={idx}>{segment.text}</Fragment>
        }
        if (segment.kind === 'user-mention') {
          // 1.0.4 — `@user` / `@human` / `@you` chip in body text.
          // Tinted with `--user-bubble-color` (Appearance setting)
          // so it echoes the user's identity colour rather than
          // any provider's brand.
          return (
            <span
              key={idx}
              className={`mention-highlighted-token mention-highlighted-token--user${mentionClassName ? ` ${mentionClassName}` : ''}`}
              style={{ color: `var(--user-bubble-base, var(--accent))` }}
            >
              {segment.text}
            </span>
          )
        }
        if (segment.kind === 'group-mention') {
          return (
            <span
              key={idx}
              className={`mention-highlighted-token mention-highlighted-token--group${mentionClassName ? ` ${mentionClassName}` : ''}`}
              style={{ color: `var(--user-bubble-base, var(--accent))` }}
            >
              {segment.text}
            </span>
          )
        }
        return (
          <span
            key={idx}
            className={`mention-highlighted-token${mentionClassName ? ` ${mentionClassName}` : ''}`}
            style={{ color: `var(--provider-${segment.providerClass}-color, var(--accent))` }}
          >
            {segment.text}
          </span>
        )
      })}
    </>
  )
}
