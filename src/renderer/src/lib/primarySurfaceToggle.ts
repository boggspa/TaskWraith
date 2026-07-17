import type { ChatRecord, WorkspaceRecord } from '../../../main/store/types'
import { isReusableWelcomeChat, type ReusableChatLike } from './welcomeState'

/**
 * The two primary chat surfaces behind the sidebar's Chat / Code segmented
 * control. `'chat'` lists General (scope === 'global') chats, `'threads'`
 * (rendered as "Code") lists workspace chats. Projects is deliberately not a
 * surface: it is a cross-scope organisational view and never converts the
 * current chat.
 */
export type SidebarPrimarySurface = 'chat' | 'threads'

/**
 * Decide whether a user-initiated sidebar tab change selects a primary chat
 * surface. Shared by the segmented-control click and its arrow-key handler so
 * both fire the same callback; the tab-follows-chat effect must NOT route
 * through this (it reacts to a chat change, it doesn't request one).
 *
 * Returns the selected surface, or `null` when the change is a no-op or lands
 * on Projects (which never changes the chat type — sidebar only).
 */
export function primarySurfaceForSidebarTabChange(
  previousTab: string,
  nextTab: string
): SidebarPrimarySurface | null {
  if (nextTab === previousTab) return null
  if (nextTab !== 'chat' && nextTab !== 'threads') return null
  return nextTab
}

/**
 * The workspace a surface toggle (or "New workspace chat") should target when
 * the user is not already inside one: the current workspace if set, else the
 * most recently opened. Mirrors the sidebar's `defaultWorkspaceForNewChat`
 * ordering so every "which workspace do I mean?" surface agrees.
 */
export function pickLastOpenedWorkspace(
  currentWorkspace: WorkspaceRecord | null,
  workspaces: readonly WorkspaceRecord[]
): WorkspaceRecord | null {
  return (
    currentWorkspace ||
    [...workspaces].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0] ||
    null
  )
}

/**
 * The slice of a chat record the conversion planner inspects. Narrow on
 * purpose (same rationale as `ReusableChatLike`): tests build these inline
 * without the full main-process record type.
 */
export interface ConvertibleWelcomeChatLike extends ReusableChatLike {
  scope?: ChatRecord['scope']
  chatKind?: ChatRecord['chatKind']
  /** Full records carry their run ledger; any run disqualifies conversion. */
  runs?: ReadonlyArray<unknown>
}

/**
 * Record-level "safe to re-scope in place" gate shared by every surface that
 * moves a welcome draft across scopes (the sidebar Chat ⇄ Code toggle and the
 * welcome workspace picker): a top-level, never-started SINGLE draft.
 *
 * Stricter than the welcome render gate on full records: ANY run history
 * (even an aborted run that persisted no messages, which still renders the
 * welcome hero) disqualifies — a run ledger references workspace context a
 * rebind can't rewrite. Ensembles are excluded here by design; their curated
 * panels move through the dedicated welcome/EW41 rebind flows.
 *
 * Callers must still apply the runtime gates the record can't answer
 * (live/queued runs, workflow bindings) — see the App-side wrapper.
 */
export function isConvertiblePristineSingleDraft(
  chat: ConvertibleWelcomeChatLike | null | undefined
): chat is ConvertibleWelcomeChatLike {
  if (!chat) return false
  if (chat.chatKind === 'ensemble') return false
  if ((chat.runs?.length ?? 0) > 0 || (chat.runCount ?? 0) > 0) return false
  return isReusableWelcomeChat(chat)
}

export type PrimarySurfaceConversionPlan =
  | { kind: 'none' }
  | { kind: 'to-global' }
  | { kind: 'to-workspace'; workspace: WorkspaceRecord }

export interface PrimarySurfaceConversionInput {
  /** The surface the user just selected in the sidebar. */
  surface: SidebarPrimarySurface
  /** The currently focused chat (summary or full record). */
  chat: ConvertibleWelcomeChatLike | null | undefined
  /** True when the chat has a live or queued run. */
  isChatBusy: boolean
  /** True when the transcript area is split into multiview panes. */
  isMultiview: boolean
  /** True when the chat backs a workflow (saved definition or in-flight compose). */
  isWorkflowChat: boolean
  /** True when a workspace board, not the chat, fills the main pane. */
  hasActiveWorkspaceBoard: boolean
  currentWorkspace: WorkspaceRecord | null
  workspaces: readonly WorkspaceRecord[]
}

/**
 * Decide whether flipping the sidebar's Chat ⇄ Code control should re-scope
 * the focused chat to the selected surface.
 *
 * Conversion is deliberately narrow: only a pristine (never-started,
 * run-free, top-level) SINGLE welcome draft converts, and only across scopes
 * — a General draft to a workspace draft in the last-opened workspace, or a
 * workspace draft back to General. Everything else returns `{ kind: 'none' }`
 * and the toggle stays what it always was: a sidebar list switch.
 *
 * Ensembles never convert here — their curated panels move through the
 * dedicated welcome/EW41 rebind flows, and a sidebar toggle must never
 * relocate one silently. Workflow-compose drafts are intentionally empty
 * workspace chats and must keep their workspace binding. Busy, board-covered,
 * and multiview chats are skipped because the user is not looking at a lone
 * welcome screen.
 */
export function planPrimarySurfaceConversion(
  input: PrimarySurfaceConversionInput
): PrimarySurfaceConversionPlan {
  const chat = input.chat
  if (input.isChatBusy || input.isMultiview) return { kind: 'none' }
  if (input.isWorkflowChat || input.hasActiveWorkspaceBoard) return { kind: 'none' }
  if (!isConvertiblePristineSingleDraft(chat)) return { kind: 'none' }

  const isGlobal = chat.scope === 'global'
  if (input.surface === 'threads') {
    if (!isGlobal) return { kind: 'none' }
    const workspace = pickLastOpenedWorkspace(input.currentWorkspace, input.workspaces)
    if (!workspace) return { kind: 'none' }
    return { kind: 'to-workspace', workspace }
  }
  if (!isGlobal) return { kind: 'to-global' }
  return { kind: 'none' }
}
