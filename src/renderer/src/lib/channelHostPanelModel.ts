import type {
  ChannelIpcApi,
  ChannelIpcChannel,
  ChannelIpcError,
  ChannelIpcInviteResult,
  ChannelIpcMember,
  ChannelIpcMessage
} from '../../../shared/collaboration/ChannelIpc'
import { CHANNEL_WIRE_PROTOCOL } from '../../../shared/collaboration/ChannelWireProtocol'

export const CHANNEL_INVITE_PAYLOAD_TYPE = 'taskwraith-channel-invite'
export const CHANNEL_INVITE_PAYLOAD_VERSION = 1
export const CHANNEL_HISTORY_PAGE_RECORDS = 256
export const CHANNEL_HISTORY_PAGE_BYTES = 512 * 1024

export type ChannelHostPanelAction = 'create' | 'invite' | 'append' | 'revoke' | 'close' | 'history'

export interface ChannelHostInviteProjection {
  payload: string
  expiresAt: number
  hostRoomOpened: boolean
  copied: boolean
}

export interface ChannelHostPanelState {
  loading: boolean
  busy: ChannelHostPanelAction | null
  channel: ChannelIpcChannel | null
  members: ChannelIpcMember[]
  records: ChannelIpcMessage[]
  highWaterSequence: number
  invite: ChannelHostInviteProjection | null
  notice: string | null
  error: string | null
}

export interface ChannelHostPanelControllerOptions {
  api: ChannelIpcApi
  chatId: string
  createClientMessageId?: () => string
  copyText?: (text: string) => Promise<void>
}

export interface ChannelInvitePayload {
  type: typeof CHANNEL_INVITE_PAYLOAD_TYPE
  v: typeof CHANNEL_INVITE_PAYLOAD_VERSION
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  channelId: string
  chatId: string
  inviteId: string
  inviteToken: string
  roomId: string
  expiresAt: number
  relayUrl: string
  relayUrls: string[]
  requiresOutOfBandSas: true
}

type StateListener = (state: ChannelHostPanelState) => void

export function createChannelHostPanelInitialState(): ChannelHostPanelState {
  return {
    loading: true,
    busy: null,
    channel: null,
    members: [],
    records: [],
    highWaterSequence: 0,
    invite: null,
    notice: null,
    error: null
  }
}

function describeIpcError(error: ChannelIpcError): string {
  switch (error.code) {
    case 'recovery_blocked':
      return 'This Channel is unavailable until its durable history is recovered.'
    case 'host_unavailable':
      return 'Remote access is unavailable. Check Devices, then try again.'
    case 'channel_closed':
      return 'This Channel is closed.'
    case 'quota_exceeded':
      return 'That action exceeds a Channel safety limit.'
    case 'not_authorized':
      return 'This window is not authorised to manage that Channel.'
    default:
      return error.message
  }
}

function describeThrown(error: unknown): string {
  if (
    error instanceof Error &&
    error.message === 'Secure message identifier generation is unavailable'
  ) {
    return error.message
  }
  return 'The Channel request could not be completed. Try again.'
}

async function copyWithBrowserClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable')
  }
  await navigator.clipboard.writeText(text)
}

export function buildChannelInvitePayload(
  invite: ChannelIpcInviteResult,
  chatId: string
): ChannelInvitePayload {
  const relayUrls = Array.from(new Set(invite.relayUrls))
  return {
    type: CHANNEL_INVITE_PAYLOAD_TYPE,
    v: CHANNEL_INVITE_PAYLOAD_VERSION,
    protocol: CHANNEL_WIRE_PROTOCOL,
    channelId: invite.channelId,
    chatId,
    inviteId: invite.inviteId,
    inviteToken: invite.inviteToken,
    roomId: invite.roomId,
    expiresAt: invite.expiresAt,
    relayUrl: relayUrls[0] || '',
    relayUrls,
    requiresOutOfBandSas: true
  }
}

export function serializeChannelInvite(invite: ChannelIpcInviteResult, chatId: string): string {
  return JSON.stringify(buildChannelInvitePayload(invite, chatId), null, 2)
}

export function createChannelClientMessageId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') {
    throw new Error('Secure message identifier generation is unavailable')
  }
  return `host:${randomUUID.call(globalThis.crypto)}`
}

export function findChannelForChat(
  channels: readonly ChannelIpcChannel[],
  chatId: string
): ChannelIpcChannel | null {
  return channels.find((channel) => channel.chatId === chatId) || null
}

function mergeRecords(
  current: readonly ChannelIpcMessage[],
  incoming: readonly ChannelIpcMessage[]
): ChannelIpcMessage[] {
  const bySequence = new Map<number, ChannelIpcMessage>()
  for (const record of current) bySequence.set(record.sequence, record)
  for (const record of incoming) bySequence.set(record.sequence, record)
  return Array.from(bySequence.values()).sort((left, right) => left.sequence - right.sequence)
}

