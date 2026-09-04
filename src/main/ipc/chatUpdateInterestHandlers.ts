import { ipcMain, type IpcMainEvent } from 'electron'
import {
  CHAT_UPDATE_INTEREST_CHANNEL,
  normalizeChatUpdateInterestSnapshot,
  type ChatUpdateInterestSnapshot
} from '../../shared/chatUpdateInterest'
import type { ChatUpdateInterestRouter } from '../ChatUpdateInterestRouter'
import type { WorkspacePopoutAuthority } from '../WorkspacePopoutAuthority'

type ChatUpdateInterestRouterPort = Pick<
  ChatUpdateInterestRouter,
  | 'enabled'
  | 'snapshotForTarget'
  | 'replaceTargetSnapshot'
  | 'clearFullDeliveryTarget'
  | 'clearFullDeliveryChat'
>

export type ChatUpdateInterestSenderEvent = Pick<IpcMainEvent, 'sender'>

export interface ChatUpdateInterestHandlersDeps {
  router: ChatUpdateInterestRouterPort
  isMainRendererSender: (event: ChatUpdateInterestSenderEvent) => boolean
  workspacePopoutOwnerForSender: (senderId: number) => WorkspacePopoutAuthority | undefined
  /** Optional registration seam for focused tests and embedded main runtimes. */
  ipc?: Pick<typeof ipcMain, 'on'>
}

export type ChatUpdateInterestHandler = (
  event: ChatUpdateInterestSenderEvent,
  value: unknown
) => void

/**
 * Build the synchronous replacement-snapshot handler separately from Electron
 * registration so authorization and baseline transitions stay unit-testable.
 */
export function createChatUpdateInterestHandler(
  deps: ChatUpdateInterestHandlersDeps
): ChatUpdateInterestHandler {
  return (event, value): void => {
    if (!deps.router.enabled || event.sender.isDestroyed()) return

    // Renderer input is untrusted. Parse and bound it before doing authority
    // lookups or allocating registry state.
    const normalized = normalizeChatUpdateInterestSnapshot(value)
    if (!normalized) return

    let authorized: ChatUpdateInterestSnapshot = normalized
    if (!deps.isMainRendererSender(event)) {
      const owner = deps.workspacePopoutOwnerForSender(event.sender.id)
      if (owner?.kind !== 'chat' || !owner.chatId) return
      authorized = {
        ...normalized,
        entries: normalized.entries.filter((entry) => entry.chatId === owner.chatId)
      }
    }

    const targetId = event.sender.id
    const previous = deps.router.snapshotForTarget(targetId)
    const accepted = deps.router.replaceTargetSnapshot(targetId, authorized)
    if (!accepted) return

    if (previous === null) {
      // Before the first valid handshake every chat was implicitly full. No
      // bounded id list exists to diff, so discard all legacy full baselines
      // once; explicit full interests reseed on their next update.
      deps.router.clearFullDeliveryTarget(targetId)
      return
    }

    const nextModes = new Map(accepted.entries.map((entry) => [entry.chatId, entry.mode]))
    for (const entry of previous.entries) {
      if (entry.mode === 'full' && nextModes.get(entry.chatId) !== 'full') {
        deps.router.clearFullDeliveryChat(targetId, entry.chatId)
      }
    }
  }
}

export function registerChatUpdateInterestHandlers(deps: ChatUpdateInterestHandlersDeps): void {
  const ipc = deps.ipc ?? ipcMain
  ipc.on(CHAT_UPDATE_INTEREST_CHANNEL, createChatUpdateInterestHandler(deps))
}
