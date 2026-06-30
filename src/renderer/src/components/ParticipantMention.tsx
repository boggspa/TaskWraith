import { useContext, type ReactNode } from 'react'
import { AgentIdentityContext } from './AgentIdentityContext'
import { getProviderName } from './Sidebar'
import type { ProviderId } from '../../../main/store/types'
import { isUserMentionToken } from '../../../main/services/EnsembleMentionAlias'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'

interface ParticipantMentionProps {
  /** Either an ensemble participant id (from a `[@Role](ensemble-dm://id)`
   * markdown link inserted by the composer) OR a free-text reference
   * like "@Worker" / "@codex" emitted by an LLM in its reply. The
   * resolver below tries id first, then matches role/provider name. */
  reference: string
  /** Raw link text (`@Worker`) when this came from a markdown link.
   * Falls back to the resolved name when not provided. */
  children?: ReactNode
}

/**
 * Inline participant mention chip — renders a coloured pill referring
 * to an ensemble participant. Two entry points feed the same chip:
 *
 *   1. The composer's `@` picker inserts a markdown link of the form
 *      `[@Role](ensemble-dm://participant-id)`. `StableMarkdownBlock`
 *      intercepts the `ensemble-dm://` scheme and renders this chip.
 *      The id maps directly to a participant in the current chat's
 *      ensemble.
 *
 *   2. An LLM reply may contain free-text `@Role` or `@codex` that's
 *      tokenised post-parse against the round's participant list.
 *      The match is case-insensitive on `participant.role` (preferred)
 *      and on `provider` as a fallback. Misses render as plain text
 *      via the wrapper component — they never reach this chip with a
 *      null `participant`.
 *
 * The colour comes from the per-provider CSS variable
 * `--provider-{name}-color` so the chip auto-matches the theme tokens
 * used everywhere else in the app. Falls back to `--accent` if a
 * variable is somehow unset.
 */
export function ParticipantMention({ reference, children }: ParticipantMentionProps) {
  const chat = useContext(AgentIdentityContext)
  const participants = chat?.ensemble?.participants ?? []
  const trimmed = reference.trim()
  const lower = trimmed.toLowerCase()

  // Resolve by id first (markdown-link case), then by role, then by
  // provider name. The role match wins over provider so two
  // participants on the same provider with distinct roles are
  // disambiguated correctly.
  const participant =
    participants.find((p) => p.id === trimmed) ||
    participants.find((p) => (p.role || '').trim().toLowerCase() === lower) ||
    participants.find((p) => p.provider === lower)

  if (!participant) {
    // `@user` / `@human` / `@you` — an address to the user, not a
    // participant. Render the distinct user-mention chip echoing the
    // user's bubble colour. Routing remains explicit via tools.
    if (isUserMentionToken(trimmed)) {
      return (
        <span
          className="participant-mention participant-mention--user"
          style={{ color: 'var(--user-bubble-base, var(--accent))' }}
          title="Addresses you"
        >
          @{trimmed}
        </span>
      )
    }
    // Unresolved — render the raw text so the message still reads.
    return <>{children ?? `@${trimmed}`}</>
  }

  const providerId: ProviderId = participant.provider
  // Ollama-backed display brands wear their spoofed upstream brand hue +
  // name (e.g. Qwen → Alibaba purple) so the chip matches the transcript
  // header, run cards, and model picker. Non-Ollama providers resolve to
  // their own provider class / label unchanged.
  const providerClass = resolveProviderHueClass(providerId, participant.model)
  const brandLabel = resolveProviderBrandLabel(providerId, participant.model)
  const tint = `var(--provider-${providerClass}-color, var(--accent))`
  const displayName =
    (typeof children === 'string'
      ? children.replace(/^@+/, '')
      : Array.isArray(children) && typeof children[0] === 'string'
        ? (children[0] as string).replace(/^@+/, '')
        : participant.role || brandLabel || getProviderName(providerId)) || providerId

  const titleParts = [brandLabel || getProviderName(providerId)]
  if (participant.role) titleParts.push(participant.role)

  return (
    <span
      className="participant-mention"
      style={{ color: tint, borderColor: tint }}
      title={titleParts.join(' · ')}
    >
      @{displayName}
    </span>
  )
}
