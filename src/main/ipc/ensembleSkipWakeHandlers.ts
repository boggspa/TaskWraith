/**
 * Ensemble skip/wake IPC handlers, extracted from `src/main/index.ts` as a
 * behavior-preserving move.
 *
 * Two registrars preserve the original registration order: the skip trio is
 * registered before, and the wake pair after, the checkpoint/compaction
 * registrars that sit between them in the composition root. Do not merge
 * the two registrars into one — the split is positional, not logical.
 *
 * `ensembleOrchestratorRef` and `wakeupTimerServiceRef` are mutable
 * module-level bindings assigned AFTER IPC registration, so both are read
 * through getters on every invocation. Capturing either by value would pin
 * `null` for the life of the process.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'
import type { EnsembleWakeupRecord } from '../store/types'
import type { WakeupTimerService } from '../WakeupTimerService'

/**
 * Local alias mirroring the composition root (`index.ts`): only the sender
 * side of the event is ever inspected.
 */
type RendererSenderEvent = Pick<IpcMainInvokeEvent, 'sender'>

export interface EnsembleSkipWakeHandlerDeps {
  getEnsembleOrchestrator: () => Pick<
    EnsembleOrchestrator,
    | 'skipActiveParticipant'
    | 'skipReadFanout'
    | 'skipFanoutLane'
    | 'handleWakeupFired'
    | 'cancelWakeupById'
  > | null
  getWakeupTimerService: () => Pick<WakeupTimerService, 'cancel'> | null
  findPersistedEnsembleWakeup: (wakeupId: string) => EnsembleWakeupRecord | null
  savePersistedEnsembleWakeup: (wakeup: EnsembleWakeupRecord) => void
  requireNonEmptyString: (value: unknown, label: string) => string
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  isMainRendererSender: (event: RendererSenderEvent) => boolean
}

export function registerEnsembleSkipHandlers(deps: EnsembleSkipWakeHandlerDeps): void {
  ipcMain.handle('skip-ensemble-participant', async (event, chatId?: string) => {
    const canonicalChatId = deps.requireNonEmptyString(chatId, 'Ensemble chat id')
    deps.assertSenderChatScope(event, canonicalChatId)
    return deps.getEnsembleOrchestrator()?.skipActiveParticipant(canonicalChatId)
  })

  ipcMain.handle('skip-ensemble-read-fanout', async (event, chatId?: string) => {
    const canonicalChatId = deps.requireNonEmptyString(chatId, 'Ensemble chat id')
    deps.assertSenderChatScope(event, canonicalChatId)
    return deps.getEnsembleOrchestrator()?.skipReadFanout(canonicalChatId)
  })

  ipcMain.handle('skip-ensemble-fanout-lane', async (event, chatId?: string, laneId?: string) => {
    const canonicalChatId = deps.requireNonEmptyString(chatId, 'Ensemble chat id')
    const canonicalLaneId = deps.requireNonEmptyString(laneId, 'Fan-out lane id')
    deps.assertSenderChatScope(event, canonicalChatId)
    return deps.getEnsembleOrchestrator()?.skipFanoutLane(canonicalChatId, canonicalLaneId)
  })
}

export function registerEnsembleWakeHandlers(deps: EnsembleSkipWakeHandlerDeps): void {
  // 1.0.5-N7 — User-initiated Wake-Now from the participant chip
  // overflow. Forwards to the orchestrator's existing wakeup-fired
  // path; same code path as the timer firing naturally.
  ipcMain.handle('wake-ensemble-participant-now', async (event, wakeupId?: string) => {
    const id = deps.requireNonEmptyString(wakeupId, 'Wakeup id')
    const persisted = deps.findPersistedEnsembleWakeup(id)
    if (!persisted && !deps.isMainRendererSender(event)) {
      throw new Error('Renderer cannot resolve wakeup chat authority.')
    }
    if (persisted) deps.assertSenderChatScope(event, persisted.chatId)
    // The timer service holds an in-flight setTimeout; cancel it
    // first so the timer doesn't fire a duplicate after this user
    // wake. handleWakeupFired removes the record from
    // runtime.pendingWakeups, so the timer's onFire callback would
    // miss anyway — but explicit cancellation keeps the timer
    // bookkeeping clean.
    deps.getWakeupTimerService()?.cancel(id)
    return Boolean(deps.getEnsembleOrchestrator()?.handleWakeupFired(id))
  })

  // 1.0.5-N7 — User-initiated Cancel of a pending wakeup. Tries
  // the in-memory runtime path first; falls back to a direct
  // persisted-record cancel if the runtime isn't in memory
  // (e.g. post-restart before recovery armed the timer).
  ipcMain.handle('cancel-ensemble-participant-wakeup', async (event, wakeupId?: string) => {
    const id = deps.requireNonEmptyString(wakeupId, 'Wakeup id')
    const persistedBeforeCancel = deps.findPersistedEnsembleWakeup(id)
    if (!persistedBeforeCancel && !deps.isMainRendererSender(event)) {
      throw new Error('Renderer cannot resolve wakeup chat authority.')
    }
    if (persistedBeforeCancel) deps.assertSenderChatScope(event, persistedBeforeCancel.chatId)
    deps.getWakeupTimerService()?.cancel(id)
    const cancelled = deps.getEnsembleOrchestrator()?.cancelWakeupById(id, 'cancelled by user')
    if (cancelled) return { ok: true, cancelled }
    const persisted = deps.findPersistedEnsembleWakeup(id)
    if (!persisted || persisted.status !== 'pending') {
      return { ok: false, error: 'No pending wakeup matches.' }
    }
    const fallback = {
      ...persisted,
      status: 'cancelled' as const,
      cancelledAt: new Date().toISOString(),
      message: 'cancelled by user'
    }
    deps.savePersistedEnsembleWakeup(fallback)
    return { ok: true, cancelled: fallback }
  })
}
