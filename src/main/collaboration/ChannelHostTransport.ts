/*
 * ChannelHostTransport — P1 host endpoint for N-room star fan-out.
 *
 * Replaces single-share projection routing with channel/member routing:
 * one two-seat relay room per non-host member, host `mac` seat, member
 * `iphone` seat. After a durable ChannelMessageLog commit the same record
 * is fanned to every active non-host room (including the author's echo).
 *
 * Failed rooms are isolated: a dropped send is logged and does not roll back
 * the commit or block other rooms. Reconnect uses capped exponential backoff
 * (donor pattern). Replay/resume uses ChannelMessageLog.replay then transitions
 * the room to live delivery.
 *
 * No intermediate runtime layer: transport calls ChannelStore / ChannelMessageLog
 * directly. Admission begin/confirm may be injected; when absent they return
 * host_unavailable so SAS wiring can land without blocking log/fan-out proof.
 */
import type { TransportSocket, TransportSocketFactory } from '../remote/RemoteTransportClient'
import {
  CHANNEL_WIRE_PROTOCOL,
  makeChannelEvent,
  makeChannelResponse,
  parseChannelLogAppendParams,
  parseChannelLogResumeParams,
  parseChannelWireMessage,
  type ChannelWireError,
  type ChannelWireRequest
} from '../../shared/collaboration/ChannelWireProtocol'
import { ChannelError, type ChannelMember, type ChannelStore } from './ChannelStore'
import type { ChannelMessage, ChannelMessageLog } from './ChannelMessageLog'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const MAX_OUTBOUND_FRAME_BYTES = 950_000

export interface ChannelAdmissionHandlers {
  begin(params: unknown, room: ChannelMemberRoomRef): Promise<unknown>
  confirm(params: unknown, room: ChannelMemberRoomRef): Promise<unknown>
}

export interface ChannelMemberRoomRef {
  channelId: string
  memberId: string
  roomId: string
  identityPublicKey: string
}

export interface ChannelHostTransportOptions {
  socketFactory: TransportSocketFactory
  store: ChannelStore
  log: ChannelMessageLog
  admission?: ChannelAdmissionHandlers
  logger?: (line: string) => void
}

interface MemberRoomState extends ChannelMemberRoomRef {
  relayUrl: string
  socket: TransportSocket | null
  /** False while catch-up batches are in flight; live fan-out waits until true. */
  live: boolean
}

function roomKey(channelId: string, memberId: string): string {
  return `${channelId}\u0000${memberId}`
}

function wireErrorFromUnknown(error: unknown): ChannelWireError {
  if (error instanceof ChannelError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'protocol_unsupported', message: error.message }
  }
  return { code: 'protocol_unsupported', message: 'Unknown transport error' }
}

export class ChannelHostTransport {
  private readonly opts: ChannelHostTransportOptions
  private readonly rooms = new Map<string, MemberRoomState>()
  private readonly roomIdIndex = new Map<string, string>()
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reconnectAttempts = new Map<string, number>()
  private disposed = false

  constructor(options: ChannelHostTransportOptions) {
    this.opts = options
  }

