import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron'
import * as fsSync from 'fs'
import { join } from 'path'
import type { KeyPair } from '../../shared/e2ee/keys'
import type {
  HumanCollaborationAppendCommentInput,
  HumanCollaborationBeginHandshakeInput,
  HumanCollaborationConfirmSasInput,
  HumanCollaborationDisconnectInput,
  HumanCollaborationEncryptedFrame,
  HumanCollaborationSubscribeProjectionInput
} from '../../shared/collaboration/HumanCollaborationProtocol'
import { buildHumanShareProjection } from '../collaboration/HumanShareProjection'
import type {
  CreateShareResult,
  HumanCollaborationShare
} from '../collaboration/HumanCollaborationStore'
import type { HumanContributionPreset } from '../collaboration/HumanContributionRules'
import { HumanCollaborationCollaboratorClient } from '../collaboration/HumanCollaborationCollaboratorClient'
import {
  HumanCollaborationIdentityStore,
  type HumanCollaborationSafeStorage
} from '../collaboration/HumanCollaborationIdentityStore'
import type { ChatService } from '../services/ChatService'
import type { AppSettings, ChatRecord } from '../store/types'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'

interface IosRemoteRuntimeLike {
  describeHost: () => { relayUrls: string[] }
}

interface SelfHostedWssLane {
  wssUrl: string
  cliPath: string | null
  relayPort: number
  candidates: string[]
}

interface TailscaleServeStatus {
  configured: boolean
}

interface EnableTailscaleServeResult {
  ok: boolean
  message?: string
}

interface AdvertisableRelaySelection {
  advertisable: string[]
  warnings: string[]
}

interface HumanCollaborationRuntimeLike {
  hostIdentityPubKeyB64: () => string
  connectedChatIds: () => string[]
  sessionSummaries: () => unknown[]
  publishProjectionUpdates: (chatId: string) => Promise<void>
  beginAdmission: (input: HumanCollaborationBeginHandshakeInput) => unknown
  confirmSas: (
    input: HumanCollaborationConfirmSasInput
  ) => Promise<{ chatId: string }> | { chatId: string }
  subscribeProjection: (
    input: HumanCollaborationSubscribeProjectionInput,
    opts?: { observedFromCollaborator?: boolean }
  ) => unknown
  appendComment: (input: HumanCollaborationAppendCommentInput) => unknown
  routeEncryptedAction: (input: HumanCollaborationEncryptedFrame) => unknown
  disconnect: (input: HumanCollaborationDisconnectInput) => unknown
}

type HumanCollaborationChatService = Pick<
  ChatService,
  | 'getChat'
  | 'createHumanCollaborationShare'
  | 'listHumanCollaborationShares'
  | 'revokeHumanCollaborationShare'
  | 'revokeHumanCollaborationParticipant'
  | 'consumeHumanCollaborationInvite'
  | 'appendCollaboratorComment'
  | 'promoteCollaboratorComment'
  | 'updateHumanCollaborationShareRules'
  | 'getExternalContribution'
  | 'listPendingExternalContributions'
  | 'approveExternalContribution'
  | 'denyExternalContribution'
  | 'setHumanCollaborationHostReview'
>

interface HumanCollaborationStoreLike {
  getShare: (shareId: string) => HumanCollaborationShare | null
  getShareForChat: (chatId: string) => HumanCollaborationShare | null
}

interface HumanCollaborationAuditLogLike {
  list: (input: { chatId?: string; limit?: number }) => unknown
}

export type HumanCollaborationSenderScope =
  | { kind: 'main' }
  | { kind: 'chat'; chatId: string }

