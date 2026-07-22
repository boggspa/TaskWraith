import { isReusableWelcomeChat, type ReusableChatLike } from './welcomeState'

/**
 * The slice of a chat record the sidebar litter filter inspects. Narrow on
 * purpose (same rationale as `ReusableChatLike`): the sidebar passes summary
 * `ChatListItem`s AND full `ChatRecord`s through here, and tests build these
 * inline without the full main-process record type.
 */
export interface UnstartedDraftChatLike extends ReusableChatLike {
  appChatId: string
  /** Explicit user intent — an unstarted chat the user deliberately kept. */
  pinned?: boolean
  pinnedNotes?: string
  activeGoal?: unknown
  /** A rename off the create-factory default is intent (keep it visible). */
  title?: string
  /** Any populated chat-todo lane is intent even before the first message. */
  chatTodos?: Record<string, ReadonlyArray<unknown> | undefined | null>
}

export interface UnstartedDraftFilterContext {
  /**
   * Chats to ALWAYS keep visible regardless of emptiness — the active/selected
   * chat, chats with a live/queued run, and shared (collaborating) chats. The
   * caller owns these runtime signals; the predicate is otherwise record-only.
   */
  protectedChatIds?: ReadonlySet<string>
}

/**
 * Titles a never-renamed fresh chat still carries. Mirrors the create factories
 * (`AppStore.createChat` / `createGlobalChat` → 'New Chat',
 * `createEnsembleChat` → 'New Ensemble') and the reaper's `DEFAULT_TITLES`.
 */
const DEFAULT_TITLES: ReadonlySet<string> = new Set(['New Chat', 'New Ensemble'])

/**
 * True when `chat` is an unstarted draft that should be HIDDEN from the sidebar
 * lists — the "New Chat / New Ensemble litter" the user never wants to stack.
 *
 * Deliberately layered on `isReusableWelcomeChat` (the record-only twin of
 * `shouldRenderWelcome`) so it stays SUMMARY-SAFE: a summary chat with
 * `messageCount: 0` but `runCount > 0` (an aborted / empty-result run) is NOT
 * reusable and therefore NOT hidden. A raw `messages.length` check — as in the
 * main-process reaper — would misclassify those summary rows.
 *
 * INTENT-AWARE: never hides a chat the user deliberately shaped even before the
 * first message — pinned, pinned notes, an active goal, a non-default title, or
 * a populated chat-todo lane all keep the row. Workflow / scheduled /
 * linked-child / contentless-remote-draft chats are already excluded upstream
 * in the sidebar pipeline, so they are not re-checked here.
 *
 * NON-DESTRUCTIVE: this only affects VISIBILITY. Deletion stays owned by the
 * DELETE-ONLY `AbandonedChatReaper`; a hidden draft persists and is reachable
 * again through create-path draft reuse.
 */
export function isHideableUnstartedDraft(
  chat: UnstartedDraftChatLike,
  ctx: UnstartedDraftFilterContext = {}
): boolean {
  if (ctx.protectedChatIds?.has(chat.appChatId)) return false
  if (!isReusableWelcomeChat(chat)) return false
  if (chat.pinned) return false
  if (chat.pinnedNotes && chat.pinnedNotes.trim().length > 0) return false
  if (chat.activeGoal) return false
  const title = chat.title?.trim()
  if (title && !DEFAULT_TITLES.has(title)) return false
  if (
    chat.chatTodos &&
    Object.values(chat.chatTodos).some((lane) => Array.isArray(lane) && lane.length > 0)
  )
    return false
  return true
}
