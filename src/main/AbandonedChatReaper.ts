import type { ChatRecord } from './store/types'

/*
 * AbandonedChatReaper — decides which never-started "New Chat" records are safe
 * to DELETE so tombstone empties stop accumulating.
 *
 * DESIGN CONTRACT (learned the hard way — see the prior "draft" failures):
 *   1. DELETE-ONLY. Callers delete reapable chats and ALWAYS create fresh on
 *      new-chat. NEVER reuse/mutate a record across types — that was the
 *      "drafts act weirdly between chat types" bug (an ensemble record reused
 *      as a single, wrong scope/provider bleeding across). A fresh `create*`
 *      factory always yields the correct per-type defaults.
 *   2. NO DRAFT FLAG GATES DISPATCH. "Abandoned" is a derived predicate over
 *      content, never a stored boolean a start path must clear. A thread is
 *      startable purely because it exists (the create-first invariant).
 *   3. PARANOID. Every uncertainty resolves to "do NOT reap". A false positive
 *      is silent data loss, so the predicate over-protects on purpose.
 *
 * Some guards live only in the renderer (unsent composer text, the active /
 * multiview / popout selection) — the main process is structurally blind to
 * them. Those arrive via the context sets below; when a set is omitted the
 * predicate simply protects nothing extra (and the create-time `keepChatId` +
 * the renderer-supplied sets are what make a live chat safe).
 */

export interface AbandonedReapContext {
  /** Never reap these — the focused chat, every multiview pane chat, the open
   *  side-chat, and any popout-window chat. Renderer-supplied (main can't see). */
  protectedChatIds?: ReadonlySet<string>
  /** Chats with non-empty unsent composer text (renderer localStorage only). */
  draftChatIds?: ReadonlySet<string>
  /** Chats backing a saved WorkflowDefinition (template.chatId) or the in-flight
   *  workflow-compose draft — intentionally message-less, so NEVER reap them. */
  workflowChatIds?: ReadonlySet<string>
  /** Chats targeted by a non-terminal scheduled task. */
  scheduledChatIds?: ReadonlySet<string>
  /** Chats that are a parent of at least one other chat (sub-thread / side-chat
   *  / guest). Derived from the list when omitted. */
  parentChatIds?: ReadonlySet<string>
  /** The just-created chat in a create-time replace — never reap it. */
  keepChatId?: string
  /** True iff the ensemble roster is an untouched default (safe to reap). When
   *  omitted, ensemble chats are NEVER reaped (conservative default). */
  isDefaultEnsemble?: (chat: ChatRecord) => boolean
  /** Sweep mode: when BOTH are set, only reap chats older than `ttlMs`. Omit for
   *  create-time replace (keepChatId + the protected sets are the guard). */
  now?: number
  ttlMs?: number
}

/** Titles a never-renamed fresh chat still carries (per the create factories). */
const DEFAULT_TITLES: ReadonlySet<string> = new Set(['New Chat', 'New Ensemble'])

const inSet = (set: ReadonlySet<string> | undefined, id: string): boolean =>
  set !== undefined && set.has(id)

/**
 * Is `chat` an abandoned, never-started chat that is safe to delete?
 * Returns false (protect) for anything with content, intent, a relationship, a
 * workflow/schedule link, an unsent draft, an edited roster, or that is active.
 */
