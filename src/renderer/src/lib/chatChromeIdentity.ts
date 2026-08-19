import type { ChatRecord } from '../../../main/store/types'

/**
 * Fields that stream flushes update every frame without changing App chrome.
 * When only these differ, React may keep the previous chat object identity so
 * sidebar/composer do not re-render; ChatTranscriptStore notifies the panel.
 * `persistenceRevision` is main's save counter — it rides every patch
 * delivery, so leaving it out forced a full chrome commit per flush.
 */
const TRANSCRIPT_STREAM_FIELDS = new Set(['messages', 'runs', 'updatedAt', 'persistenceRevision'])

/**
 * True when two chat records are equal for App chrome purposes — every own
 * enumerable field matches by `Object.is`, ignoring `messages`, `runs`, and
 * `updatedAt`.
 */
export function chatChromeIdentityEqual(
  previous: ChatRecord | null | undefined,
  next: ChatRecord | null | undefined
): boolean {
  if (previous === next) return true
  if (!previous || !next) return false

  const previousKeys = Object.keys(previous) as Array<keyof ChatRecord>
  const nextKeys = Object.keys(next) as Array<keyof ChatRecord>
  const seen = new Set<string>()

  for (const key of previousKeys) {
    seen.add(key as string)
    if (TRANSCRIPT_STREAM_FIELDS.has(key as string)) continue
    if (!Object.is(previous[key], next[key])) return false
  }
  for (const key of nextKeys) {
    if (seen.has(key as string) || TRANSCRIPT_STREAM_FIELDS.has(key as string)) continue
    if (!Object.is(previous[key], next[key])) return false
  }
  return true
}

/**
 * Whether a coalesced flush should keep the previous React chat object.
 * New chats (no previous) and chrome-field changes must commit; pure
 * transcript/`updatedAt` churn should not.
 *
 * Empty↔non-empty message transitions also commit: welcome / transcript
 * mount gates in App still read `currentChat.messages`, while the panel
 * subscribes to ChatTranscriptStore for mid-stream updates.
 */
export function shouldRetainReactChatOnFlush(
  previous: ChatRecord | null | undefined,
  next: ChatRecord | null | undefined
): boolean {
  if (!previous || !next || previous === next) return false
  if (previous.appChatId !== next.appChatId) return false
  const previousCount = previous.messages?.length ?? 0
  const nextCount = next.messages?.length ?? 0
  if ((previousCount === 0) !== (nextCount === 0)) return false
  return chatChromeIdentityEqual(previous, next)
}
