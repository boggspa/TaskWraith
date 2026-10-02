export interface GoalHandoffTarget {
  paneId: string
  chatId: string
}

/** One-shot presentation intent; never reads or changes drafts or goal records. */
export function createMultiviewGoalHandoff() {
  let pending: GoalHandoffTarget | null = null
  return {
    request(target: GoalHandoffTarget): void {
      pending = { ...target }
    },
    observeFocus(paneId: string | null): void {
      if (pending && pending.paneId !== paneId) pending = null
    },
    reconcile(input: {
      panes: readonly { id: string; chatId: string | null }[]
      focusedPaneId: string | null
      projectedChatId: string | null
      open: () => void
    }): void {
      if (!pending) return
      const target = pending
      if (!input.panes.some((pane) => pane.id === target.paneId && pane.chatId === target.chatId)) {
        pending = null
        return
      }
      if (input.focusedPaneId !== target.paneId || input.projectedChatId !== target.chatId) return
      pending = null
      input.open()
    }
  }
}