  /**
   * Open (or rebind) the host listener for one non-host member room.
   * Identity and room binding are taken from ChannelStore — never from the wire.
   */
  openMemberRoom(channelId: string, memberId: string, relayUrl: string, roomId: string): void {
    if (this.disposed) return
    const channel = this.opts.store.getChannel(channelId)
    if (!channel || channel.status !== 'active') {
      throw new ChannelError('channel_closed', 'Channel is not active')
    }
    if (memberId === channel.ownerMemberId) {
      throw new ChannelError('protocol_unsupported', 'Host member does not have a relay room')
    }
    const member = this.opts.store.getMember(channelId, memberId)
    if (!member || member.status !== 'active') {
      throw new ChannelError('not_member', 'Member is not an active Channel member')
    }
    if (member.kind !== 'human') {
      throw new ChannelError('human_only', 'Only human members are supported')
    }
    if (!member.roomId || member.roomId !== roomId) {
      throw new ChannelError('identity_mismatch', 'Room id is not bound to this member')
    }

    const key = roomKey(channelId, memberId)
    const existing = this.rooms.get(key)
    if (existing?.socket) {
      if (existing.relayUrl === relayUrl && existing.roomId === roomId) return
      existing.socket.close()
      existing.socket = null
    }

    const pending = this.reconnectTimers.get(key)
    if (pending) {
      clearTimeout(pending)
      this.reconnectTimers.delete(key)
    }

    // Keep roomId index exclusive so a re-admit cannot leave two keys on one room.
    for (const [mappedRoomId, mappedKey] of this.roomIdIndex) {
      if (mappedKey === key || mappedRoomId === roomId) this.roomIdIndex.delete(mappedRoomId)
    }

    const state: MemberRoomState = existing ?? {
      channelId,
      memberId,
      roomId,
      relayUrl,
      identityPublicKey: member.identityPublicKey,
      socket: null,
      live: true
    }
    state.channelId = channelId
    state.memberId = memberId
    state.roomId = roomId
    state.relayUrl = relayUrl
    state.identityPublicKey = member.identityPublicKey
    this.rooms.set(key, state)
    this.roomIdIndex.set(roomId, key)
    this.connectRoom(state)
  }

  private connectRoom(state: MemberRoomState): void {
    const key = roomKey(state.channelId, state.memberId)
    const url = `${state.relayUrl.replace(/\/$/, '')}/v1/session/${state.roomId}`
    const socket = this.opts.socketFactory(
      url,
      {
        'x-taskwraith-role': 'mac',
        'x-taskwraith-protocol': CHANNEL_WIRE_PROTOCOL,
        'x-taskwraith-channel-id': state.channelId,
        'x-taskwraith-member-id': state.memberId
      },
      {
        onOpen: () => {
          this.reconnectAttempts.delete(key)
          this.opts.logger?.(
            `[channel-transport] room ${state.roomId} open for member ${state.memberId}`
          )
        },
        onMessage: (data) => void this.handleInbound(key, data),
        onClose: () => {
          const room = this.rooms.get(key)
          if (room?.socket === socket) room.socket = null
          if (!this.disposed && this.rooms.get(key)?.socket === null) {
            this.scheduleRoomReconnect(key)
          }
        },
        onError: (err) =>
          this.opts.logger?.(`[channel-transport] room ${state.roomId} error: ${err.message}`)
      }
    )
    state.socket = socket
  }

