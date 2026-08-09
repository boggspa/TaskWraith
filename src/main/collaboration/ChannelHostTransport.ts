/*
 * Raw P1 host transport. It owns relay sockets and nothing else: admission,
 * authorization, encryption, sequencing, replay, and fan-out stay in
 * ChannelRuntime. One host socket is opened per non-host invite/member room.
 */
import { CHANNEL_WIRE_PROTOCOL } from '../../shared/collaboration/ChannelWireProtocol'
import type { TransportSocket, TransportSocketFactory } from '../remote/RemoteTransportClient'
import {
  ChannelRuntime,
  type ChannelRoomBinding,
  type ChannelRuntimeTransport
} from './ChannelRuntime'

const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000
const MAX_RELAY_FRAME_BYTES = 950_000

export interface ChannelHostTransportOptions {
  socketFactory: TransportSocketFactory
  runtime: ChannelRuntime
  logger?: (line: string) => void
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

interface RoomState extends ChannelRoomBinding {
  relayUrl: string
  socket: TransportSocket | null
  connected: boolean
}

export class ChannelHostTransport implements ChannelRuntimeTransport {
  private readonly opts: ChannelHostTransportOptions
  private readonly rooms = new Map<string, RoomState>()
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reconnectAttempts = new Map<string, number>()
  private disposed = false

  constructor(options: ChannelHostTransportOptions) {
    this.opts = options
    options.runtime.attachTransport(this)
  }

  openRoom(channelId: string, roomId: string, relayUrl: string): void {
    if (this.disposed) return
    this.opts.runtime.assertRoomCanOpen(channelId, roomId)
    const existing = this.rooms.get(roomId)
    if (
      existing &&
      existing.channelId === channelId &&
      existing.relayUrl === relayUrl &&
      existing.socket
    ) {
      return
    }
    if (existing?.socket) {
      this.rooms.delete(roomId)
      existing.socket.close()
    }
    this.clearReconnect(roomId)
    const state: RoomState = {
      channelId,
      roomId,
      relayUrl,
      ...(this.opts.runtime
        .listRoomBindings()
        .find((binding) => binding.channelId === channelId && binding.roomId === roomId)?.memberId
        ? {
            memberId: this.opts.runtime
              .listRoomBindings()
              .find((binding) => binding.channelId === channelId && binding.roomId === roomId)!
              .memberId
          }
        : {}),
      socket: null,
      connected: false
    }
    this.rooms.set(roomId, state)
    this.connectRoom(state)
  }

  /**
   * Compatibility wrapper for callers that already resolved an active member.
   * Runtime/store validation remains authoritative; the supplied member id is
   * not trusted or used for authorization.
   */
  openMemberRoom(channelId: string, _memberId: string, relayUrl: string, roomId: string): void {
    this.openRoom(channelId, roomId, relayUrl)
  }

  restoreRooms(relayUrlFor: (binding: ChannelRoomBinding) => string): void {
    for (const binding of this.opts.runtime.listRoomBindings()) {
      this.openRoom(binding.channelId, binding.roomId, relayUrlFor(binding))
    }
  }

  send(roomId: string, payload: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room?.socket || !room.connected) return false
    if (Buffer.byteLength(payload, 'utf8') > MAX_RELAY_FRAME_BYTES) {
      this.opts.logger?.(`[channel-transport] frame too large for room ${roomId}`)
      return false
    }
    try {
      room.socket.send(payload)
      return true
    } catch (error) {
      this.opts.logger?.(
        `[channel-transport] send failed for room ${roomId}: ${
          error instanceof Error ? error.message : 'unknown'
        }`
      )
      return false
    }
  }

  close(roomId: string): void {
    const room = this.rooms.get(roomId)
    this.rooms.delete(roomId)
    this.clearReconnect(roomId)
    this.reconnectAttempts.delete(roomId)
    if (room) {
      room.connected = false
      room.socket?.close()
      room.socket = null
    }
    this.opts.runtime.handleRoomDisconnected(roomId)
  }

  closeMemberRoom(_channelId: string, memberId: string): void {
    const room = [...this.rooms.values()].find((candidate) => candidate.memberId === memberId)
    if (room) this.close(room.roomId)
  }

  listOpenRooms(): ChannelRoomBinding[] {
    return [...this.rooms.values()].map((room) => ({
      channelId: room.channelId,
      roomId: room.roomId,
      ...(room.memberId ? { memberId: room.memberId } : {})
    }))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer)
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()
    const rooms = [...this.rooms.values()]
    this.rooms.clear()
    for (const room of rooms) {
      room.connected = false
      room.socket?.close()
      this.opts.runtime.handleRoomDisconnected(room.roomId)
    }
  }

  private connectRoom(room: RoomState): void {
    if (this.disposed || this.rooms.get(room.roomId) !== room) return
    const url = `${room.relayUrl.replace(/\/$/, '')}/v1/session/${room.roomId}`
    let socket: TransportSocket
    socket = this.opts.socketFactory(
      url,
      {
        'x-taskwraith-role': 'mac',
        'x-taskwraith-protocol': CHANNEL_WIRE_PROTOCOL,
        'x-taskwraith-channel-id': room.channelId
      },
      {
        onOpen: () => {
          if (this.rooms.get(room.roomId)?.socket !== socket) return
          room.connected = true
          this.reconnectAttempts.delete(room.roomId)
          this.opts.logger?.(`[channel-transport] room ${room.roomId} connected`)
        },
        onMessage: (data) => {
          if (this.rooms.get(room.roomId)?.socket !== socket) return
          void this.opts.runtime.handleTransportMessage(room.roomId, data)
        },
        onClose: () => {
          if (this.rooms.get(room.roomId)?.socket !== socket) return
          room.socket = null
          room.connected = false
          this.opts.runtime.handleRoomDisconnected(room.roomId)
          if (!this.disposed) this.scheduleReconnect(room)
        },
        onError: (error) =>
          this.opts.logger?.(`[channel-transport] room ${room.roomId} error: ${error.message}`)
      }
    )
    room.socket = socket
  }

  private scheduleReconnect(room: RoomState): void {
    if (this.reconnectTimers.has(room.roomId)) return
    const attempt = this.reconnectAttempts.get(room.roomId) ?? 0
    this.reconnectAttempts.set(room.roomId, attempt + 1)
    const base = this.opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    const maximum = this.opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    const delay = Math.min(maximum, base * 2 ** attempt)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(room.roomId)
      if (this.disposed || this.rooms.get(room.roomId) !== room || room.socket) {
        return
      }
      this.connectRoom(room)
    }, delay)
    timer.unref?.()
    this.reconnectTimers.set(room.roomId, timer)
  }

  private clearReconnect(roomId: string): void {
    const timer = this.reconnectTimers.get(roomId)
    if (timer) clearTimeout(timer)
    this.reconnectTimers.delete(roomId)
  }
}