export function isReapableAbandonedChat(
  chat: ChatRecord | null | undefined,
  ctx: AbandonedReapContext = {}
): chat is ChatRecord {
  if (!chat || chat.archived) return false
  if (ctx.keepChatId !== undefined && chat.appChatId === ctx.keepChatId) return false
  if (inSet(ctx.protectedChatIds, chat.appChatId)) return false

  // ── Started: a turn, a run, a bound provider session, or pruned memory. ──
  if ((chat.messages?.length || 0) > 0) return false
  if ((chat.runs?.length || 0) > 0) return false
  if (chat.linkedProviderSessionId || chat.linkedGeminiSessionId) return false
  if (chat.ollamaSessionMemory) return false

  // ── Explicit user intent on the shell. ──
  if (chat.pinned || chat.pinnedNotes?.trim()) return false
  if (chat.activeGoal) return false
  if (chat.chatTodos && Object.values(chat.chatTodos).some((lane) => lane && lane.length > 0))
    return false
  if (chat.soloWakeups && Object.keys(chat.soloWakeups).length > 0) return false

  // ── Relationships: is a child, configured a guest, or HAS children. ──
  if (chat.parentChatId || chat.parentChatRelation || chat.sideChatContext) return false
  if (chat.delegationContext) return false
  if (chat.guestParticipant) return false
  if (inSet(ctx.parentChatIds, chat.appChatId)) return false

  // ── Renamed from the type default ⇒ keep (defensive; a started chat is
  //    already excluded above, this catches odd manual-rename states). ──
  const title = chat.title?.trim()
  if (title && !DEFAULT_TITLES.has(title)) return false

  // ── Workflow / scheduled linkage — intentionally message-less, never reap. ──
  if (inSet(ctx.workflowChatIds, chat.appChatId)) return false
  if (inSet(ctx.scheduledChatIds, chat.appChatId)) return false

  // ── Unsent composer text (renderer-supplied). ──
  if (inSet(ctx.draftChatIds, chat.appChatId)) return false

  // ── Ensemble roster edited ⇒ intent. Default = never reap an ensemble. ──
  if (chat.chatKind === 'ensemble') {
    if (!ctx.isDefaultEnsemble) return false
    if (!ctx.isDefaultEnsemble(chat)) return false
  }

  // ── Age gate (sweep mode only). ──
  if (typeof ctx.ttlMs === 'number' && typeof ctx.now === 'number') {
    const createdAt = typeof chat.createdAt === 'number' ? chat.createdAt : 0
    if (ctx.now - createdAt < ctx.ttlMs) return false
  }

  return true
}

/**
 * Renderer-supplied half of the reap context — the signals the main process is
 * structurally blind to. All optional; missing ⇒ protect nothing extra.
 */
export interface RendererReapContext {
  /** Active/focused chat, every multiview pane chat, the open side-chat, popouts. */
  protectedChatIds?: string[]
  /** Chats with non-empty unsent composer text. */
  draftChatIds?: string[]
  /** The just-created chat in a create-time replace. */
  keepChatId?: string
}

/** Store-side dependencies, injected so the orchestration is unit-testable. */
export interface ReapAbandonedChatsDeps {
  getChats: () => ChatRecord[]
  /** Chat ids backing a saved WorkflowDefinition (template.chatId). */
  getWorkflowChatIds: () => Set<string>
  /** Chat ids targeted by a non-terminal scheduled task. */
  getScheduledChatIds: () => Set<string>
  deleteChat: (chatId: string) => void
}

/**
 * Compute the reapable abandoned chats, DELETE each, and return the ids.
 * Ensembles are deliberately NOT reaped here (no `isDefaultEnsemble` supplied),
 * so a curated-but-unsent roster is never lost. The caller broadcasts the
 * updated thread list after a non-empty result.
 */
export function reapAbandonedChats(
  deps: ReapAbandonedChatsDeps,
  renderer: RendererReapContext = {}
): string[] {
  const ids = reapableAbandonedChatIds(deps.getChats(), {
    protectedChatIds: new Set(renderer.protectedChatIds ?? []),
    draftChatIds: new Set(renderer.draftChatIds ?? []),
    workflowChatIds: deps.getWorkflowChatIds(),
    scheduledChatIds: deps.getScheduledChatIds(),
    keepChatId: renderer.keepChatId
  })
  for (const id of ids) deps.deleteChat(id)
  return ids
}

/** Chat ids that are a parent of at least one other chat in `chats`. */
export function deriveParentChatIds(chats: ReadonlyArray<ChatRecord>): Set<string> {
  const parents = new Set<string>()
  for (const chat of chats) {
    if (chat.parentChatId) parents.add(chat.parentChatId)
  }
  return parents
}

/**
 * Ids of every reapable abandoned chat in `chats`. Derives the parent set from
 * the list itself when the caller didn't supply one, so a parent with children
 * is protected even without an explicit `parentChatIds`.
 */
export function reapableAbandonedChatIds(
  chats: ReadonlyArray<ChatRecord>,
  ctx: AbandonedReapContext = {}
): string[] {
  const parentChatIds = ctx.parentChatIds ?? deriveParentChatIds(chats)
  const merged: AbandonedReapContext = { ...ctx, parentChatIds }
  const ids: string[] = []
  for (const chat of chats) {
    if (isReapableAbandonedChat(chat, merged)) ids.push(chat.appChatId)
  }
  return ids
}
