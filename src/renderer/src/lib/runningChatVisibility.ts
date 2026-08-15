import type { EnsembleRoundState, ProviderId } from '../../../main/store/types'
import { isEnsembleRoundPresentationLive } from '../../../shared/ensembleRoundLifecycle'

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
    runId?: string
    endedAt?: string
    status?: string
  }>
}

export interface RunningRunQueueJobLike {
  chatId?: string | null
  runId?: string | null
  status?: string
  startedAt?: string
  updatedAt?: string
  enqueuedAt?: string
  createdAt?: string
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
      if (chat && hasLiveTurnTransition(chat)) {
        result.push(chatId)
        continue
      }
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
  return Boolean(activeRound && !isEnsembleRoundPresentationLive(activeRound))
}

/**
 * Run queue rows are a second source of "active" sidebar state. They can be
 * newer than the last persisted run (legitimate queue work) or older than a
 * terminal run/round (stale durable queue work). Keep the new work visible
 * while suppressing rows whose own timestamp or run id proves they were
 * superseded by completed chat state.
 */
export function isRunQueueJobVisibleForChat(
  job: RunningRunQueueJobLike,
  chat: RunningChatRecordLike | null | undefined
): boolean {
  if (!job.chatId || !chat) return true
  if (isLiveTurnTransitionSourceJob(job, chat)) return true
  if (isRunQueueJobSupersededByInactiveEnsembleRound(job, chat)) return false
  if (isRunQueueJobSupersededByTerminalRun(job, chat)) return false
  return true
}

function hasLiveTurnTransition(chat: RunningChatRecordLike): boolean {
  const activeRound = chat.ensemble?.activeRound
  return Boolean(activeRound?.turnTransition && isEnsembleRoundPresentationLive(activeRound))
}

function isLiveTurnTransitionSourceJob(
  job: RunningRunQueueJobLike,
  chat: RunningChatRecordLike
): boolean {
  const activeRound = chat.ensemble?.activeRound
  return Boolean(
    activeRound?.turnTransition?.sourceRunId === job.runId &&
    isEnsembleRoundPresentationLive(activeRound)
  )
}

function isRunQueueJobSupersededByInactiveEnsembleRound(
  job: RunningRunQueueJobLike,
  chat: RunningChatRecordLike
): boolean {
  const activeRound = chat.ensemble?.activeRound
  if (!activeRound || isEnsembleRoundPresentationLive(activeRound)) return false
  const roundEndMs = Date.parse(activeRound.endedAt || '')
  const jobMs = runQueueJobTimeMs(job)
  if (Number.isFinite(roundEndMs) && Number.isFinite(jobMs)) return jobMs <= roundEndMs
  return job.status !== 'queued'
}

function isRunQueueJobSupersededByTerminalRun(
  job: RunningRunQueueJobLike,
  chat: RunningChatRecordLike
): boolean {
  const runs = chat.runs
  if (!runs || runs.length === 0) return false

  const matchingRun = job.runId
    ? runs.find((run) => run.runId && run.runId === job.runId)
    : undefined
  if (matchingRun && isTerminalRunSnapshot(matchingRun)) return true

  const latestTerminalRun = [...runs]
    .reverse()
    .find((run) => isTerminalRunSnapshot(run) && Number.isFinite(Date.parse(run.endedAt || '')))
  if (!latestTerminalRun) return false
  const runEndMs = Date.parse(latestTerminalRun.endedAt || '')
  const jobMs = runQueueJobTimeMs(job)
  if (Number.isFinite(runEndMs) && Number.isFinite(jobMs)) return jobMs <= runEndMs
  return false
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
  return isTerminalRunSnapshot(last)
}

function isTerminalRunSnapshot(run: { endedAt?: string; status?: string }): boolean {
  if (run.endedAt) return true
  switch (run.status) {
    case 'failed':
    case 'cancelled':
    case 'success':
    case 'success_with_warnings':
      return true
    default:
      return false
  }
}

function runQueueJobTimeMs(job: RunningRunQueueJobLike): number {
  for (const value of [job.startedAt, job.updatedAt, job.enqueuedAt, job.createdAt]) {
    const parsed = Date.parse(value || '')
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.NaN
}
