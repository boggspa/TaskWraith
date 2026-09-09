/**
 * Provenance of a host-authored user row that arrived through a machine
 * channel rather than the desktop composer.
 *
 * It never changes WHO speaks: the row is still the user's, with the user's
 * authority, in every renderer, prompt serializer and export. It only says
 * which door the words came through, so a transcript can label the row
 * "Sent from PID 84536 / Claude Code" instead of "You".
 *
 * The host stamps it from what it observed at the socket. It is never copied
 * from a remote payload — the paired-device decoder strips the field — so a
 * label here is evidence about the channel, not a claim a sender made about
 * itself over a wire the host does not control.
 */
export interface ChatMessageOrigin {
  /** The door the message came through. */
  channel: 'local-control'
  /** The sending process, as it reported itself at hello. */
  pid?: number
  /** A short label the sender chose for itself, e.g. "Claude Code". */
  label?: string
  /** The sender's protocol client version string. */
  clientVersion?: string
}

export const CHAT_MESSAGE_ORIGIN_TEXT_MAX_CHARS = 80

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim().slice(0, CHAT_MESSAGE_ORIGIN_TEXT_MAX_CHARS)
  return text || undefined
}

function positivePid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Reads a stored origin defensively: rows are persisted JSON that may carry
 * anything, and the label reaches the transcript verbatim.
 */
export function chatMessageOriginFrom(value: unknown): ChatMessageOrigin | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.channel !== 'local-control') return undefined
  const pid = positivePid(record.pid)
  const label = boundedText(record.label)
  const clientVersion = boundedText(record.clientVersion)
  return {
    channel: 'local-control',
    ...(pid !== undefined ? { pid } : {}),
    ...(label ? { label } : {}),
    ...(clientVersion ? { clientVersion } : {})
  }
}

/**
 * What every row that came through the socket is called, whatever tool sent
 * it. One name, so a reader learns it once: the detail of WHICH agent lives in
 * the badges beside it, not in the speaker.
 */
export const CHAT_MESSAGE_ORIGIN_SPEAKER = 'External Agent'

/** Separator between the speaker and its badges on flat text surfaces. */
const BADGE_SEPARATOR = ' · '

/**
 * The speaker a transcript shows in place of "You" for a row that carries an
 * origin; `undefined` for an ordinary user row.
 */
export function messageOriginSpeaker(value: unknown): string | undefined {
  return chatMessageOriginFrom(value) ? CHAT_MESSAGE_ORIGIN_SPEAKER : undefined
}

/**
 * The identifying chips shown beside the speaker: the tool that named itself,
 * then the process it ran as. Either can be absent — an unidentified sender is
 * still an External Agent, just an anonymous one — so this is often shorter
 * than two entries and sometimes empty.
 */
export function messageOriginBadges(value: unknown): string[] {
  const origin = chatMessageOriginFrom(value)
  if (!origin) return []
  return [
    ...(origin.label ? [origin.label] : []),
    ...(origin.pid !== undefined ? [`PID ${origin.pid}`] : [])
  ]
}

/**
 * The whole identity flattened onto one line, for surfaces that cannot draw a
 * badge (the terminal UI, exports). Rich surfaces should render
 * `messageOriginSpeaker` and `messageOriginBadges` as separate elements
 * instead, so the speaker stays legible when the chips are styled down.
 */
export function messageOriginLabel(value: unknown): string | undefined {
  const speaker = messageOriginSpeaker(value)
  if (!speaker) return undefined
  return [speaker, ...messageOriginBadges(value)].join(BADGE_SEPARATOR)
}
