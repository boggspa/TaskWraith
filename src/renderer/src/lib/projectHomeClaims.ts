import { hasConversationContent, type WelcomeMessageLike } from './welcomeState'

/**
 * First-send auto-claim planner for "Start Project Home" drafts.
 *
 * Starting a Project Home creates an ORDINARY pristine General draft through
 * the normal create-first machinery and records an ephemeral pending claim
 * (chatId → projectId) in renderer memory. Nothing is persisted on the chat
 * record — the abandoned-chat reaper's contract bans stored draft flags, and
 * an unsent home draft must stay reapable/rebindable like any other draft.
 *
 * The claim fires on the pristine → non-pristine transition observed from
 * chat state (first conversation message OR first run — an aborted run still
 * counts as the user committing the thread). This is deliberately a WATCHER
 * over chat summaries, not a hook inside the send lanes: identical semantics
 * to "first committed send" without touching dispatch code. Once a chat is
 * claimed it is non-pristine, so every pristine-gated mechanism (reaper,
 * welcome reuse, surface-toggle rebind) already leaves it alone — no
 * protection flags needed anywhere.
 *
 * Pending entries are one-shot: a chat that vanishes (reaped, deleted) or
 * fires its claim is pruned. A claim that later fails main-side validation
 * (project deleted, chat became another project's home) is dropped silently —
 * the draft simply remains an ordinary chat.
 */

export interface PendingHomeClaimChatLike {
  appChatId: string
  summaryOnly?: boolean
  messageCount?: number
  runCount?: number
  messages?: ReadonlyArray<WelcomeMessageLike>
  runs?: ReadonlyArray<unknown>
}

export interface PendingHomeClaimPlan {
  /** Fire setProjectHomeChat for each and drop the pending entry (one-shot). */
  claims: Array<{ projectId: string; chatId: string }>
  /** Pending entries whose chat no longer exists — drop without claiming. */
  prune: string[]
}

/** The moment a draft stops being pristine: any run (even message-less and
 * aborted) or any real conversation content. Mirrors the disqualifiers of
 * `isConvertiblePristineSingleDraft`, evaluated on full or summary records. */
export function hasChatStarted(chat: PendingHomeClaimChatLike): boolean {
  if ((chat.runs?.length ?? 0) > 0 || (chat.runCount ?? 0) > 0) return true
  if (chat.summaryOnly) return (chat.messageCount ?? 0) > 0
  return hasConversationContent(chat.messages ?? [])
}

export function planPendingHomeClaims(
  chats: ReadonlyArray<PendingHomeClaimChatLike>,
  pending: ReadonlyMap<string, string>
): PendingHomeClaimPlan {
  if (pending.size === 0) return { claims: [], prune: [] }
  const byId = new Map(chats.map((chat) => [chat.appChatId, chat]))
  const claims: Array<{ projectId: string; chatId: string }> = []
  const prune: string[] = []
  for (const [chatId, projectId] of pending) {
    const chat = byId.get(chatId)
    if (!chat) {
      prune.push(chatId)
      continue
    }
    if (hasChatStarted(chat)) {
      claims.push({ projectId, chatId })
    }
  }
  return { claims, prune }
}
