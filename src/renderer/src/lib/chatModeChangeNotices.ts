/**
 * The one place a failed solo/Ensemble mode switch becomes visible.
 *
 * Every failure on that path used to go to `appendThreadRawLog`, which is an
 * in-memory ring buffer rendered only when the Inspector's Raw tab happens to
 * be open. Main can refuse the switch for good reasons — it verifies the change
 * reached the durable record before reporting success — and the user saw an
 * inert toggle and no words either way. A log nobody is looking at is not a
 * report; it is a place to put one so it stops being your problem.
 *
 * Deliberately NOT a transcript message. The nearest existing pattern
 * (`handleNotifyThreadOfCi`) appends a `role: 'system'` row and persists the
 * chat, which is exactly wrong here: the most likely reason the switch failed
 * is that this chat's writes are not landing, so the report would take the same
 * path as the thing it is reporting on and vanish the same way. A notice lives
 * in renderer memory, keyed by chat, and needs nothing to work.
 */

export interface ChatModeChangeNotice {
  chatId: string
  message: string
  at: number
}

const REMOTE_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
const LEADING_ERROR_LABEL = /^(?:Error|TypeError):\s*/

const GENERIC_FAILURE = 'The chat mode could not be changed. The thread is unchanged.'

/**
 * Turn whatever `setChatKind` rejected with into something a person can read.
 *
 * Main's own refusals are already written as sentences addressed to the user
 * ("… try the switch again"), so they pass through. What does not pass through
 * is the IPC wrapper: `ipcRenderer.invoke` prefixes every rejection with
 * `Error invoking remote method '<channel>':`, which is the channel id and the
 * transport showing through as copy. Strip the wrapper, keep the sentence.
 */
export function describeChatModeChangeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const unwrapped = raw.replace(REMOTE_INVOKE_PREFIX, '').replace(LEADING_ERROR_LABEL, '').trim()
  if (!unwrapped) return GENERIC_FAILURE
  // A bare stack frame or a thrown non-sentence is machine vocabulary, not an
  // explanation. Show the fallback and leave the detail to the raw log, which
  // still receives everything it always did.
  if (!/[a-z]/.test(unwrapped) || unwrapped.startsWith('at ')) return GENERIC_FAILURE
  return unwrapped
}

export class ChatModeChangeNotices {
  private readonly byChatId = new Map<string, ChatModeChangeNotice>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(private readonly now: () => number = Date.now) {}

  raise(chatId: string | null | undefined, message: string | null | undefined): void {
    if (!chatId || !message) return
    this.byChatId.set(chatId, { chatId, message, at: this.now() })
    this.bump()
  }

  clear(chatId: string | null | undefined): void {
    if (!chatId || !this.byChatId.has(chatId)) return
    this.byChatId.delete(chatId)
    this.bump()
  }

  noticeFor(chatId: string | null | undefined): ChatModeChangeNotice | null {
    if (!chatId) return null
    return this.byChatId.get(chatId) ?? null
  }

  /**
   * The newest notice among several threads that are on screen together.
   *
   * A multiview pane runs the same handlers against its OWN chat, which is
   * usually not the focused one, so a notice keyed only on the focused chat
   * would be raised for a thread nothing renders — the exact silence this
   * module exists to end, reintroduced one surface over.
   */
  newestFor(chatIds: readonly (string | null | undefined)[]): ChatModeChangeNotice | null {
    let newest: ChatModeChangeNotice | null = null
    for (const chatId of chatIds) {
      const notice = this.noticeFor(chatId)
      if (notice && (!newest || notice.at >= newest.at)) newest = notice
    }
    return newest
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * A version counter, not the notice itself: `useSyncExternalStore` compares
   * snapshots by identity, and returning a fresh object every call would loop.
   */
  snapshot = (): number => this.version

  private bump(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}
