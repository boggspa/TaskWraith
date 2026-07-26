/**
 * Turns a `ThreadMessageWake` decision into an actual run (S6 dispatch).
 *
 * Extracted so the one thing that must never happen here is visible in one file:
 * this dispatcher has NO access to a posture signer. `SoloChatWakeupService` is
 * constructed with `signRunPermissionPosture` because the USER scheduled that
 * wakeup and it may resume their permissions; a peer-requested wake may not, so
 * the dependency simply is not in this module's deps. `clampUntrustedRunPosture`
 * then turns the unsigned plan-mode payload into a re-derived read-only posture.
 *
 * Double-dispatch guard: a started run makes the target `busy`, which
 * `evaluateThreadMessageWake` already refuses on — but two ticks can race that
 * window, so dispatched wake ids are remembered. Waking a thread twice for one
 * message would put a peer's request in front of the user twice and burn a turn
 * doing it.
 */

import {
  evaluateThreadMessageWake,
  type ThreadMessageWakeRefusal,
  type ThreadMessageWakeTarget
} from './ThreadMessageWake'
import {
  pendingThreadMessages,
  summarizeThreadMessageInbox,
  type ThreadMessageInbox
} from '../shared/threadMessage'
import type { ProviderId } from './store/types'

/** Bounded so a long-lived process cannot grow the guard set without limit. */
export const MAX_REMEMBERED_DISPATCHED_WAKE_IDS = 512

export interface ThreadMessageWakeDispatchOutcome {
  woken: { chatId: string; appRunId: string; wakeMessageIds: string[] }[]
  skipped: { chatId: string; reason: ThreadMessageWakeRefusal | 'already-dispatched' | 'failed' }[]
}

export interface ThreadMessageWakeDispatcherDeps {
  /** Inboxes with undelivered messages (AppStore.getPendingThreadMessageInboxes). */
  getPendingInboxes: () => readonly ThreadMessageInbox[]
  /** Live facts about the receiving chat, or null when it cannot be woken. */
  resolveTarget: (chatId: string) => ThreadMessageWakeTarget | null
  dispatchRun: (payload: Record<string, unknown>) => Promise<{ dispatched: boolean }>
  createRunId: (provider: ProviderId) => string
  log?: (message: string) => void
}

/**
 * Dispatches at most one run per pending inbox. Returns what it did rather than
 * throwing, so one unroutable chat cannot stop the rest of the sweep.
 */
export function createThreadMessageWakeDispatcher(deps: ThreadMessageWakeDispatcherDeps): {
  dispatchPendingWakes: () => Promise<ThreadMessageWakeDispatchOutcome>
} {
  const dispatched = new Set<string>()

  function remember(ids: readonly string[]): void {
    for (const id of ids) dispatched.add(id)
    if (dispatched.size > MAX_REMEMBERED_DISPATCHED_WAKE_IDS) {
      // Oldest-first: Set preserves insertion order.
      const excess = dispatched.size - MAX_REMEMBERED_DISPATCHED_WAKE_IDS
      let dropped = 0
      for (const id of dispatched) {
        if (dropped >= excess) break
        dispatched.delete(id)
        dropped += 1
      }
    }
  }

  async function dispatchPendingWakes(): Promise<ThreadMessageWakeDispatchOutcome> {
    const outcome: ThreadMessageWakeDispatchOutcome = { woken: [], skipped: [] }
    for (const inbox of deps.getPendingInboxes()) {
      const chatId = inbox.toChatId
      const target = deps.resolveTarget(chatId)
      if (!target) {
        outcome.skipped.push({ chatId, reason: 'target-archived' })
        continue
      }
      const pending = pendingThreadMessages(inbox)
      const decision = evaluateThreadMessageWake({
        target,
        pending,
        summary: summarizeThreadMessageInbox(inbox)
      })
      if (!decision.wake) {
        outcome.skipped.push({ chatId, reason: decision.reason })
        continue
      }
      // Every wake id already dispatched means this is the same request coming
      // round again; a NEW id alongside old ones is still worth waking for.
      if (decision.payload.wakeMessageIds.every((id) => dispatched.has(id))) {
        outcome.skipped.push({ chatId, reason: 'already-dispatched' })
        continue
      }

      const appRunId = deps.createRunId(target.provider)
      try {
        // Spread, then appRunId. The payload deliberately carries no
        // effectivePermissions / sessionTrust / signature, and nothing is added
        // here — see ThreadMessageWake for why that omission is the enforcement.
        const result = await deps.dispatchRun({ ...decision.payload, appRunId })
        if (!result.dispatched) {
          outcome.skipped.push({ chatId, reason: 'failed' })
          continue
        }
        remember(decision.payload.wakeMessageIds)
        outcome.woken.push({
          chatId,
          appRunId,
          wakeMessageIds: [...decision.payload.wakeMessageIds]
        })
      } catch (error) {
        // Not remembered on failure, so a transient dispatch error retries on the
        // next sweep rather than silently swallowing the request.
        deps.log?.(
          `[ThreadMessageWake] dispatch failed for ${chatId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        outcome.skipped.push({ chatId, reason: 'failed' })
      }
    }
    return outcome
  }

  return { dispatchPendingWakes }
}