/**
 * Renderer-side coordinator for the host Channel panel. It owns no authority:
 * every read and mutation still crosses the closed Channel IPC bridge. Keeping
 * the async state machine here makes event refresh, one-shot invite handling,
 * and append idempotency independently testable without a browser DOM.
 */
export class ChannelHostPanelController {
  private state = createChannelHostPanelInitialState()
  private readonly listeners = new Set<StateListener>()
  private readonly createId: () => string
  private readonly copyText: (text: string) => Promise<void>
  private removeChangeListener: (() => void) | null = null
  private syncTail: Promise<boolean> = Promise.resolve(true)
  private started = false
  private disposed = false
  private pendingAppend: { content: string; clientMessageId: string } | null = null

  constructor(private readonly options: ChannelHostPanelControllerOptions) {
    if (!options.chatId.trim()) throw new Error('Channel host panel requires a chat id')
    this.createId = options.createClientMessageId || createChannelClientMessageId
    this.copyText = options.copyText || copyWithBrowserClipboard
  }

  snapshot(): ChannelHostPanelState {
    return this.state
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return
    this.started = true
    try {
      this.removeChangeListener = this.options.api.onChanged((event) => {
        if (!this.state.channel || event.channelId === this.state.channel.channelId) {
          void this.enqueueSync(false)
        }
      })
    } catch (error) {
      this.patch({ error: describeThrown(error) })
    }
    await this.enqueueSync(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeChangeListener?.()
    this.removeChangeListener = null
    this.listeners.clear()
  }

  async retry(): Promise<void> {
    await this.enqueueSync(false)
  }

  async loadMoreHistory(): Promise<void> {
    if (!this.beginAction('history')) return
    const synced = await this.enqueueSync(false)
    if (synced) this.finishAction('Loaded the next durable Channel history page.')
    else this.patch({ busy: null })
  }

  async create(ownerDisplayName: string): Promise<boolean> {
    const normalized = ownerDisplayName.trim()
    if (!normalized) {
      this.patch({ error: 'Enter the name other Channel members should see.' })
      return false
    }
    if (!this.beginAction('create')) return false
    try {
      const result = await this.options.api.create({
        chatId: this.options.chatId,
        ownerDisplayName: normalized
      })
      if (!result.ok) return this.failAction(result.error)
      this.patch({ channel: result.value })
      await this.enqueueSync(true)
      this.finishSynchronizedAction('Channel created. Invite people when you are ready.')
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async issueInvite(): Promise<boolean> {
    const channel = this.requireMutableChannel()
    if (!channel || !this.beginAction('invite')) return false
    try {
      const result = await this.options.api.issueInvite({ channelId: channel.channelId })
      if (!result.ok) return this.failAction(result.error)
      const payload = serializeChannelInvite(result.value, this.options.chatId)
      let copied = false
      try {
        await this.copyText(payload)
        copied = true
      } catch {
        // The one-shot token stays visible in the panel so clipboard denial
        // cannot destroy the only authorised renderer projection of it.
      }
      this.patch({
        busy: null,
        invite: {
          payload,
          expiresAt: result.value.expiresAt,
          hostRoomOpened: result.value.hostRoomOpened,
          copied
        },
        notice: result.value.hostRoomOpened
          ? copied
            ? 'Fresh one-shot invite copied.'
            : 'Fresh one-shot invite created. Copy it from the field below.'
          : 'Invite created, but this Mac could not open its relay room. Check Devices before sharing it.',
        error: null
      })
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async copyCurrentInvite(): Promise<boolean> {
    const invite = this.state.invite
    if (!invite) return false
    try {
      await this.copyText(invite.payload)
      this.patch({
        invite: { ...invite, copied: true },
        notice: 'Invite copied.',
        error: null
      })
      return true
    } catch {
      this.patch({
        invite: { ...invite, copied: false },
        error: 'Clipboard access is unavailable. Copy the invite from the field below.'
      })
      return false
    }
  }

  clearInvite(): void {
    this.patch({ invite: null, notice: null })
  }

  async append(content: string): Promise<boolean> {
    const channel = this.requireMutableChannel()
    const normalized = content.trim()
    if (!channel) return false
    if (!normalized) {
      this.patch({ error: 'Write a human message before posting.' })
      return false
    }
    if (!this.beginAction('append')) return false

    let attempt = this.pendingAppend
    if (!attempt || attempt.content !== normalized) {
      try {
        attempt = { content: normalized, clientMessageId: this.createId() }
      } catch (error) {
        return this.failThrown(error)
      }
      this.pendingAppend = attempt
    }

    try {
      const result = await this.options.api.append({
        channelId: channel.channelId,
        clientMessageId: attempt.clientMessageId,
        content: normalized
      })
      if (!result.ok) {
        this.pendingAppend = null
        return this.failAction(result.error)
      }
      this.pendingAppend = null
      await this.enqueueSync(false)
      this.finishSynchronizedAction(
        result.value.deduplicated ? 'Message already posted.' : 'Message posted.'
      )
      return true
    } catch (error) {
      // A transport failure can happen after main durably committed. Retain the
      // exact idempotency key so a same-content retry cannot append twice.
      return this.failThrown(error)
    }
  }

  async revokeMember(memberId: string): Promise<boolean> {
    const channel = this.requireMutableChannel()
    if (!channel) return false
    if (memberId === channel.ownerMemberId) {
      this.patch({ error: 'The Channel owner cannot be removed.' })
      return false
    }
    if (!this.beginAction('revoke')) return false
    try {
      const result = await this.options.api.revokeMember({
        channelId: channel.channelId,
        memberId
      })
      if (!result.ok) return this.failAction(result.error)
      await this.enqueueSync(false)
      this.finishSynchronizedAction(`${result.value.displayName} was removed from the Channel.`)
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  async close(): Promise<boolean> {
    const channel = this.requireMutableChannel()
    if (!channel || !this.beginAction('close')) return false
    try {
      const result = await this.options.api.close({ channelId: channel.channelId })
      if (!result.ok) return this.failAction(result.error)
      this.patch({ channel: result.value })
      await this.enqueueSync(false)
      this.finishSynchronizedAction('Channel closed. Its durable history remains available.')
      return true
    } catch (error) {
      return this.failThrown(error)
    }
  }

  private patch(patch: Partial<ChannelHostPanelState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private beginAction(action: ChannelHostPanelAction): boolean {
    if (this.disposed) return false
    if (this.state.busy) {
      this.patch({ error: 'Finish the current Channel action first.' })
      return false
    }
    this.patch({ busy: action, error: null, notice: null })
    return true
  }

  private finishAction(notice: string): void {
    this.patch({ busy: null, notice, error: null })
  }

  private finishSynchronizedAction(notice: string): void {
    this.patch({ busy: null, notice, ...(this.state.error ? {} : { error: null }) })
  }

  private failAction(error: ChannelIpcError): false {
    this.patch({ busy: null, error: describeIpcError(error), notice: null })
    return false
  }

  private failThrown(error: unknown): false {
    this.patch({ busy: null, error: describeThrown(error), notice: null })
    return false
  }

  private requireMutableChannel(): ChannelIpcChannel | null {
    const channel = this.state.channel
    if (!channel) {
      this.patch({ error: 'Create this chat’s Channel first.' })
      return null
    }
    if (channel.status !== 'active') {
      this.patch({ error: 'This Channel is closed.' })
      return null
    }
    if (channel.availability !== 'ready') {
      this.patch({ error: 'This Channel is unavailable until its durable history is recovered.' })
      return null
    }
    return channel
  }

  private enqueueSync(reset: boolean): Promise<boolean> {
    const next = this.syncTail.then(() => this.sync(reset))
    this.syncTail = next.catch(() => false)
    return next
  }

  private async sync(reset: boolean): Promise<boolean> {
    if (this.disposed) return false
    try {
      const listed = await this.options.api.list()
      if (this.disposed) return false
      if (!listed.ok) {
        this.patch({ loading: false, error: describeIpcError(listed.error) })
        return false
      }
      const channel = findChannelForChat(listed.value, this.options.chatId)
      if (!channel) {
        this.patch({
          loading: false,
          channel: null,
          members: [],
          records: [],
          highWaterSequence: 0,
          invite: null,
          error: null
        })
        return true
      }

      const sameChannel = !reset && this.state.channel?.channelId === channel.channelId
      const previousRecords = sameChannel ? this.state.records : []
      const previousMembers = sameChannel ? this.state.members : []
      const resumeAfter = previousRecords.at(-1)?.sequence || 0
      if (channel.availability !== 'ready') {
        this.patch({
          loading: false,
          channel,
          members: previousMembers,
          records: previousRecords,
          highWaterSequence: Math.max(this.state.highWaterSequence, channel.messageCount),
          error: 'This Channel is unavailable until its durable history is recovered.'
        })
        return false
      }

      const read = await this.options.api.read({
        channelId: channel.channelId,
        resumeAfter,
        maxRecords: CHANNEL_HISTORY_PAGE_RECORDS,
        maxBytes: CHANNEL_HISTORY_PAGE_BYTES
      })
      if (this.disposed) return false
      if (!read.ok) {
        this.patch({
          loading: false,
          channel,
          members: previousMembers,
          records: previousRecords,
          error: describeIpcError(read.error)
        })
        return false
      }
      this.patch({
        loading: false,
        channel: read.value.channel,
        members: read.value.members,
        records: mergeRecords(previousRecords, read.value.records),
        highWaterSequence: read.value.highWaterSequence,
        error: null
      })
      return true
    } catch (error) {
      this.patch({ loading: false, error: describeThrown(error) })
      return false
    }
  }
}
