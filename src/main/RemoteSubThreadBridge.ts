import type { BridgeCreateSubThreadAction } from './BridgeActionPayload'
import type { CreateSubThreadInput } from './services/ChatService'
import type { ChatRecord, ProviderId } from './store/types'

export interface RemoteSubThreadBridgeDependencies {
  getChat: (threadId: string) => ChatRecord | null | undefined
  canonicalWorkspaceId: (workspaceId: string | null | undefined) => string | null
  globalWorkspaceId: string
  assertLiveProviderId: (provider: unknown) => ProviderId
  createSubThread: (input: CreateSubThreadInput) => ChatRecord
  broadcastChatUpdated: (chat: ChatRecord) => void
  broadcastThreadUpdate: (threadId: string) => void
  pushRemoteThreadSnapshot: (chat: ChatRecord, workspaceId: string) => void
}

export type RemoteSubThreadBridgeResult =
  | { ok: true; threadId: string }
  | { ok: false; error: string }

/**
 * Wire a paired-phone spawn request into the same ChatService contract used by
 * desktop `create-sub-thread`.
 *
 * This function deliberately creates only the durable child. The phone sends
 * its already user-authored prompt through the ordinary `composerPrompt`
 * action after the child id is acknowledged, so provider admission, run
 * posture, queue-on-busy behavior, and dispatch receipts stay on the one
 * existing start-turn path.
 */
export function createRemoteSubThread(
  action: BridgeCreateSubThreadAction,
  deps: RemoteSubThreadBridgeDependencies
): RemoteSubThreadBridgeResult {
  try {
    const parent = deps.getChat(action.threadId)
    if (!parent) return { ok: false, error: 'Parent thread not found' }

    const canonicalWorkspaceId = deps.canonicalWorkspaceId(parent.workspaceId)
    const parentRemoteScope = canonicalWorkspaceId
      ? canonicalWorkspaceId
      : parent.workspaceId
        ? null
        : deps.globalWorkspaceId
    if (!parentRemoteScope || parentRemoteScope !== action.workspaceId) {
      return { ok: false, error: 'Parent thread does not belong to this workspace' }
    }

    const provider = deps.assertLiveProviderId(action.provider)
    const child = deps.createSubThread({
      parentChatId: parent.appChatId,
      provider,
      delegationPrompt: action.prompt,
      returnResultToParent: action.returnResult !== false
    })

    deps.broadcastChatUpdated(child)
    deps.broadcastThreadUpdate(child.appChatId)
    const childWorkspaceId = deps.canonicalWorkspaceId(child.workspaceId)
    if (childWorkspaceId) deps.pushRemoteThreadSnapshot(child, childWorkspaceId)

    return { ok: true, threadId: child.appChatId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
