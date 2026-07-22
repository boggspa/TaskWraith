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

/**
 * The create target a "+ New" action is about to mint a record for. Reuse must
 * match BOTH scope and chatKind so a global create never adopts a workspace
 * draft (or vice-versa) and a single create never adopts an ensemble draft —
 * the reaper-taught rule: never repurpose records across chat types.
 */
export interface ReusableDraftCreateTarget {
  scope: 'global' | 'workspace'
  chatKind: 'single' | 'ensemble'
  /** Required — and matched — only when scope === 'workspace'. */
  workspaceId?: string
}

/** The record slice the create-path reuse matcher inspects. */
export interface ReusableDraftChatLike extends ReusableChatLike {
  appChatId: string
  scope?: 'global' | 'workspace'
  chatKind?: 'single' | 'ensemble'
  workspaceId?: string
  archived?: boolean
}

export interface ReusableDraftContext {
  /**
   * True for a chat that must never be adopted — one with a live/queued run or
   * otherwise busy. The caller owns these runtime signals; the matcher is
   * otherwise record-only.
   */
  isExcluded?: (chatId: string) => boolean
}

/**
 * Find the ≤1 pristine, never-started draft a "+ New" create for `target` can
 * REUSE instead of minting a fresh record — the create-path half of the
 * draft-litter fix (its twin is `isHideableUnstartedDraft`, which hides the
 * residue). Same reuse gate as the proven workspace-open path
 * (`isReusableWelcomeChat`: summary-safe + top-level) plus an exact scope /
 * chatKind / workspace match. Returns the FIRST match in list order, or
 * undefined when a fresh record must be created.
 */
export function findReusablePristineDraft<T extends ReusableDraftChatLike>(
  chats: ReadonlyArray<T>,
  target: ReusableDraftCreateTarget,
  ctx: ReusableDraftContext = {}
): T | undefined {
  return chats.find((chat) => {
    if (chat.archived) return false
    if (chat.chatKind !== target.chatKind) return false
    if (chat.scope !== target.scope) return false
    if (target.scope === 'workspace' && chat.workspaceId !== target.workspaceId) return false
    if (ctx.isExcluded?.(chat.appChatId)) return false
    return isReusableWelcomeChat(chat)
  })
}
