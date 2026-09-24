import type { ChatMessage, ChatRecord } from '../../../main/store/types'

/**
 * A subset of `ChatMessage` that the welcome-state helper actually
 * needs to inspect. Keeping the type narrow means this module stays
 * test-friendly without depending on the full message type from the
 * main process.
 */
export interface WelcomeMessageLike {
  role: ChatMessage['role']
}

/**
 * A subset of `ChatRecord` that the welcome-state helper needs. Same
 * rationale as `WelcomeMessageLike`: the helper inspects only the
 * fields that decide whether the welcome surface should render.
 */
export interface WelcomeChatRecordLike {
  appChatId: ChatRecord['appChatId']
  parentChatId?: ChatRecord['parentChatId']
  summaryOnly?: boolean
  messageCount?: number
  runCount?: number
}

export type WelcomeChatLike = WelcomeChatRecordLike | null

/**
 * Inputs the renderer feeds into `shouldRenderWelcome`. Encoded as a
 * single object so call sites stay readable at the App.tsx scale and
 * adding a new gate (e.g. "show welcome only when bridge is reachable")
 * does not require touching every test.
 */
export interface WelcomeStateInput {
  /** Currently selected chat. `null` if the user hasn't picked one. */
  currentChat: WelcomeChatLike
  /** Messages on the currently selected chat. The helper only looks at
   * `role` so any iterable of role-shaped objects works. */
  messages: ReadonlyArray<WelcomeMessageLike>
  /** True when the current chat has a live run on the run queue. The
   * welcome surface must hide for running chats because the transcript
   * is about to fill in. */
  isCurrentChatRunning: boolean
}

export interface WelcomeUsageDashboardBuildInput {
  isWelcomeChat: boolean
  isThreadHomeOpen: boolean
  isCurrentGlobalChat: boolean
  usageInitialized: boolean
  isMultiviewSplit: boolean
}

/**
 * Roles that represent real conversation content. Tool activity rows
 * count: a chat that already invoked a tool is not a welcome surface
 * candidate, even if no assistant text has streamed in yet.
 */
const CONVERSATION_ROLES: ReadonlyArray<ChatMessage['role']> = [
  'user',
  'assistant',
  'tool',
  'error'
]

/**
 * True when at least one message in `messages` represents real
 * conversation (`user` / `assistant` / `tool` / `error`).
 * System bookkeeping messages alone do not promote a chat out of the
 * welcome surface.
 */
export function hasConversationContent(messages: ReadonlyArray<WelcomeMessageLike>): boolean {
  for (const message of messages) {
    if (CONVERSATION_ROLES.indexOf(message.role) !== -1) {
      return true
    }
  }
  return false
}

/**
 * Decide whether the welcome / new-chat surface (hero greeting, starter
 * cards, usage dashboard) should render in place of the transcript.
 *
 * Extracted from `App.tsx` so the renderer can unit-test the gate
 * without standing up the entire chat shell. The renderer also uses
 * this value to gate the transcript message map — when this returns
 * `true`, `App.tsx` skips iterating the chat's `messages` so a stale
 * cross-workspace transcript cannot bleed through behind the welcome
 * hero.
 */
export function shouldRenderWelcome(input: WelcomeStateInput): boolean {
  if (!input.currentChat) return false
  if (input.isCurrentChatRunning) return false
  if (input.currentChat.parentChatId) return false
  if (input.currentChat.summaryOnly) {
    if ((input.currentChat.messageCount ?? 0) > 0) return false
    if ((input.currentChat.runCount ?? 0) > 0) return false
  }
  if (hasConversationContent(input.messages)) return false
  return true
}

/**
 * True only on a welcome screen or full Thread Home, the two surfaces that
 * consume this aggregation for the dashboard and/or standalone heatmaps.
 */
export function shouldBuildWelcomeUsageDashboardData(
  input: WelcomeUsageDashboardBuildInput
): boolean {
  return (
    (input.isWelcomeChat || input.isThreadHomeOpen) &&
    !input.isCurrentGlobalChat &&
    input.usageInitialized &&
    !input.isMultiviewSplit
  )
}

/**
 * A chat record (summary or full) plus the fields needed to decide whether it
 * is a *pristine* chat that can be reused on launch / workspace-open. Deliberately
 * mirrors `WelcomeChatRecordLike` and adds `messages` so a full record can be
 * inspected directly.
 */
export interface ReusableChatLike {
  parentChatId?: string
  summaryOnly?: boolean
  messageCount?: number
  runCount?: number
  messages?: ReadonlyArray<WelcomeMessageLike>
}

/**
 * True when selecting `chat` would land on the welcome / new-chat screen — i.e.
 * it is a top-level, genuinely untouched chat with no messages AND no runs.
 *
 * This is the record-only counterpart of `shouldRenderWelcome` (same
 * disqualifiers, minus the runtime `isCurrentChatRunning` gate) and MUST stay in
 * lockstep with it. Reuse call sites use this instead of a bare
 * `messageCount === 0` test: a summary chat with `messageCount: 0` but
 * `runCount > 0` (a run that started but never persisted a user/assistant/tool
 * message — an aborted, failed, or empty-result run) is NOT reusable, because
 * `shouldRenderWelcome` suppresses the hero for it. Selecting such a chat on
 * launch leaves a blank, non-welcome transcript.
 */
export function isReusableWelcomeChat(chat: ReusableChatLike): boolean {
  if (chat.parentChatId) return false
  if (chat.summaryOnly) {
    return (chat.messageCount ?? 0) === 0 && (chat.runCount ?? 0) === 0
  }
  return !hasConversationContent(chat.messages ?? [])
}
