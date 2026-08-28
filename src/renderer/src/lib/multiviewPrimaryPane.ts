import type { MultiviewPaneRecord } from '../../../shared/multiviewLayouts'

/**
 * Resolve the pane owned by the legacy/main chat before a close action.
 *
 * MainAppLayout still renders one action pill for the primary chat while a
 * split grid can have focus on another cell (for example an empty Thread Home
 * pane). Closing by focused index in that state removes the adjacent cell the
 * user is looking at, so the close target must be ownership-based instead.
 * Returning null is deliberate: if the primary chat is not represented in the
 * pane records, a close action must not guess and remove another pane.
 */
export function resolvePrimaryPaneIndex(
  panes: ReadonlyArray<MultiviewPaneRecord>,
  primaryChatId: string | null | undefined
): number | null {
  if (!primaryChatId) return null
  const index = panes.findIndex((pane) => pane.chatId === primaryChatId)
  return index >= 0 ? index : null
}