export interface HumanCollaborationHandlersDeps {
  chatService: HumanCollaborationChatService
  humanCollaborationStore: HumanCollaborationStoreLike
  humanCollaborationAuditLog: HumanCollaborationAuditLogLike
  getSettings: () => AppSettings
  getUserDataPath: () => string
  safeStorage: HumanCollaborationSafeStorage
  getIosRemoteRuntime: () => IosRemoteRuntimeLike | null
  getIosRemoteRuntimeError: () => string | null
  getSelfHostedWssLane: () => SelfHostedWssLane | null
  startIosRemoteBridge: (reason: string) => Promise<void>
  maybeUpgradeIosRemoteToTailscaleLane: (reason: string) => Promise<void>
  getIosRemoteTailscaleStatus: () => Promise<Record<string, unknown>>
  getIosRemoteServeHttpsPort: () => number
  collaborationHostRelayUrl: () => string
  collaborationInviteRelayUrls: () => string[]
  getTailscaleServeStatus: (input: {
    cliPath: string
    relayPort: number
    httpsPort: number
  }) => Promise<TailscaleServeStatus>
  enableTailscaleServe: (input: {
    cliPath: string
    relayPort: number
    httpsPort: number
  }) => Promise<EnableTailscaleServeResult>
  selectAdvertisableRelayUrls: (relayUrls: string[]) => Promise<AdvertisableRelaySelection>
  getHumanCollaborationRuntime: () => HumanCollaborationRuntimeLike
  getCurrentHumanCollaborationRuntime: () => HumanCollaborationRuntimeLike | null
  openCollaborationHostRoom: (relayUrl: string, roomId: string) => void
  closeCollaborationHostRoom: (roomId: string) => void
  socketFactory: TransportSocketFactory
  sendToMainWindow: (channel: string, payload: unknown) => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  broadcastHumanCollaborationUpdate: (chatId: string) => void
  /**
   * Rebuild and publish the collaborator-facing projection for one chat.
   *
   * Distinct from `broadcastHumanCollaborationUpdate`, which reaches the HOST
   * renderer only. Approving or denying changes what the CONTRIBUTOR should
   * see (`yourPending`), and nothing else on this path would tell them:
   * approve/deny mutate a JSON file and do not touch the ChatRecord, so the
   * projection's usual trigger — broadcastChatUpdated — never fires.
   */
  republishHumanCollaborationProjection: (chatId: string) => void
  /**
   * The main renderer may manage every collaboration share. A chat popout is
   * bound by main to one persisted chat and must not use payload chat/share
   * identifiers as authority for another conversation.
   */
  resolveSenderHumanCollaborationScope: (
    event: IpcMainInvokeEvent
  ) => HumanCollaborationSenderScope
  /**
   * Global collaborator-client state and host-runtime operations that cannot
   * be resolved to a persisted chat before mutation remain main-window only.
   */
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
}

export interface HumanCollaborationHandlersRegistration {
  dispose: () => void
}

interface CollaboratorSessionRecord {
  shareId: string
  chatId: string
  collaboratorId: string
  displayName: string
  mode: 'readOnly' | 'comments'
  relayUrls: string[]
  roomId: string
  hostIdentityPubKeyB64: string
  savedAt: number
}

function retryableJoinError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /transport|connect timed out|timed out|socket|websocket|ECONN|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(
    message
  )
}

/**
 * An invite can advertise several relay doors (tailnet wss, LAN, loopback, a
 * manually-configured public URL) and we try each in turn. Reporting only the
 * LAST failure hides which doors were attempted — on a cross-network join the
 * useful signal is precisely "the wss door refused but the LAN door timed out".
 * Aggregate every attempt into one actionable message.
 */
export function describeRelayAttemptFailures(
  attempts: ReadonlyArray<{ relayUrl: string; error: unknown }>,
  fallbackMessage: string
): Error {
  if (attempts.length === 0) return new Error(fallbackMessage)
  const lines = attempts.map(({ relayUrl, error }) => {
    const detail = error instanceof Error ? error.message : String(error)
    return `  • ${relayUrl} — ${detail}`
  })
  const header =
    attempts.length === 1
      ? 'Could not reach the collaboration relay.'
      : `Could not reach any of the ${attempts.length} collaboration relay URLs in this invite.`
  return new Error(`${header}\n${lines.join('\n')}`)
}

