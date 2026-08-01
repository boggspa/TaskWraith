import type { ChatRecord, ChatRun } from '../../../main/store/types'
import { applyPendingProviderChangeOnFinalize } from '../../../shared/providerChangeQueue'

/**
 * Defensive terminal-seal for a run whose LIVE context was lost, so the normal
 * seal in `handleProviderExit` cannot run — it early-returns on a
 * `resolveActiveRunContext` miss.
 *
 * That miss happens when the main process restarts mid-run, or a shared codex
 * app-server exit is delivered to a renderer that no longer holds the run in
 * `activeRunsRef` (cf. the MCP cross-instance write-leak landmine). Without a
 * fallback the run keeps `endedAt`/`status`/`stats` undefined forever: the
 * composer footer token tally stays empty, the Sidebar paints the chat
 * "Running" indefinitely, and the run's usage never lands in the token/cost
 * totals (`buildChatTokenTally` reads sealed `run.stats`).
 *
 * Safety:
 *  - Matches ONLY by exact `runId` — never the chatId/provider heuristic — so a
 *    foreign, main-process-driven run can never be spliced onto the user's own
 *    in-flight run of the same provider.
 *  - Leaves an already-sealed run (has `endedAt`) untouched: the live
 *    `run_finished`/exit handlers win; this is the orphan fallback only.
 *  - `agent-exit` is terminal by definition, so stamping a terminal state on
 *    receipt is always correct for the matched run.
 *
 * Pure so the recovery is pinned by a Vitest unit test without an Electron
 * renderer, mirroring `recoverChatRunTerminals`.
 */
export function sealOrphanExitRun(
  chat: ChatRecord,
  runId: string | undefined,
  exit: { stats?: unknown; exitCode: number; endedAt: string }
): ChatRecord {
  if (!runId) return chat
  const runs = chat.runs || []
  const index = runs.findIndex((run) => run.runId === runId)
  if (index < 0) return chat
  const run = runs[index]
  if (run.endedAt) return chat

  const sealed: ChatRun = {
    ...run,
    endedAt: exit.endedAt,
    status: run.status || (exit.exitCode === 0 ? 'success' : 'failed'),
    exitCode: run.exitCode ?? (exit.exitCode || undefined)
  }
  // Only adopt exit stats when the run has none of its own, and only when they
  // are a usable object (never an array / scalar).
  if (
    run.stats == null &&
    exit.stats != null &&
    typeof exit.stats === 'object' &&
    !Array.isArray(exit.stats)
  ) {
    sealed.stats = exit.stats
  }

  const nextRuns = [...runs]
  nextRuns[index] = sealed
  return { ...chat, runs: nextRuns }
}

/**
 * Full orphan agent-exit finalize for the `!context` branch of
 * `handleProviderExit`: seal by exact runId, then apply a queued solo model /
 * provider switch the same way the live exit path does. Ensemble chats keep
 * pending seat/roster handling on the orchestrator path and skip solo apply.
 */
export function finalizeOrphanAgentExitChat(
  chat: ChatRecord,
  runId: string | undefined,
  exit: { stats?: unknown; exitCode: number; endedAt: string }
): ChatRecord {
  const sealed = sealOrphanExitRun(chat, runId, exit)
  if (sealed.chatKind === 'ensemble') return sealed
  return applyPendingProviderChangeOnFinalize(sealed)
}

/**
 * Whether an orphan exit may drop `chatId` from `runningChatIds`. Only when no
 * remaining `activeRunsRef` entry still claims that chat (exact id).
 */
export function shouldPruneRunningChatIdAfterOrphanExit(
  chatId: string,
  activeRunChatIds: Iterable<string>
): boolean {
  for (const activeChatId of activeRunChatIds) {
    if (activeChatId === chatId) return false
  }
  return true
}
