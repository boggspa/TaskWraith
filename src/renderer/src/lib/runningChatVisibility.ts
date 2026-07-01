import type { EnsembleRoundState, ProviderId } from '../../../main/store/types'
import { isEnsembleRoundDispatchLive } from '../../../shared/ensembleRoundLifecycle'

/**
 * A subset of `AgentApprovalRequest` that the visibility helper actually
 * needs to inspect. Keeping the type narrow (rather than importing the
 * full preload typing) means this helper stays test-friendly with no
 * dependency on the IPC layer.
 */
export interface RunningChatApprovalLike {
  provider: ProviderId
}

/**
 * Minimal shape of `ChatRecord` that the visibility helper needs:
 * provider id + the run-terminal hints persisted on the latest entry
 * of `runs[]`. Keeps the helper test-friendly without dragging the
 * full chat type (and its message/diff/etc fields) into scope.
 */
export interface RunningChatRecordLike {
  appChatId: string
  provider?: ProviderId
  ensemble?: {
    activeRound?: EnsembleRoundState | null
  }
  runs?: ReadonlyArray<{
    endedAt?: string
    status?: string
  }>
}

/**
 * Kimi keeps the wire-mode child process alive while it waits for the
 * user to resolve an `ApprovalRequest`. That means no `agent-exit`
 * fires, and the renderer's `runningChatIds` set never sheds the chat.
 * The sidebar then keeps painting a "Running" badge even though the
 * agent is parked on user input.
 *
 * Filter the visible "running" set so Kimi chats with a pending
 * approval drop out of the badge logic. Other providers retain their
 * existing semantics — for them, awaiting an approval is short and the
 * badge is intentional. Once the user resolves the Kimi approval, the
 * follow-up `agent-output`/`agent-exit` traffic restores the badge via
 * the regular `setRunningChatIds` path.
 *
 * Secondary defensive filter: when a chat's most recent run already
 * has a terminal `endedAt` (e.g. recovered from `run-queue.json` at
 * boot, or finished via `run_finished` but the matching `agent-exit`
 * IPC was dropped/raced), drop it from the visible set regardless of
 * provider. The in-memory `runningChatIds` set is purely additive
 * unless `clearActiveRunContext` runs; this layer makes the rendered
 * badge truthful even when that clear is missed. Without it,
 * `handleProviderExit`'s `if (!context) { syncRunningState(); return }`
 * early-return leaves the chat painted "Running" forever.
 */
export function visibleRunningChatIds(
  runningChatIds: ReadonlyArray<string> | ReadonlySet<string>,
  pendingApprovalsByChatId: Readonly<Record<string, RunningChatApprovalLike | null>>,
  chatsByAppChatId?: Readonly<Record<string, RunningChatRecordLike | null | undefined>>
): string[] {
  const iterable: Iterable<string> =
    runningChatIds instanceof Set ? runningChatIds : (runningChatIds as ReadonlyArray<string>)
  const result: string[] = []
  for (const chatId of iterable) {
    const pending = pendingApprovalsByChatId[chatId]
    if (pending && pending.provider === 'kimi') continue
    if (chatsByAppChatId) {
      const chat = chatsByAppChatId[chatId]
      if (chat && hasKnownInactiveEnsembleRound(chat)) continue
      if (chat && hasTerminalLastRun(chat)) continue
    }
    result.push(chatId)
  }
  return result
}

/**
 * True when an ensemble chat has a persisted activeRound snapshot, but that
 * snapshot no longer has dispatch evidence. This is the renderer-side guard
 * against orphan `runningChatIds` entries keeping the composer in Stop/queue
 * mode after the orchestrator has already finalized the ensemble round.
 */
export function hasKnownInactiveEnsembleRound(chat: RunningChatRecordLike): boolean {
  const activeRound = chat.ensemble?.activeRound
  return Boolean(activeRound && !isEnsembleRoundDispatchLive(activeRound))
}

/**
 * True iff the chat's most-recent run is in a terminal state (i.e.
 * has an `endedAt` set, or its persisted `status` is one of the
 * terminal labels). Treat unknown/missing runs as non-terminal so
 * fresh runs and recovery-pending chats stay rendered as "Running".
 */
export function hasTerminalLastRun(chat: RunningChatRecordLike): boolean {
  const runs = chat.runs
  if (!runs || runs.length === 0) return false
  const last = runs[runs.length - 1]
  if (last.endedAt) return true
  switch (last.status) {
    case 'failed':
    case 'cancelled':
    case 'success':
    case 'success_with_warnings':
      return true
    default:
      return false
  }
}
