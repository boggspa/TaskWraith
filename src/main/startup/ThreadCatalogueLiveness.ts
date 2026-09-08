export function catalogueChatHasLiveWork(
  chatId: string,
  sources: {
    activeSessions(): readonly { appChatId?: string; runId: string }[]
    bridge: ReadonlyMap<string, { chatId: string }>
    background: ReadonlyMap<string, { chatId: string }>
    queuedRuns(chatId: string): readonly { runId?: string }[]
    isRunLive(runId: string): boolean
  }
): boolean {
  if (
    sources.activeSessions().some((run) => run.appChatId === chatId && sources.isRunLive(run.runId))
  )
    return true
  for (const map of [sources.bridge, sources.background])
    for (const [id, run] of map) if (run.chatId === chatId && sources.isRunLive(id)) return true
  return sources
    .queuedRuns(chatId)
    .some((run) => Boolean(run.runId && sources.isRunLive(run.runId)))
}
