import type { ChatListItem, ChatRecord } from './types'

/**
 * Stage 6 — escalate-not-reject for summary shells on the whole-record save
 * path.
 *
 * A summary shell is a ChatRecord whose transcript arrays were projected away:
 * a paged open (`transcriptPaged` shell from get-chat-transcript-page), an
 * LRU demotion (`demoteChatToSummary`), or a chat-list row
 * (`toChatListItem` / `normalizeChatListItem`). Every producer stamps
 * `summaryOnly: true` and empties `messages`/`runs`; the chrome — title,
 * ensemble roster, goal, pins, archived, workspace, provider metadata — is the
 * caller's live intent.
 *
 * Both save fences used to throw on `summaryOnly`. On a >1,500-message thread
 * the open record IS a shell for the whole session, so any of the ~25 direct
 * whole-record saves in the renderer (seat removal, goal update, rename, pin)
 * turned into a failed user action. That is fail-closed friction, not
 * protection: the transcript the fence protects is sitting in the canonical
 * record already. So a marked shell is rebuilt onto that canonical record —
 * canonical transcript authority + the shell's chrome — BEFORE either fence.
 *
 * What still fails closed, deliberately:
 * - a summary CREATE (no canonical record) — no producer ever does this;
 * - a marked record that still carries transcript rows — no producer does
 *   this either, and escalating it would silently discard rows the caller
 *   sent, so the fence keeps it;
 * - an UNMARKED windowed page — `assertAuthoritativeChatForSave` is untouched
 *   and still runs on the escalated record (which it admits as a full match).
 *
 * Main-owned fields the fences already strip-and-remerge (threadWorktreeBinding,
 * watchedPr, gitWorkflow, fanoutWorktreeCandidates, a lean ensemble roster)
 * are NOT duplicated here: the escalated record flows through those same
 * remerges next, so there is exactly one owner of that list.
 */

/** Fields a summary projection ADDS. Source of truth: `normalizeChatListItem`
 *  / `toChatListItem` (store) plus the `transcriptPaged` marker of a paged
 *  shell (`buildChatShell` / `ChatShell`). None of them belongs on a persisted
 *  record. */
const SUMMARY_PROJECTION_FIELDS = [
  'summaryOnly',
  'transcriptPaged',
  'messageCount',
  'runCount',
  'lastRun',
  'runsSummary',
  'searchText',
  'searchPreview',
  'sourceChatMtimeMs',
  'sourceChatSize'
] as const

/** Jumbo fields the chat-list projection SHEDS per field (`toChatListItem`,
 *  `normalizeChatListItem`): a list row never carries them, so a row reaching
 *  a save would erase what main wrote. Restored from the canonical record only
 *  when the incoming shell has no such key at all — an explicit
 *  `field: undefined` is a caller's deletion and is honoured. */
const LIST_PROJECTION_SHED_FIELDS = ['ollamaSessionMemory', 'ollamaSessionMemories'] as const

type SummaryChatShape = ChatRecord &
  Partial<Pick<ChatListItem, (typeof SUMMARY_PROJECTION_FIELDS)[number] & keyof ChatListItem>> & {
    transcriptPaged?: unknown
  }

function isEmptyTranscriptArray(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0)
}

/**
 * True for the exact shape every summary producer emits: marked
 * `summaryOnly` with EMPTY (or absent) transcript arrays. A marked record that
 * still carries rows is not a shell and is left to the fence.
 */
export function isEscalatableSummaryChat(chat: ChatRecord): boolean {
  return (
    (chat as Partial<ChatListItem>).summaryOnly === true &&
    isEmptyTranscriptArray(chat.messages) &&
    isEmptyTranscriptArray(chat.runs)
  )
}

/**
 * Returns `incoming` itself (same reference — callers rely on the save path
 * stamping their own object) unless it is an escalatable shell with a
 * canonical record behind it, in which case a NEW full record is returned:
 * the canonical transcript (`messages`, `runs`, shared by reference — the
 * save pipeline treats records as immutable) and its main-owned persistence
 * revision, under the shell's chrome, with every summary-projection field
 * removed. `readCanonical` is invoked at most once.
 */
export function escalateSummaryChatForSave(
  incoming: ChatRecord,
  readCanonical: (chatId: string) => ChatRecord | null
): ChatRecord {
  if (!isEscalatableSummaryChat(incoming)) return incoming
  const canonical = readCanonical(incoming.appChatId)
  // No canonical record: a summary CREATE. A canonical that is itself a
  // summary cannot lend transcript authority. Both stay with the fence.
  if (!canonical || (canonical as Partial<ChatListItem>).summaryOnly === true) return incoming

  const chrome: Record<string, unknown> = { ...(incoming as SummaryChatShape) }
  for (const field of SUMMARY_PROJECTION_FIELDS) delete chrome[field]
  delete chrome.messages
  delete chrome.runs
  delete chrome.persistenceRevision

  const restored: Record<string, unknown> = {}
  for (const field of LIST_PROJECTION_SHED_FIELDS) {
    if (!(field in incoming) && field in canonical) restored[field] = canonical[field]
  }

  return {
    ...chrome,
    ...restored,
    messages: canonical.messages,
    runs: canonical.runs,
    ...('persistenceRevision' in canonical
      ? { persistenceRevision: canonical.persistenceRevision }
      : {})
  } as ChatRecord
}
