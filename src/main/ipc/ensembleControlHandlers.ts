import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'
import {
  formatBlackboardCapacityNotice,
  makeBlackboardEntry,
  upsertBlackboardEntry
} from '../blackboard/Blackboard'
import { GLOBAL_REMOTE_SCOPE } from '../RemoteWorkspaceAllowlist'
import type { BlackboardEntry, ChatRecord, EnsembleFanoutPolicy } from '../store/types'

/**
 * Collaborators owned by the composition root. The orchestrator is read through
 * a getter on every invocation because `ensembleOrchestratorRef` is a mutable
 * module-level binding assigned AFTER IPC registration — capturing it by value
 * here would pin `null` for the life of the process.
 */
export interface EnsembleControlHandlerDeps {
  getEnsembleOrchestrator: () => Pick<
    EnsembleOrchestrator,
    'steerQueuedPrompt' | 'removeQueuedPrompt'
  > | null
  isEnsembleModeEnabled: () => boolean
  getChat: (chatId: string) => ChatRecord | null | undefined
  requireNonEmptyString: (value: unknown, label: string) => string
  /** Main renderers may address every chat; secondary renderers are scoped. */
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  /** Throws when a scheduled round currently forbids interactive queue edits. */
  assertScheduledEnsembleInteractiveAvailable: (chatId: string) => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  broadcastThreadUpdate: (chatId: string, options?: { remoteProjectionSnapshot?: boolean }) => void
  saveAndBroadcastChat: (chat: ChatRecord) => void
  pushRemoteThreadSnapshot: (chat: ChatRecord, workspaceId: string) => void
  pushRemoteTaskCardDelta: (chatId: string) => void
  canonicalRemoteWorkspaceId: (workspaceId: string | null | undefined) => string | null
}

export interface BlackboardQueuedEnsemblePromptResult {
  ok: boolean
  entry?: BlackboardEntry
  error?: string
}

const ENSEMBLE_DISABLED_ERROR = 'Ensemble Mode is disabled.'
const ORCHESTRATOR_MISSING_ERROR = 'Ensemble orchestrator is not initialized.'

function normalizeQueueIndex(index: unknown): number {
  return Number.isFinite(index) ? Math.floor(Number(index)) : -1
}

/**
 * Shared by the renderer IPC below and the iOS bridge 'blackboard' op:
 * consume a queued ensemble prompt into a user-authored blackboard note.
 * The queue mutation is EXACTLY the Delete path (removeQueuedPrompt keeps
 * its textPrefix race-guard and restart-orphan recovery) — the live round
 * is never cancelled or interrupted, and the steer path is untouched.
 */
export function blackboardQueuedEnsemblePrompt(
  deps: EnsembleControlHandlerDeps,
  input: {
    chatId: string
    index: number
    textPrefix?: string
  }
): BlackboardQueuedEnsemblePromptResult {
  const removal = deps.getEnsembleOrchestrator()?.removeQueuedPrompt({
    chatId: input.chatId,
    index: input.index,
    ...(typeof input.textPrefix === 'string' ? { textPrefix: input.textPrefix } : {})
  }) ?? { ok: false, error: ORCHESTRATOR_MISSING_ERROR }
  if (!removal.ok || !removal.prompt?.trim()) {
    return {
      ok: false,
      error: removal.error || 'Queued item could not be moved to the blackboard.'
    }
  }
  const chat = deps.getChat(input.chatId)
  if (!chat?.ensemble) {
    return { ok: false, error: 'Blackboard entries require an Ensemble chat.' }
  }
  const createdAt = new Date().toISOString()
  const entry = makeBlackboardEntry({
    id: `blackboard-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chatId: chat.appChatId,
    roundId: chat.ensemble.activeRound?.roundId || 'manual',
    participantId: 'user',
    // Millisecond key (unlike the per-second user-note fallback) — rapid
    // "Add to Blackboard" clicks on several queued messages must not
    // upsert-collide on (participantId, key, scope).
    key: `queued-note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    value: removal.prompt,
    category: 'note',
    scope: 'session',
    createdAt
  })
  if (!entry) {
    return { ok: false, error: 'Blackboard entry requires non-empty key and value.' }
  }
  const upsert = upsertBlackboardEntry(chat.ensemble.blackboard || [], entry, {
    currentRoundId: chat.ensemble.activeRound?.roundId || 'manual',
    tombstones: chat.ensemble.blackboardTombstones,
    prunedAt: createdAt
  })
  if (!upsert.ok) {
    return {
      ok: false,
      error: `${upsert.code}: ${formatBlackboardCapacityNotice(chat.ensemble.blackboard || []) || 'Retire stale notes before posting again.'}`
    }
  }
  const updated: ChatRecord = {
    ...chat,
    ensemble: {
      ...chat.ensemble,
      blackboard: upsert.entries,
      blackboardTombstones: upsert.tombstones,
      updatedAt: createdAt
    },
    updatedAt: Date.now()
  }
  deps.saveAndBroadcastChat(updated)
  deps.broadcastThreadUpdate(updated.appChatId, { remoteProjectionSnapshot: false })
  const workspaceId =
    deps.canonicalRemoteWorkspaceId(updated.workspaceId) ??
    (!updated.workspaceId || updated.scope === 'global' ? GLOBAL_REMOTE_SCOPE : null)
  if (workspaceId) deps.pushRemoteThreadSnapshot(updated, workspaceId)
  // Moving a queued prompt changes both the task-card queue and thread blackboard.
  deps.pushRemoteTaskCardDelta(updated.appChatId)
  return { ok: true, entry }
}

