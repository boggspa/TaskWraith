import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  EnsembleLiveRoundConfigUpdateInput,
  EnsembleLiveRoundConfigUpdateResult,
  EnsembleOrchestrator
} from '../services/EnsembleOrchestrator'
import type { ChatRecord, EnsembleFanoutPolicy, EnsembleOrchestrationMode } from '../store/types'

const ENSEMBLE_FANOUT_POLICIES: readonly EnsembleFanoutPolicy[] = [
  'off',
  'read_only',
  'all',
  'locked_writers_with_boss',
  'locked_writers_user_preflight'
]

function invalidConfig(message: string): EnsembleLiveRoundConfigUpdateResult {
  return { ok: false, error: 'invalid_config', message }
}

export interface EnsembleChatHandlerDeps {
  getEnsembleOrchestrator: () => Pick<EnsembleOrchestrator, 'updateLiveRoundConfig'> | null
  getChat: (chatId: string) => ChatRecord | null
  /** Main renderers may address every chat; secondary renderers are scoped. */
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  broadcastThreadUpdate: (chatId: string, options?: { remoteProjectionSnapshot?: boolean }) => void
  pushRemoteTaskCardDelta: (chatId: string) => void
}

/**
 * Composer-owned Ensemble controls. Unlike a participant-seat mutation these
 * are round-wide admission settings, so MAIN changes the canonical runtime at
 * once and the next fan-out/continuation decision reads the new values.
 */
export function registerEnsembleChatHandlers(deps: EnsembleChatHandlerDeps): void {
  ipcMain.handle(
    'ensemble:update-live-round-config',
    (
      event,
      payload?: {
        chatId?: unknown
        orchestrationMode?: unknown
        fanoutPolicy?: unknown
        maxContinuationHops?: unknown
      }
    ): EnsembleLiveRoundConfigUpdateResult => {
      const chatId = typeof payload?.chatId === 'string' ? payload.chatId.trim() : ''
      if (!chatId) return invalidConfig('An Ensemble chat id is required.')
      deps.assertSenderChatScope(event, chatId)

      const hasMode = payload?.orchestrationMode !== undefined
      const hasFanoutPolicy = payload?.fanoutPolicy !== undefined
      const hasMaxContinuationHops = payload?.maxContinuationHops !== undefined
      if (!hasMode && !hasFanoutPolicy && !hasMaxContinuationHops) {
        return invalidConfig('Choose at least one live Ensemble round control to update.')
      }
      if (
        hasMode &&
        payload?.orchestrationMode !== 'continuous' &&
        payload?.orchestrationMode !== 'turn_bound'
      ) {
        return invalidConfig('Unsupported Ensemble orchestration mode.')
      }
      if (
        hasFanoutPolicy &&
        (typeof payload?.fanoutPolicy !== 'string' ||
          !ENSEMBLE_FANOUT_POLICIES.includes(payload.fanoutPolicy as EnsembleFanoutPolicy))
      ) {
        return invalidConfig('Unsupported Ensemble fan-out policy.')
      }
      if (
        hasMaxContinuationHops &&
        (typeof payload?.maxContinuationHops !== 'number' ||
          !Number.isFinite(payload.maxContinuationHops))
      ) {
        return invalidConfig('Continuation hops must be a finite number.')
      }

      const orchestrator = deps.getEnsembleOrchestrator()
      if (!orchestrator) {
        return invalidConfig('Ensemble orchestration is not initialized.')
      }
      const input: EnsembleLiveRoundConfigUpdateInput = {
        chatId,
        ...(hasMode
          ? { orchestrationMode: payload?.orchestrationMode as EnsembleOrchestrationMode }
          : {}),
        ...(hasFanoutPolicy ? { fanoutPolicy: payload?.fanoutPolicy as EnsembleFanoutPolicy } : {}),
        ...(hasMaxContinuationHops
          ? { maxContinuationHops: payload?.maxContinuationHops as number }
          : {})
      }
      const result = orchestrator.updateLiveRoundConfig(input)
      if (!result.ok) return result

      const chat = deps.getChat(chatId)
      if (chat) deps.broadcastChatUpdated(chat)
      deps.broadcastThreadUpdate(chatId, { remoteProjectionSnapshot: false })
      deps.pushRemoteTaskCardDelta(chatId)
      return result
    }
  )
}
