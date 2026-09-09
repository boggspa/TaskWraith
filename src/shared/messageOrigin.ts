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
 * The speaker label a transcript shows in place of "You" for a row that
 * carries an origin; `undefined` for an ordinary user row.
 */
export function messageOriginLabel(value: unknown): string | undefined {
  const origin = chatMessageOriginFrom(value)
  if (!origin) return undefined
  if (origin.pid !== undefined && origin.label)
    return `Sent from PID ${origin.pid} / ${origin.label}`
  if (origin.pid !== undefined) return `Sent from PID ${origin.pid}`
  if (origin.label) return `Sent from ${origin.label}`
  return 'Sent from the local control socket'
}