/**
 * Renderer-facing controls for the Ensemble prompt QUEUE: promote a queued
 * prompt into the live round, drop it, or convert it into a blackboard note.
 * None of these cancel or interrupt the running round.
 */
export function registerEnsembleControlHandlers(deps: EnsembleControlHandlerDeps): void {
  ipcMain.handle(
    'steer-queued-ensemble-prompt',
    async (
      event,
      payload: {
        chatId?: string
        index?: number
        textPrefix?: string
        concurrentMode?: boolean
        fanoutPolicy?: EnsembleFanoutPolicy
      }
    ) => {
      if (!deps.isEnsembleModeEnabled()) {
        throw new Error(ENSEMBLE_DISABLED_ERROR)
      }
      const chatId = deps.requireNonEmptyString(payload?.chatId, 'Ensemble chat id')
      deps.assertSenderChatScope(event, chatId)
      const index = normalizeQueueIndex(payload?.index)
      deps.assertScheduledEnsembleInteractiveAvailable(chatId)
      return (
        deps.getEnsembleOrchestrator()?.steerQueuedPrompt({
          chatId,
          index,
          event,
          ...(typeof payload?.textPrefix === 'string' ? { textPrefix: payload.textPrefix } : {}),
          ...(payload?.concurrentMode !== undefined
            ? { concurrentMode: Boolean(payload.concurrentMode) }
            : {}),
          ...(payload?.fanoutPolicy !== undefined ? { fanoutPolicy: payload.fanoutPolicy } : {})
        }) ?? { status: 'ignored', error: ORCHESTRATOR_MISSING_ERROR }
      )
    }
  )

  ipcMain.handle(
    'remove-queued-ensemble-prompt',
    async (
      event,
      payload: {
        chatId?: string
        index?: number
        textPrefix?: string
      }
    ) => {
      if (!deps.isEnsembleModeEnabled()) {
        throw new Error(ENSEMBLE_DISABLED_ERROR)
      }
      const chatId = deps.requireNonEmptyString(payload?.chatId, 'Ensemble chat id')
      deps.assertSenderChatScope(event, chatId)
      const index = normalizeQueueIndex(payload?.index)
      const result = deps.getEnsembleOrchestrator()?.removeQueuedPrompt({
        chatId,
        index,
        ...(typeof payload?.textPrefix === 'string' ? { textPrefix: payload.textPrefix } : {})
      }) ?? { ok: false, error: ORCHESTRATOR_MISSING_ERROR }
      const updated = deps.getChat(chatId)
      if (updated) deps.broadcastChatUpdated(updated)
      deps.broadcastThreadUpdate(chatId, { remoteProjectionSnapshot: false })
      // Queued prompt removal is embedded in the task-card ensemble projection.
      deps.pushRemoteTaskCardDelta(chatId)
      return result
    }
  )

  ipcMain.handle(
    'blackboard-queued-ensemble-prompt',
    async (
      event,
      payload?: {
        chatId?: string
        index?: number
        textPrefix?: string
      }
    ) => {
      if (!deps.isEnsembleModeEnabled()) {
        throw new Error(ENSEMBLE_DISABLED_ERROR)
      }
      const chatId = deps.requireNonEmptyString(payload?.chatId, 'Ensemble chat id')
      deps.assertSenderChatScope(event, chatId)
      const index = normalizeQueueIndex(payload?.index)
      return blackboardQueuedEnsemblePrompt(deps, {
        chatId,
        index,
        ...(typeof payload?.textPrefix === 'string' ? { textPrefix: payload.textPrefix } : {})
      })
    }
  )
}
