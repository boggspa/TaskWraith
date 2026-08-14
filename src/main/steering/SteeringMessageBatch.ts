const STEERING_MESSAGE_SEPARATOR = '\n\n[TaskWraith: next steering message]\n\n'

/**
 * Preserve every steering message that arrives before a live transport drains.
 * The neutral separator keeps each message's own authority framing intact.
 */
export function appendSteeringMessage(pending: string | null | undefined, next: string): string {
  if (!pending?.trim()) return next
  if (!next.trim()) return pending
  return `${pending}${STEERING_MESSAGE_SEPARATOR}${next}`
}
