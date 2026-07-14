export const CLIPBOARD_PASTE_INTENT_TTL_MS = 1_500

interface ClipboardPasteIntent {
  token: string
  expiresAt: number
}

/**
 * One-shot, renderer-bound proof that a real OS paste event just occurred.
 * Only preload can mint the opaque token; renderer code never receives it.
 */
export class ClipboardPasteIntentRegistry {
  private readonly intents = new Map<number, ClipboardPasteIntent>()

  constructor(
    private readonly ttlMs = CLIPBOARD_PASTE_INTENT_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  issue(senderId: number, rawToken: unknown): boolean {
    const token = normalizeToken(rawToken)
    if (!Number.isSafeInteger(senderId) || senderId < 0 || !token) return false
    this.intents.set(senderId, {
      token,
      expiresAt: this.now() + this.ttlMs
    })
    return true
  }

  consume(senderId: number, rawToken: unknown): boolean {
    const intent = this.intents.get(senderId)
    // Every attempt consumes the sender's current intent. A stale or guessed
    // token cannot be retried until another trusted paste event occurs.
    this.intents.delete(senderId)
    const token = normalizeToken(rawToken)
    return Boolean(intent && token && intent.token === token && this.now() <= intent.expiresAt)
  }

  revoke(senderId: number): void {
    this.intents.delete(senderId)
  }
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (!token || token.length > 200) return null
  return token
}
