import { toGraphemes } from './advanceReveal'
import {
  commonGraphemePrefixLength,
  createAdaptiveRevealState,
  type AdaptiveRevealState
} from './adaptiveReveal'

const MAX_REVEAL_SESSIONS = 64
export const REVEAL_SESSION_TTL_MS = 30_000

interface RevealSessionSnapshot {
  content: string
  state: AdaptiveRevealState
  paintedRevealed: number
  updatedAt: number
}

export interface ResumedRevealSession {
  state: AdaptiveRevealState
  revealed: number
  resumed: true
}

const sessions = new Map<string, RevealSessionSnapshot>()

export function revealSessionKey(input: {
  chatId?: string
  messageId?: string
  streamRunId?: string
}): string | null {
  const messageIdentity = input.messageId?.trim()
  const runIdentity = input.streamRunId?.trim()
  if (!messageIdentity && !runIdentity) return null
  return `${input.chatId?.trim() || 'chat'}:${runIdentity || 'run'}:${messageIdentity || 'message'}`
}

/**
 * Resume the display cursor after virtualization temporarily unmounted the
 * active assistant row. Rewrites are capped to their common grapheme prefix,
 * so stale state can never reveal content the new authoritative string no
 * longer contains.
 */
export function readRevealSession(
  key: string | null,
  content: string,
  targetGraphemes: readonly string[],
  now = Date.now()
): ResumedRevealSession | undefined {
  if (!key) return undefined
  const snapshot = sessions.get(key)
  if (!snapshot) return undefined
  if (!Number.isFinite(now) || now - snapshot.updatedAt > REVEAL_SESSION_TTL_MS) {
    sessions.delete(key)
    return undefined
  }

  sessions.delete(key)
  sessions.set(key, snapshot)
  const previousGraphemes = toGraphemes(snapshot.content)
  const commonPrefix = commonGraphemePrefixLength(previousGraphemes, targetGraphemes)
  const revealed = Math.min(snapshot.paintedRevealed, commonPrefix, targetGraphemes.length)
  const controllerRevealed = Math.min(
    snapshot.state.revealed,
    commonPrefix,
    targetGraphemes.length
  )
  const appendCompatible =
    content.startsWith(snapshot.content) && controllerRevealed === snapshot.state.revealed
  return {
    resumed: true,
    revealed,
    state: appendCompatible
      ? { ...snapshot.state, revealed: controllerRevealed }
      : createAdaptiveRevealState(revealed)
  }
}

export function writeRevealSession(
  key: string | null,
  content: string,
  state: AdaptiveRevealState,
  paintedRevealed: number,
  now = Date.now()
): void {
  if (!key || !Number.isFinite(now)) return
  sessions.delete(key)
  sessions.set(key, {
    content,
    state: { ...state },
    paintedRevealed: Math.max(0, Math.floor(paintedRevealed)),
    updatedAt: now
  })
  while (sessions.size > MAX_REVEAL_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined
    if (!oldest) break
    sessions.delete(oldest)
  }
}

export function clearRevealSession(key: string | null): void {
  if (key) sessions.delete(key)
}

export function resetRevealSessionRegistryForTest(): void {
  sessions.clear()
}
