/**
 * IPC for peer thread messages the USER sends and reads (S8).
 *
 * Why sender authority matters more here than for most channels: a message built
 * on this path carries `origin: 'user'`, and `ThreadMessagePermission` lets a
 * user-composed send through without a prompt — the human IS the authority for it.
 * So the claim has to be proven, not accepted:
 *
 *  - none of these channels is listed in `SECONDARY_RENDERER_SAFE_IPC_CHANNELS`,
 *    and `ipcChannelRequiresMainRenderer` treats every unlisted channel as
 *    main-renderer-only. The authority comes from the allowlist's fail-closed
 *    default rather than from anything asserted here — do NOT add these channels
 *    to that list;
 *  - the send additionally asserts main-renderer sender explicitly, so the
 *    guarantee survives someone later adding the channel to that list; and
 *  - the sending chat is scope-checked, so a renderer cannot send AS a chat it
 *    does not own.
 *
 * Reads are scope-checked too: an inbox holds prose another agent wrote, which is
 * the user's data and not something any renderer should be able to enumerate.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AgenticServicePolicy, ChatRecord } from '../store/types'
import {
  createThreadMessageEvent,
  summarizeThreadMessageInbox,
  type ThreadMessageEvent,
  type ThreadMessageInbox,
  type ThreadMessageInboxSummary
} from '../../shared/threadMessage'
import { evaluateThreadMessageGate, threadMessageDenialMessage } from '../ThreadMessagePermission'
import type { ThreadMessageDeliveryOutcome } from '../ThreadMessageLedger'

export interface ThreadMessageIpcTarget {
  chatId: string
  title: string
  workspaceId: string | null
  crossWorkspace: boolean
}

export interface ThreadMessageSendResult {
  ok: boolean
  outcome?: ThreadMessageDeliveryOutcome
  messageId?: string
  error?: string
}

export interface ThreadMessageInboxResult {
  summary: ThreadMessageInboxSummary
  pending: readonly ThreadMessageEvent[]
}

export interface ThreadMessageIpcHandlersDeps {
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  getChat: (chatId: string) => ChatRecord | null | undefined
  listChats: () => readonly ChatRecord[]
  getThreadMessageInbox: (chatId: string) => ThreadMessageInbox
  enqueueThreadMessage: (event: ThreadMessageEvent) => { outcome: ThreadMessageDeliveryOutcome }
  /** Resolved global `threadMessage` policy — the user's own kill switch. */
  resolveServicePolicy: () => AgenticServicePolicy
  mintThreadMessageId: (fromChatId: string, toChatId: string, nonce: string) => string
  now: () => number
  /** Tell the renderer a chat's inbox changed, so the indicator updates. */
  broadcastThreadMessageInboxChanged?: (chatId: string) => void
}

interface SendPayload {
  fromChatId?: string
  toChatId?: string
  message?: string
  wake?: boolean
  idempotencyKey?: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function registerThreadMessageHandlers(deps: ThreadMessageIpcHandlersDeps): void {
  /** Chats this chat may address, for the send picker. Excludes itself. */
  ipcMain.handle(
    'thread-message:targets',
    (event, rawFromChatId: unknown): ThreadMessageIpcTarget[] => {
      const fromChatId = optionalString(rawFromChatId)
      if (!fromChatId) throw new Error('A sending chat id is required.')
      deps.assertSenderChatScope(event, fromChatId)
      const from = deps.getChat(fromChatId)
      const fromWorkspaceId = from?.workspaceId || null
      return deps
        .listChats()
        .filter((chat) => chat.appChatId !== fromChatId && chat.archived !== true)
        .map((chat) => ({
          chatId: chat.appChatId,
          title: chat.title || chat.appChatId,
          workspaceId: chat.workspaceId || null,
          // Surfaced so the UI can warn BEFORE the send that this one will need
          // approval, rather than the user discovering it from a prompt.
          crossWorkspace:
            !fromWorkspaceId || !chat.workspaceId || chat.workspaceId !== fromWorkspaceId
        }))
        .sort((a, b) => a.title.localeCompare(b.title))
    }
  )

  ipcMain.handle(
    'thread-message:inbox',
    (event, rawChatId: unknown): ThreadMessageInboxResult => {
      const chatId = optionalString(rawChatId)
      if (!chatId) throw new Error('A chat id is required.')
      deps.assertSenderChatScope(event, chatId)
      const inbox = deps.getThreadMessageInbox(chatId)
      return {
        summary: summarizeThreadMessageInbox(inbox),
        pending: inbox.pending.filter((entry) => !entry.deliveredAt)
      }
    }
  )

  ipcMain.handle(
    'thread-message:send',
    (event, rawPayload: SendPayload | null | undefined): ThreadMessageSendResult => {
      const payload = rawPayload || {}
      const fromChatId = optionalString(payload.fromChatId)
      const toChatId = optionalString(payload.toChatId)
      const message = typeof payload.message === 'string' ? payload.message : ''
      if (!fromChatId) return { ok: false, error: 'A sending chat is required.' }
      if (!toChatId) return { ok: false, error: 'A target thread is required.' }
      if (!message.trim()) return { ok: false, error: 'The message is empty.' }

      // Belt and braces on the `origin: 'user'` claim this path is about to make.
      // The channel is already main-renderer-only by the allowlist's fail-closed
      // default; this survives that list changing.
      if (!deps.isMainRendererSender(event)) {
        throw new Error('Only the main renderer may send a thread message as the user.')
      }
      deps.assertSenderChatScope(event, fromChatId)

      const from = deps.getChat(fromChatId)
      const to = deps.getChat(toChatId)
      if (!from) return { ok: false, error: 'The sending chat no longer exists.' }
      if (!to) return { ok: false, outcome: 'unknown-target', error: 'That thread no longer exists.' }

      const crossWorkspace =
        !from.workspaceId || !to.workspaceId || from.workspaceId !== to.workspaceId
      const requestedDelivery = payload.wake === true ? 'wake' : 'queue'

      // Run the gate even for a user send: a policy DENY is the user's own kill
      // switch and outranks the UI. Everything else about a user-composed message
      // is already authorised by the fact that they composed it.
      const decision = evaluateThreadMessageGate({
        origin: 'user',
        requestedDelivery,
        crossWorkspace,
        servicePolicy: deps.resolveServicePolicy(),
        readOnly: false,
        remoteOrigin: false,
        elevation: { fullAccess: false, trustedSession: false, bossAutoApproval: false }
      })
      if (decision.verdict !== 'allow') {
        return { ok: false, error: threadMessageDenialMessage(decision.reason) }
      }

      const nonce = optionalString(payload.idempotencyKey) || `ui:${deps.now()}`
      const built = createThreadMessageEvent({
        id: deps.mintThreadMessageId(fromChatId, toChatId, nonce),
        fromChatId,
        fromChatTitle: from.title || fromChatId,
        toChatId,
        origin: 'user',
        body: message,
        requestedDelivery,
        createdAt: deps.now()
      })
      if (!built) return { ok: false, error: 'That message could not be sent.' }

      const { outcome } = deps.enqueueThreadMessage(built)
      if (outcome === 'accepted') deps.broadcastThreadMessageInboxChanged?.(toChatId)
      return { ok: outcome === 'accepted', outcome, messageId: built.id }
    }
  )
}