  private scheduleRoomReconnect(key: string): void {
    if (this.reconnectTimers.has(key)) return
    const attempt = this.reconnectAttempts.get(key) ?? 0
    this.reconnectAttempts.set(key, attempt + 1)
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(key)
      const room = this.rooms.get(key)
      if (this.disposed || !room || room.socket) return
      this.connectRoom(room)
    }, delay)
    timer.unref?.()
    this.reconnectTimers.set(key, timer)
  }

  closeMemberRoom(channelId: string, memberId: string): void {
    const key = roomKey(channelId, memberId)
    const pending = this.reconnectTimers.get(key)
    if (pending) clearTimeout(pending)
    this.reconnectTimers.delete(key)
    this.reconnectAttempts.delete(key)
    const room = this.rooms.get(key)
    // Delete before close so onClose does not schedule reconnect.
    this.rooms.delete(key)
    if (room) this.roomIdIndex.delete(room.roomId)
    room?.socket?.close()
  }

  /**
   * Star fan-out of a committed ChannelMessage to every active non-host room
   * for that channel. Failures are isolated per room.
   */
  fanOut(message: ChannelMessage): void {
    if (this.disposed) return
    const event = makeChannelEvent('channel.log.batch', {
      channelId: message.channelId,
      records: [message],
      highWaterSequence: message.sequence,
      live: true
    })
    const payload = JSON.stringify(event)
    for (const room of this.rooms.values()) {
      if (room.channelId !== message.channelId) continue
      if (!room.live) continue
      this.safeSend(room, payload, `fan-out seq=${message.sequence}`)
    }
  }

  /**
   * Notify a member of revocation and close their room when delivery is possible.
   */
  notifyMemberRevoked(channelId: string, memberId: string, membershipRevision: number): void {
    const key = roomKey(channelId, memberId)
    const room = this.rooms.get(key)
    if (room?.socket) {
      const event = makeChannelEvent('channel.member.revoked', {
        channelId,
        memberId,
        membershipRevision
      })
      this.safeSend(room, JSON.stringify(event), 'member.revoked')
    }
    this.closeMemberRoom(channelId, memberId)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer)
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()
    for (const room of this.rooms.values()) room.socket?.close()
    this.rooms.clear()
    this.roomIdIndex.clear()
  }

  /** Test/observability: currently open member rooms. */
  listOpenRooms(): ChannelMemberRoomRef[] {
    return [...this.rooms.values()].map((room) => ({
      channelId: room.channelId,
      memberId: room.memberId,
      roomId: room.roomId,
      identityPublicKey: room.identityPublicKey
    }))
  }

  private safeSend(room: MemberRoomState, payload: string, context: string): boolean {
    if (!room.socket) {
      this.opts.logger?.(`[channel-transport] drop ${context} room ${room.roomId}: no socket`)
      return false
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_OUTBOUND_FRAME_BYTES) {
      this.opts.logger?.(`[channel-transport] drop ${context} room ${room.roomId}: frame too large`)
      return false
    }
    try {
      room.socket.send(payload)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.opts.logger?.(`[channel-transport] drop ${context} room ${room.roomId}: ${message}`)
      return false
    }
  }

  private async handleInbound(key: string, data: string): Promise<void> {
    const room = this.rooms.get(key)
    if (!room || this.disposed) return
    const message = parseChannelWireMessage(data)
    if (!message || message.t !== 'channel.req') return

    try {
      await this.dispatchRequest(room, message)
    } catch (error) {
      this.replyError(room, message.reqId, wireErrorFromUnknown(error))
    }
  }

  private async dispatchRequest(room: MemberRoomState, request: ChannelWireRequest): Promise<void> {
    switch (request.method) {
      case 'channel.admission.begin':
        return this.handleAdmission(room, request, 'begin')
      case 'channel.admission.confirm':
        return this.handleAdmission(room, request, 'confirm')
      case 'channel.reconnect':
        return this.handleReconnect(room, request)
      case 'channel.log.append':
        return this.handleAppend(room, request)
      case 'channel.log.resume':
        return this.handleResume(room, request)
      default:
        this.replyError(room, request.reqId, {
          code: 'protocol_unsupported',
          message: `Unsupported method ${request.method}`
        })
    }
  }

  private async handleAdmission(
    room: MemberRoomState,
    request: ChannelWireRequest,
    phase: 'begin' | 'confirm'
  ): Promise<void> {
    if (!this.opts.admission) {
      this.replyError(room, request.reqId, {
        code: 'host_unavailable',
        message: 'Channel admission handlers are not attached'
      })
      return
    }
    const ref: ChannelMemberRoomRef = {
      channelId: room.channelId,
      memberId: room.memberId,
      roomId: room.roomId,
      identityPublicKey: room.identityPublicKey
    }
    const result =
      phase === 'begin'
        ? await this.opts.admission.begin(request.params, ref)
        : await this.opts.admission.confirm(request.params, ref)
    this.replyOk(room, request.reqId, result)
  }

  private handleReconnect(room: MemberRoomState, request: ChannelWireRequest): void {
    // Re-pin against the durable store; room binding is already transport-owned.
    const member = this.opts.store.validateMemberSession({
      channelId: room.channelId,
      memberId: room.memberId,
      identityPublicKey: room.identityPublicKey,
      roomId: room.roomId
    })
    room.identityPublicKey = member.identityPublicKey
    room.live = false
    this.replyOk(room, request.reqId, {
      channelId: room.channelId,
      memberId: member.memberId,
      membershipRevision: this.opts.store.getChannel(room.channelId)?.membershipRevision ?? 0
    })
    this.emitMembersSnapshot(room)
  }

  private handleAppend(room: MemberRoomState, request: ChannelWireRequest): void {
    const parsed = parseChannelLogAppendParams(request.params)
    if (!parsed) {
      this.replyError(room, request.reqId, {
        code: 'protocol_unsupported',
        message: 'channel.log.append params are invalid or contain forbidden fields'
      })
      return
    }

    const committed = this.opts.log.append({
      channelId: room.channelId,
      principalMemberId: room.memberId,
      identityPublicKey: room.identityPublicKey,
      roomId: room.roomId,
      clientMessageId: parsed.clientMessageId,
      content: parsed.content
    })

    // Correlated result to the author room, then star fan-out (includes echo).
    const resultEvent = makeChannelEvent(
      'channel.log.appendResult',
      { accepted: true, record: committed },
      request.reqId
    )
    this.safeSend(room, JSON.stringify(resultEvent), 'appendResult')
    this.replyOk(room, request.reqId, { accepted: true, record: committed })
    this.fanOut(committed)
  }

  private handleResume(room: MemberRoomState, request: ChannelWireRequest): void {
    const parsed = parseChannelLogResumeParams(request.params)
    if (!parsed) {
      this.replyError(room, request.reqId, {
        code: 'invalid_cursor',
        message: 'channel.log.resume params are invalid'
      })
      return
    }

    room.live = false
    this.opts.store.validateMemberSession({
      channelId: room.channelId,
      memberId: room.memberId,
      identityPublicKey: room.identityPublicKey,
      roomId: room.roomId
    })

    let resumeAfter = parsed.resumeAfter
    let highWater = 0
    for (;;) {
      const batch = this.opts.log.replay({
        channelId: room.channelId,
        resumeAfter,
        maxRecords: parsed.maxRecords,
        maxBytes: parsed.maxBytes
      })
      highWater = batch.highWaterSequence
      const event = makeChannelEvent('channel.log.batch', {
        channelId: room.channelId,
        records: batch.records,
        highWaterSequence: batch.highWaterSequence,
        live: false
      })
      if (!this.safeSend(room, JSON.stringify(event), `resume batch after=${resumeAfter}`)) {
        this.replyError(room, request.reqId, {
          code: 'host_unavailable',
          message: 'Failed to deliver resume batch'
        })
        return
      }
      if (batch.records.length === 0) break
      const next = batch.records[batch.records.length - 1]!.sequence
      if (next <= resumeAfter) break
      resumeAfter = next
      if (resumeAfter >= highWater) break
    }

    room.live = true
    this.emitMembersSnapshot(room)
    this.replyOk(room, request.reqId, {
      channelId: room.channelId,
      highWaterSequence: highWater,
      live: true
    })
  }

  private emitMembersSnapshot(room: MemberRoomState): void {
    const channel = this.opts.store.getChannel(room.channelId)
    if (!channel) return
    const members = this.opts.store
      .listMembers(room.channelId)
      .filter((member: ChannelMember) => member.status === 'active')
      .map((member) => ({
        memberId: member.memberId,
        displayName: member.displayName,
        kind: member.kind,
        status: member.status
      }))
    const event = makeChannelEvent('channel.members.snapshot', {
      channelId: room.channelId,
      membershipRevision: channel.membershipRevision,
      members
    })
    this.safeSend(room, JSON.stringify(event), 'members.snapshot')
  }

  private replyOk(room: MemberRoomState, reqId: string, result: unknown): void {
    this.safeSend(room, JSON.stringify(makeChannelResponse(reqId, { ok: true, result })), 'res-ok')
  }

  private replyError(room: MemberRoomState, reqId: string, error: ChannelWireError): void {
    this.safeSend(room, JSON.stringify(makeChannelResponse(reqId, { ok: false, error })), 'res-err')
  }
}
