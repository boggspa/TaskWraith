/**
 * Whether an ordinary parent turn is still able to consume a delivered graph
 * result in-band. Graph-owned queue rows are deliberately excluded: during
 * terminal reconciliation the settling worker row is still nonterminal for a
 * moment and must not veto its own owner wake.
 */
export function hasNonGraphThreadTurn(
  jobs: ReadonlyArray<{ readonly chatId?: string; readonly executionGraph?: unknown }>,
  threadId: string
): boolean {
  return jobs.some((job) => job.chatId === threadId && !job.executionGraph)
}