export function registerHumanCollaborationHandlers(
  deps: HumanCollaborationHandlersDeps
): HumanCollaborationHandlersRegistration {
  const assertSenderOwnsPersistedChat = (
    event: IpcMainInvokeEvent,
    chatId: string
  ): ChatRecord => {
    const scope = deps.resolveSenderHumanCollaborationScope(event)
    if (scope.kind === 'chat' && scope.chatId !== chatId) {
      throw new Error('Renderer does not own this collaboration chat.')
    }
    const chat = deps.chatService.getChat(chatId)
    if (!chat) throw new Error('Collaboration chat not found.')
    return chat
  }

  const assertSenderOwnsPersistedShare = (
    event: IpcMainInvokeEvent,
    shareId: string,
    requestedChatId?: string
  ): HumanCollaborationShare => {
    const share = deps.humanCollaborationStore.getShare(shareId)
    if (!share) throw new Error('Collaboration share not found.')
    if (requestedChatId !== undefined && share.chatId !== requestedChatId) {
      throw new Error('Collaboration share does not belong to the requested chat.')
    }
    assertSenderOwnsPersistedChat(event, share.chatId)
    return share
  }

  const resolveSenderShareListChatId = (
    event: IpcMainInvokeEvent,
    requestedChatId?: string
  ): string | undefined => {
    const scope = deps.resolveSenderHumanCollaborationScope(event)
    if (scope.kind === 'main') return requestedChatId
    if (requestedChatId !== undefined && requestedChatId !== scope.chatId) {
      throw new Error('Renderer does not own this collaboration chat.')
    }
    assertSenderOwnsPersistedChat(event, scope.chatId)
    return scope.chatId
  }

  const resolveHumanCollaborationProjection = (input: {
    shareId: string
    chatId: string
    collaboratorId: string
  }) => {
    const share = deps.humanCollaborationStore.getShare(input.shareId)
    if (!share || !share.enabled || share.chatId !== input.chatId) {
      throw new Error('Collaboration share is not active.')
    }
    const participant = share.participants.find(
      (candidate) => candidate.collaboratorId === input.collaboratorId
    )
    if (!participant || participant.status !== 'active') {
      throw new Error('Collaborator is not active for this share.')
    }
    const chat = deps.chatService.getChat(input.chatId)
    if (!chat) throw new Error('Chat not found.')
    return buildHumanShareProjection(chat, share)
  }

  const prepareHumanCollaborationInviteTransport = async (): Promise<{
    relayUrl: string
    relayUrls: string[]
    relayWarning?: string
  }> => {
    if (!deps.getIosRemoteRuntime()) {
      await deps.startIosRemoteBridge('human collaboration invite')
    }
    if (deps.getIosRemoteRuntime() && !deps.getSelfHostedWssLane()) {
      await deps.maybeUpgradeIosRemoteToTailscaleLane('human collaboration invite')
    }
    const runtime = deps.getIosRemoteRuntime()
    if (!runtime) {
      const relayUrls = deps.collaborationInviteRelayUrls()
      const runtimeError = deps.getIosRemoteRuntimeError()
      return {
        relayUrl: relayUrls[0] ?? '',
        relayUrls,
        ...(runtimeError ? { relayWarning: `Remote bridge is not running: ${runtimeError}` } : {})
      }
    }
    const runtimeRelayUrls = runtime.describeHost().relayUrls
    const lane = deps.getSelfHostedWssLane()
    const relayCandidates = lane?.candidates.length ? lane.candidates : runtimeRelayUrls
    let selection = await deps.selectAdvertisableRelayUrls(relayCandidates)
    if (lane) {
      if (!selection.advertisable.includes(lane.wssUrl) && lane.cliPath) {
        const httpsPort = deps.getIosRemoteServeHttpsPort()
        const serve = await deps.getTailscaleServeStatus({
          cliPath: lane.cliPath,
          relayPort: lane.relayPort,
          httpsPort
        })
        if (!serve.configured) {
          const enabled = await deps.enableTailscaleServe({
            cliPath: lane.cliPath,
            relayPort: lane.relayPort,
            httpsPort
          })
          console[enabled.ok ? 'warn' : 'error'](
            `[human-collaboration] invite self-heal: tailscale serve was off — re-enable ${
              enabled.ok ? 'succeeded' : `FAILED: ${enabled.message ?? 'unknown'}`
            }`
          )
          if (enabled.ok) selection = await deps.selectAdvertisableRelayUrls(lane.candidates)
        }
      }
    }
    const relayUrls = selection.advertisable
    return {
      relayUrl: relayUrls[0] ?? '',
      relayUrls,
      ...(selection.warnings.length > 0
        ? { relayWarning: `A relay door was left out of the invite: ${selection.warnings.join('; ')}` }
        : {})
    }
  }

  ipcMain.handle('human-collaboration:invite-health', async (event, chatId: string) => {
    assertSenderOwnsPersistedChat(event, chatId)
    const chat = deps.chatService.getChat(chatId)
    const share = deps.humanCollaborationStore.getShareForChat(chatId)
    const settings = deps.getSettings()
    const tailscale = await deps.getIosRemoteTailscaleStatus()
    const runtimeError = deps.getIosRemoteRuntimeError()
    return {
      chatAvailable: Boolean(chat && !chat.archived),
      shareEnabled: Boolean(share?.enabled),
      bridgeEnabled: settings.iosRemoteEnabled === true,
      bridgeRunning: deps.getIosRemoteRuntime() !== null,
      ...(runtimeError ? { bridgeError: runtimeError } : {}),
      relayUrls: deps.collaborationInviteRelayUrls(),
      tailscaleConfigured: Boolean(tailscale.active || tailscale.usingSavedRelayFallback),
      tailscaleSuggestedUrl:
        typeof tailscale.suggestedUrl === 'string' ? tailscale.suggestedUrl : null,
      tailscaleReason:
        typeof tailscale.tailscaleReason === 'string' ? tailscale.tailscaleReason : null
    }
  })

  ipcMain.handle(
    'human-collaboration:create-share',
    async (event, input: { chatId: string; mode?: 'readOnly' | 'comments'; inviteTtlMs?: number }) => {
      assertSenderOwnsPersistedChat(event, input.chatId)
      const inviteTransport = await prepareHumanCollaborationInviteTransport()
      const result: CreateShareResult = deps.chatService.createHumanCollaborationShare({
        chatId: input.chatId,
        mode: input.mode === 'readOnly' ? 'readOnly' : 'comments',
        inviteTtlMs: input.inviteTtlMs
      })
      const runtime = deps.getHumanCollaborationRuntime()
      const hostRelay = deps.collaborationHostRelayUrl()
      if (hostRelay && result.roomId) {
        deps.openCollaborationHostRoom(hostRelay, result.roomId)
      }
      deps.broadcastHumanCollaborationUpdate(result.share.chatId)
      return {
        ...result,
        relayUrl: inviteTransport.relayUrl,
        relayUrls: inviteTransport.relayUrls,
        relayWarning: inviteTransport.relayWarning,
        hostIdentityPubKeyB64: runtime.hostIdentityPubKeyB64()
      }
    }
  )

  ipcMain.handle('human-collaboration:copy-invite', (_, input: { invite?: string }) => {
    const invite = typeof input?.invite === 'string' ? input.invite.trim() : ''
    if (!invite) throw new Error('Invite payload is empty.')
    if (invite.length > 128_000) throw new Error('Invite payload is too large.')
    clipboard.writeText(invite, 'clipboard')
    return { ok: true }
  })

  ipcMain.handle('human-collaboration:list-shares', (event, chatId?: string) => {
    const scopedChatId = resolveSenderShareListChatId(event, chatId)
    return deps.chatService.listHumanCollaborationShares(scopedChatId)
  })

  ipcMain.handle('human-collaboration:connected-chat-ids', (event) => {
    const scope = deps.resolveSenderHumanCollaborationScope(event)
    const connected = deps.getCurrentHumanCollaborationRuntime()?.connectedChatIds() ?? []
    return scope.kind === 'main' ? connected : connected.filter((chatId) => chatId === scope.chatId)
  })

  ipcMain.handle('human-collaboration:session-status', (event) => {
    const scope = deps.resolveSenderHumanCollaborationScope(event)
    const sessions = deps.getCurrentHumanCollaborationRuntime()?.sessionSummaries() ?? []
    if (scope.kind === 'main') return sessions
    return sessions.filter(
      (session) =>
        session !== null &&
        typeof session === 'object' &&
        'chatId' in session &&
        session.chatId === scope.chatId
    )
  })

  ipcMain.handle('human-collaboration:revoke-share', (event, shareId: string) => {
    const target = assertSenderOwnsPersistedShare(event, shareId)
    const result = deps.chatService.revokeHumanCollaborationShare(shareId)
    for (const invite of target?.invites || []) {
      if (invite.roomId) deps.closeCollaborationHostRoom(invite.roomId)
    }
    if (result) deps.broadcastHumanCollaborationUpdate(result.chatId)
    return result
  })

  ipcMain.handle(
    'human-collaboration:revoke-participant',
    (event, input: { shareId: string; collaboratorId: string }) => {
      assertSenderOwnsPersistedShare(event, input.shareId)
      const result = deps.chatService.revokeHumanCollaborationParticipant(
        input.shareId,
        input.collaboratorId
      )
      if (result) {
        const invite = result.invites.find(
          (candidate) => candidate.collaboratorId === input.collaboratorId
        )
        if (invite?.roomId) deps.closeCollaborationHostRoom(invite.roomId)
        deps.broadcastHumanCollaborationUpdate(result.chatId)
      }
      return result
    }
  )

  ipcMain.handle(
    'human-collaboration:consume-invite',
    (
      event,
      input: {
        shareId: string
        inviteToken: string
        displayName: string
        publicKeyId: string
      }
    ) => {
      assertSenderOwnsPersistedShare(event, input.shareId)
      const result = deps.chatService.consumeHumanCollaborationInvite(input)
      deps.broadcastHumanCollaborationUpdate(result.share.chatId)
      return result
    }
  )

  ipcMain.handle(
    'human-collaboration:append-comment',
    (
      event,
      input: {
        shareId: string
        chatId: string
        collaboratorId: string
        clientMessageId: string
        content: string
      }
    ) => {
      assertSenderOwnsPersistedShare(event, input.shareId, input.chatId)
      const result = deps.chatService.appendCollaboratorComment(input)
      deps.broadcastChatUpdated(result.chat)
      deps.broadcastHumanCollaborationUpdate(result.chat.appChatId)
      return result
    }
  )

  ipcMain.handle(
    'human-collaboration:projection',
    (event, input: { shareId: string; chatId: string; collaboratorId: string }) => {
      assertSenderOwnsPersistedShare(event, input.shareId, input.chatId)
      return resolveHumanCollaborationProjection(input)
    }
  )

  ipcMain.handle(
    'human-collaboration-runtime:begin-admission',
    (event, input: HumanCollaborationBeginHandshakeInput) => {
      assertSenderOwnsPersistedShare(event, input.shareId, input.chatId)
      return deps.getHumanCollaborationRuntime().beginAdmission(input)
    }
  )

  ipcMain.handle(
    'human-collaboration-runtime:confirm-sas',
    async (event, input: HumanCollaborationConfirmSasInput) => {
      deps.assertMainRendererSender(event)
      const result = await deps.getHumanCollaborationRuntime().confirmSas(input)
      deps.broadcastHumanCollaborationUpdate(result.chatId)
      return result
    }
  )

  ipcMain.handle(
    'human-collaboration-runtime:subscribe-projection',
    (event, input: HumanCollaborationSubscribeProjectionInput) => {
      deps.assertMainRendererSender(event)
      // A collaborator client asking for its own projection — real evidence
      // they are present, unlike a host-driven republish.
      return deps
        .getHumanCollaborationRuntime()
        .subscribeProjection(input, { observedFromCollaborator: true })
    }
  )

  ipcMain.handle(
    'human-collaboration-runtime:append-comment',
    (event, input: HumanCollaborationAppendCommentInput) => {
      deps.assertMainRendererSender(event)
      return deps.getHumanCollaborationRuntime().appendComment(input)
    }
  )

  ipcMain.handle(
    'human-collaboration-runtime:receive-frame',
    (event, input: HumanCollaborationEncryptedFrame) => {
      deps.assertMainRendererSender(event)
      return deps.getHumanCollaborationRuntime().routeEncryptedAction(input)
    }
  )

  ipcMain.handle(
    'human-collaboration-runtime:disconnect',
    (event, input: HumanCollaborationDisconnectInput) => {
      deps.assertMainRendererSender(event)
      return deps.getHumanCollaborationRuntime().disconnect(input)
    }
  )

  ipcMain.handle(
    'human-collaboration:promote-comment',
    (event, input: { chatId: string; messageId: string }) => {
      assertSenderOwnsPersistedChat(event, input.chatId)
      const result = deps.chatService.promoteCollaboratorComment(input)
      deps.broadcastChatUpdated(result.chat)
      deps.broadcastHumanCollaborationUpdate(result.chat.appChatId)
      return result
    }
  )

  ipcMain.handle(
    'human-collaboration:update-share-rules',
    (event, input: { shareId: string; preset: string }) => {
      assertSenderOwnsPersistedShare(event, input.shareId)
      const result = deps.chatService.updateHumanCollaborationShareRules({
        shareId: input.shareId,
        preset: input.preset as HumanContributionPreset
      })
      if (result) deps.broadcastHumanCollaborationUpdate(result.chatId)
      return result
    }
  )

  /**
   * Host review of queued external contributions.
   *
   * SCOPE IS RESOLVED FROM THE ENTRY, NEVER FROM THE PAYLOAD. The queue store's
   * approve/deny match on entryId across one global array and verify nothing
   * about ownership, so trusting a renderer-supplied chatId here would let a
   * popout bound to chat A approve chat B's contribution. Read the entry, assert
   * against the chatId IT carries, then mutate — the same order
   * `assertSenderOwnsPersistedShare` uses for shares.
   *
   * These are host verbs and must stay off the wire. Do NOT add them to
   * HUMAN_COLLABORATION_METHODS or give them a branch in `routeEncryptedAction`:
   * that terminal throw is the only thing keeping them unreachable by a
   * collaborator, and the store's missing ownership check is a popout bug today
   * but would be remote privilege escalation the moment these verbs are routable.
   */
  ipcMain.handle('human-collaboration:list-pending-contributions', (event, chatId: string) => {
    // Required, not optional: the store's listQueued() returns EVERY chat's
    // entries — bodies included — when the chat id is omitted.
    assertSenderOwnsPersistedChat(event, chatId)
    return deps.chatService.listPendingExternalContributions(chatId)
  })

  ipcMain.handle('human-collaboration:approve-contribution', (event, entryId: string) => {
    const entry = deps.chatService.getExternalContribution(entryId)
    if (!entry) throw new Error('Contribution not found.')
    assertSenderOwnsPersistedChat(event, entry.chatId)
    const approved = deps.chatService.approveExternalContribution(entryId)
    if (approved) {
      deps.broadcastHumanCollaborationUpdate(approved.chatId)
      deps.republishHumanCollaborationProjection(approved.chatId)
    }
    return approved
  })

  ipcMain.handle(
    'human-collaboration:deny-contribution',
    (event, input: { entryId: string; reason?: string }) => {
      const entry = deps.chatService.getExternalContribution(input?.entryId)
      if (!entry) throw new Error('Contribution not found.')
      assertSenderOwnsPersistedChat(event, entry.chatId)
      const denied = deps.chatService.denyExternalContribution(input.entryId, input?.reason)
      if (denied) {
        deps.broadcastHumanCollaborationUpdate(denied.chatId)
        deps.republishHumanCollaborationProjection(denied.chatId)
      }
      return denied
    }
  )

  ipcMain.handle(
    'human-collaboration:set-host-review',
    (event, input: { shareId: string; requiresHostApproval: boolean }) => {
      assertSenderOwnsPersistedShare(event, input?.shareId)
      const result = deps.chatService.setHumanCollaborationHostReview({
        shareId: input.shareId,
        requiresHostApproval: input?.requiresHostApproval === true
      })
      if (result) deps.broadcastHumanCollaborationUpdate(result.chatId)
      return result
    }
  )

  ipcMain.handle(
    'human-collaboration:audit-log',
    (event, input?: { chatId?: string; limit?: number }) => {
      const chatId = resolveSenderShareListChatId(event, input?.chatId)
      return deps.humanCollaborationAuditLog.list({
        ...(chatId ? { chatId } : {}),
        ...(typeof input?.limit === 'number' ? { limit: input.limit } : {})
      })
    }
  )

  let humanCollaborationCollaboratorClient: HumanCollaborationCollaboratorClient | null = null
  const disposeCollaboratorClient = (): void => {
    humanCollaborationCollaboratorClient?.dispose()
    humanCollaborationCollaboratorClient = null
  }

  let humanCollaborationCollaboratorIdentity: KeyPair | null = null
  const loadCollaboratorIdentity = (): KeyPair | undefined => {
    if (humanCollaborationCollaboratorIdentity) return humanCollaborationCollaboratorIdentity
    try {
      humanCollaborationCollaboratorIdentity = new HumanCollaborationIdentityStore(
        join(deps.getUserDataPath(), 'human-collaboration-collaborator-identity.json'),
        deps.safeStorage,
        (line) => console.warn(line)
      ).load()
      return humanCollaborationCollaboratorIdentity
    } catch (err) {
      console.warn(
        `[human-collaboration] collaborator identity unavailable (reconnect disabled): ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return undefined
    }
  }

  const collaboratorSessionRecordPath = (): string =>
    join(deps.getUserDataPath(), 'human-collaboration-collaborator-session.json')

  const readCollaboratorSessionRecord = (): CollaboratorSessionRecord | null => {
    try {
      const parsed = JSON.parse(
        fsSync.readFileSync(collaboratorSessionRecordPath(), 'utf8')
      ) as CollaboratorSessionRecord
      if (
        !parsed?.shareId ||
        !parsed?.chatId ||
        !parsed?.collaboratorId ||
        !parsed?.roomId ||
        !parsed?.hostIdentityPubKeyB64 ||
        !Array.isArray(parsed?.relayUrls) ||
        parsed.relayUrls.length === 0
      ) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  const writeCollaboratorSessionRecord = (record: CollaboratorSessionRecord): void => {
    try {
      const target = collaboratorSessionRecordPath()
      fsSync.writeFileSync(`${target}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 })
      fsSync.renameSync(`${target}.tmp`, target)
    } catch (err) {
      console.warn(
        `[human-collaboration] could not persist collaborator session: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  let pendingCollaboratorJoinContext: Omit<
    CollaboratorSessionRecord,
    'collaboratorId' | 'hostIdentityPubKeyB64' | 'savedAt'
  > | null = null

  ipcMain.handle(
    'human-collaboration-collaborator:join',
    async (
      event,
      input: {
        shareId: string
        chatId: string
        inviteToken: string
        displayName: string
        mode: 'readOnly' | 'comments'
        relayUrl: string
        relayUrls?: string[]
        roomId: string
        hostIdentityPubKeyB64?: string
      }
    ) => {
      deps.assertMainRendererSender(event)
      disposeCollaboratorClient()
      const relayUrls = Array.from(
        new Set(
          [
            ...(Array.isArray(input.relayUrls) ? input.relayUrls : []),
            input.relayUrl
          ].filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
        )
      )
      if (relayUrls.length === 0) {
        throw new Error(
          'This invite has no relay URL. Ask the host to enable remote access and create a fresh invite.'
        )
      }

      const relayAttemptFailures: Array<{ relayUrl: string; error: unknown }> = []
      const collaboratorIdentity = loadCollaboratorIdentity()
      for (const relayUrl of relayUrls) {
        const client = new HumanCollaborationCollaboratorClient({
          socketFactory: deps.socketFactory,
          ...(collaboratorIdentity ? { identity: collaboratorIdentity } : {}),
          onProjection: (projection, sessionId) =>
            deps.sendToMainWindow('human-collaboration-collaborator-projection', {
              projection,
              sessionId
            }),
          onOlderPage: (page) =>
            deps.sendToMainWindow('human-collaboration-collaborator-older-page', page),
          onConnectionChange: (connected) =>
            deps.sendToMainWindow('human-collaboration-collaborator-status', { connected }),
          onError: (err) =>
            deps.sendToMainWindow('human-collaboration-collaborator-status', { error: err.message }),
          // A DISTINCT field, not `error`: the renderer forces the connection
          // state to 'disconnected' on any `error`, and a refused contribution
          // is not a dropped connection.
          onContributionRejected: (info) =>
            deps.sendToMainWindow('human-collaboration-collaborator-status', {
              contributionRejected: info
            }),
          log: (line) => console.warn(line)
        })
        humanCollaborationCollaboratorClient = client
        try {
          client.connect(relayUrl, input.roomId)
          await client.whenConnected()
          const { confirmCode } = await client.beginAdmission({
            shareId: input.shareId,
            chatId: input.chatId,
            inviteToken: input.inviteToken,
            displayName: input.displayName,
            shareMode: input.mode === 'readOnly' ? 'readOnly' : 'comments',
            expectedHostIdentityPubKeyB64: input.hostIdentityPubKeyB64
          })
          pendingCollaboratorJoinContext = {
            shareId: input.shareId,
            chatId: input.chatId,
            displayName: input.displayName,
            mode: input.mode === 'readOnly' ? 'readOnly' : 'comments',
            relayUrls,
            roomId: input.roomId
          }
          return { confirmCode, chatId: input.chatId, mode: input.mode }
        } catch (err) {
          if (humanCollaborationCollaboratorClient === client) disposeCollaboratorClient()
          else client.dispose()
          if (!retryableJoinError(err)) throw err
          relayAttemptFailures.push({ relayUrl, error: err })
        }
      }
      throw describeRelayAttemptFailures(
        relayAttemptFailures,
        'Could not connect to any collaboration relay URL.'
      )
    }
  )

  ipcMain.handle('human-collaboration-collaborator:confirm', async (event) => {
    deps.assertMainRendererSender(event)
    const client = humanCollaborationCollaboratorClient
    if (!client) throw new Error('No active collaboration join to confirm.')
    const result = await client.confirmAdmission()
    client.subscribe()
    if (pendingCollaboratorJoinContext && result?.collaboratorId) {
      writeCollaboratorSessionRecord({
        ...pendingCollaboratorJoinContext,
        collaboratorId: result.collaboratorId,
        hostIdentityPubKeyB64: result.hostIdentityPubKeyB64,
        savedAt: Date.now()
      })
      pendingCollaboratorJoinContext = null
    }
    return result
  })

  ipcMain.handle('human-collaboration-collaborator:last-session', (event) => {
    deps.assertMainRendererSender(event)
    const record = readCollaboratorSessionRecord()
    if (!record || !loadCollaboratorIdentity()) return { available: false }
    return {
      available: true,
      chatId: record.chatId,
      displayName: record.displayName,
      mode: record.mode,
      savedAt: record.savedAt
    }
  })

  ipcMain.handle('human-collaboration-collaborator:reconnect', async (event) => {
    deps.assertMainRendererSender(event)
    const record = readCollaboratorSessionRecord()
    if (!record) throw new Error('No previous shared chat to reconnect to.')
    const collaboratorIdentity = loadCollaboratorIdentity()
    if (!collaboratorIdentity) {
      throw new Error('Collaborator identity is unavailable, so reconnect is not possible.')
    }
    disposeCollaboratorClient()
    const relayAttemptFailures: Array<{ relayUrl: string; error: unknown }> = []
    for (const relayUrl of record.relayUrls) {
      const client = new HumanCollaborationCollaboratorClient({
        socketFactory: deps.socketFactory,
        identity: collaboratorIdentity,
        onProjection: (projection, sessionId) =>
          deps.sendToMainWindow('human-collaboration-collaborator-projection', {
            projection,
            sessionId
          }),
        onOlderPage: (page) =>
          deps.sendToMainWindow('human-collaboration-collaborator-older-page', page),
        onConnectionChange: (connected) =>
          deps.sendToMainWindow('human-collaboration-collaborator-status', { connected }),
        onError: (err) =>
          deps.sendToMainWindow('human-collaboration-collaborator-status', { error: err.message }),
        onContributionRejected: (info) =>
          deps.sendToMainWindow('human-collaboration-collaborator-status', {
            contributionRejected: info
          }),
        log: (line) => console.warn(line)
      })
      humanCollaborationCollaboratorClient = client
      try {
        client.connect(relayUrl, record.roomId)
        await client.whenConnected()
        await client.reconnect({
          shareId: record.shareId,
          chatId: record.chatId,
          collaboratorId: record.collaboratorId,
          displayName: record.displayName,
          shareMode: record.mode,
          expectedHostIdentityPubKeyB64: record.hostIdentityPubKeyB64
        })
        client.subscribe()
        return { chatId: record.chatId, mode: record.mode, displayName: record.displayName }
      } catch (err) {
        if (humanCollaborationCollaboratorClient === client) disposeCollaboratorClient()
        else client.dispose()
        if (!retryableJoinError(err)) throw err
        relayAttemptFailures.push({ relayUrl, error: err })
      }
    }
    throw describeRelayAttemptFailures(
      relayAttemptFailures,
      'Could not reconnect over any known relay URL.'
    )
  })

  ipcMain.handle(
    'human-collaboration-collaborator:append-comment',
    (event, input: { content: string; clientMessageId?: string; intent?: string }) => {
      deps.assertMainRendererSender(event)
      const client = humanCollaborationCollaboratorClient
      if (!client) throw new Error('No active collaboration session.')
      client.appendComment(
        input.content,
        input.clientMessageId,
        input.intent === 'requestHostAction' ? 'requestHostAction' : undefined
      )
      return { ok: true }
    }
  )

  ipcMain.handle(
    'human-collaboration-collaborator:load-older',
    (event, input: { beforeRowId?: string } = {}) => {
      deps.assertMainRendererSender(event)
      const client = humanCollaborationCollaboratorClient
      if (!client) throw new Error('No active collaboration session.')
      client.loadOlder(typeof input?.beforeRowId === 'string' ? input.beforeRowId : undefined)
      return { ok: true }
    }
  )

  ipcMain.handle('human-collaboration-collaborator:leave', (event) => {
    deps.assertMainRendererSender(event)
    disposeCollaboratorClient()
    return true
  })

  return {
    dispose: disposeCollaboratorClient
  }
}
