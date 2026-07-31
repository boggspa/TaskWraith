/**
 * What a PAIRED DEVICE is shown for an approval, and whether it may accept it.
 *
 * The desktop modal can render everything; a phone card cannot. Its body is
 * sanitized to 400 characters with all whitespace collapsed
 * (RemoteTaskProjection.buildMobileApprovalCard), and the desktop body leads
 * with an agent-authored `intent` of up to 600 characters — so reusing it put
 * the agent's own prose in front of the recipients and pushed them off the
 * card entirely. Ten ordinary addresses did it without any intent at all.
 *
 * Two rules follow:
 *  1. The remote body is built from the STRUCTURED fields, security-critical
 *     ones first, and never carries the intent.
 *  2. If those fields still do not fit, the request is not `complete` and the
 *     phone may decline but not accept — the same treatment canvas_eval gets.
 *     Approving what you cannot see is the thing being prevented.
 */

/** Matches the `sanitizeText(input.body, 400)` budget in the projection. */
export const REMOTE_APPROVAL_BODY_BUDGET = 400

export interface RemoteApprovalSummary {
  /** Body text for the remote card, or undefined to keep the caller's. */
  text?: string
  /**
   * False when the card cannot show everything the write will do. Callers
   * must then withhold the accept actions.
   */
  complete: boolean
}

/**
 * Tools whose approval turns on a field that MUST be legible remotely.
 *
 * Only these downgrade to decline-only when the summary does not fit: an
 * over-long shell command is a readability problem, but an unseen recipient
 * is an exfiltration channel.
 */
const RECIPIENT_BEARING_TOOLS = new Set(['outlook_create_draft', 'outlook_create_event'])

function asList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string')
  return typeof value === 'string' && value.trim() ? [value] : []
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function buildRemoteApprovalSummary(preview: unknown): RemoteApprovalSummary {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    return { complete: true }
  }
  const record = preview as Record<string, unknown>

  // Shell commands are self-describing: the command itself must be visible on
  // a paired device because there is no transcript row to lean on. If it does
  // not fit, the device may decline but not approve blind.
  if (record.kind === 'command') {
    const command = typeof record.command === 'string' ? record.command : ''
    if (!command) return { complete: false }
    if (command.length <= REMOTE_APPROVAL_BODY_BUDGET) return { text: command, complete: true }
    return {
      text: `${command.slice(0, REMOTE_APPROVAL_BODY_BUDGET - 1)}…`,
      complete: false
    }
  }

  const toolName = typeof record.toolName === 'string' ? record.toolName : ''
  if (!RECIPIENT_BEARING_TOOLS.has(toolName)) {
    return { complete: true }
  }
  const params =
    record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : {}

  const to = asList(params.to)
  const cc = asList(params.cc)
  const subject = asText(params.subject)
  const location = asText(params.location)
  const window = asText(params.window)

  const parts: string[] = []
  if (toolName === 'outlook_create_draft') {
    // Stated even when empty: "no recipients" is a fact the approver needs.
    parts.push(`To: ${to.length > 0 ? to.join(', ') : '(none)'}`)
    if (cc.length > 0) parts.push(`Cc: ${cc.join(', ')}`)
    parts.push(`Subject: ${subject || '(none)'}`)
    parts.push('Saves a draft — nothing is sent.')
  } else {
    parts.push(`Event: ${subject || '(no title)'}`)
    if (window) parts.push(window)
    if (location) parts.push(location)
    parts.push('No attendees — no invitations are sent.')
  }

  const text = parts.join(' · ')
  if (text.length <= REMOTE_APPROVAL_BODY_BUDGET) return { text, complete: true }
  return {
    text: `${text.slice(0, REMOTE_APPROVAL_BODY_BUDGET - 1)}…`,
    complete: false
  }
}

/** Actions a paired device may take when it cannot see the whole request. */
export function remoteIncompleteActions<T extends string>(actions: readonly T[]): T[] {
  return actions.filter((action) => action === 'decline' || action === 'cancel')
}
