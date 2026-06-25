/*
 * HumanCollaborationHostTransport — the HOST endpoint of the collaboration
 * transport (L5-2).
 *
 * The collaboration runtime is fully main-side; this is the missing pipe that
 * carries its sealed frames to/from a remote collaborator over the existing
 * dumb relay. One relay room per collaborator (host takes the `mac` seat, the
 * collaborator the `iphone` seat). It:
 *   - dispatches inbound handshake requests (begin/confirm) to the runtime and
 *     replies on the same room,
 *   - feeds inbound sealed frames into runtime.routeEncryptedAction and flushes
 *     projection updates back to the subscribed sessions,
 *   - delivers the runtime's outbound sealed projection frames to the room the
 *     owning session is bound to.
 *
 * The socket is injected (TransportSocketFactory) so the whole thing is
 * loopback/unit-testable without a real WebSocket — see
 * HumanCollaborationHostTransport.test.ts.
 */
import type { TransportSocket, TransportSocketFactory } from '../remote/RemoteTransportClient'
import {
  HUMAN_COLLABORATION_PROTOCOL,
  type HumanCollaborationBeginHandshakeInput,
  type HumanCollaborationBeginHandshakeResult,
  type HumanCollaborationConfirmSasInput,
  type HumanCollaborationConfirmSasResult,
  type HumanCollaborationEncryptedFrame
} from '../../shared/collaboration/HumanCollaborationProtocol'
import {
  makeTransportResponse,
  parseTransportMessage,
  type HumanCollaborationTransportRequest
} from '../../shared/collaboration/HumanCollaborationTransportProtocol'

/** The runtime surface this transport drives (kept narrow for testability). */
export interface HumanCollaborationHostRuntimeLike {
  beginAdmission(input: HumanCollaborationBeginHandshakeInput): Promise<HumanCollaborationBeginHandshakeResult>
  confirmSas(input: HumanCollaborationConfirmSasInput): Promise<HumanCollaborationConfirmSasResult>
  routeEncryptedAction(frame: HumanCollaborationEncryptedFrame): Promise<unknown>
  publishProjectionUpdates(chatId?: string): Promise<void>
  disconnect(input: { sessionId: string }): Promise<boolean>
}

export interface HumanCollaborationHostTransportOptions {
  socketFactory: TransportSocketFactory
  log?: (line: string) => void
}

// Coalesce projection flushes: an admitted collaborator can stream inbound
// frames (subscribe is not itself rate-limited), each of which would otherwise
// force a full projection rebuild + reseal + send. A leading-edge flush with a
// trailing coalesce caps that work to ~once per interval regardless of inbound
// rate, while still delivering the first subscribe promptly.
const FLUSH_MIN_INTERVAL_MS = 200
// Hard ceiling on a single outbound frame. The dumb relay closes the CONNECTION
// (ws 1009) on a frame over its 1 MiB cap, so we skip + log an oversized frame
// rather than let it kill the room (the projection is also byte-budgeted at the
// source — this is defense-in-depth).
const MAX_OUTBOUND_FRAME_BYTES = 950_000
// Reconnect a host room socket that drops unexpectedly (relay blip / restart),
// with capped exponential backoff. Without this, a dropped room is dead until
// the next create-share (and the relay's idle-TTL would eventually reap it).
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

interface RoomState {
  roomId: string
  relayUrl: string
  socket: TransportSocket | null
}

export class HumanCollaborationHostTransport {
  private readonly opts: HumanCollaborationHostTransportOptions
  private runtime: HumanCollaborationHostRuntimeLike | null = null
  private readonly rooms = new Map<string, RoomState>()
  private readonly sessionToRoom = new Map<string, string>()
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reconnectAttempts = new Map<string, number>()
  private disposed = false
  private lastFlushAt = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private trailingFlushScheduled = false

  constructor(options: HumanCollaborationHostTransportOptions) {
    this.opts = options
  }

  private readonly now: () => number = () => Date.now()

  /** Wire the runtime AFTER construction (the runtime is built with this
   * transport's `deliver` as its publishEncryptedProjection sink). */
  attachRuntime(runtime: HumanCollaborationHostRuntimeLike): void {
    this.runtime = runtime
  }

  /** Open (or reuse) the host's `mac`-seat listener for a collaborator room.
   * Idempotent: a no-op if already open or a reconnect is pending. */
  openRoom(relayUrl: string, roomId: string): void {
    if (this.disposed) return
    const existing = this.rooms.get(roomId)
    if (existing && existing.socket) return
    // Clear any pending reconnect — we're opening now.
    const pending = this.reconnectTimers.get(roomId)
    if (pending) {
      clearTimeout(pending)
      this.reconnectTimers.delete(roomId)
    }
    const state: RoomState = existing ?? { roomId, relayUrl, socket: null }
    state.relayUrl = relayUrl
    this.rooms.set(roomId, state)
    const url = `${relayUrl.replace(/\/$/, '')}/v1/session/${roomId}`
    state.socket = this.opts.socketFactory(
      url,
      { 'x-taskwraith-role': 'mac', 'x-taskwraith-protocol': HUMAN_COLLABORATION_PROTOCOL },
      {
        onOpen: () => {
          this.reconnectAttempts.delete(roomId)
          this.opts.log?.(`[collab-transport] room ${roomId} open`)
        },
        onMessage: (data) => void this.handleInbound(roomId, data),
        onClose: () => {
          const room = this.rooms.get(roomId)
          if (room) room.socket = null
          // Reconnect only if the room is still WANTED (not closeRoom'd/disposed).
          if (!this.disposed && this.rooms.has(roomId)) this.scheduleRoomReconnect(roomId)
        },
        onError: (err) => this.opts.log?.(`[collab-transport] room ${roomId} error: ${err.message}`)
      }
    )
  }

  private scheduleRoomReconnect(roomId: string): void {
    if (this.reconnectTimers.has(roomId)) return
    const attempt = this.reconnectAttempts.get(roomId) ?? 0
    this.reconnectAttempts.set(roomId, attempt + 1)
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(roomId)
      const room = this.rooms.get(roomId)
      if (this.disposed || !room || room.socket) return
      this.openRoom(room.relayUrl, roomId)
    }, delay)
    timer.unref?.()
    this.reconnectTimers.set(roomId, timer)
  }

  /** Tear down a collaborator room (host stopped sharing / revoked). */
  closeRoom(roomId: string): void {
    const pending = this.reconnectTimers.get(roomId)
    if (pending) clearTimeout(pending)
    this.reconnectTimers.delete(roomId)
    this.reconnectAttempts.delete(roomId)
    const room = this.rooms.get(roomId)
    // Delete BEFORE closing so the socket's onClose sees the room is gone and
    // does not schedule a reconnect.
    this.rooms.delete(roomId)
    room?.socket?.close()
    for (const [sessionId, mapped] of this.sessionToRoom) {
      if (mapped !== roomId) continue
      this.sessionToRoom.delete(sessionId)
      // Explicitly drop the runtime session/subscriber so it doesn't linger
      // until the next access self-heals it.
      void this.runtime?.disconnect({ sessionId }).catch(() => {})
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.trailingFlushScheduled = false
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer)
    this.reconnectTimers.clear()
    this.reconnectAttempts.clear()
    for (const room of this.rooms.values()) room.socket?.close()
    this.rooms.clear()
    this.sessionToRoom.clear()
  }

  /** Outbound sink wired as the runtime's publishEncryptedProjection: route a
   * sealed projection frame to the room its session is bound to. */
  deliver(sessionId: string, frame: HumanCollaborationEncryptedFrame): void {
    const roomId = this.sessionToRoom.get(sessionId)
    const socket = roomId ? this.rooms.get(roomId)?.socket : null
    if (!socket) {
      // No live room for this session — the host believes it published, so
      // surface the drop rather than failing silently.
      this.opts.log?.(`[collab-transport] dropped frame for session ${sessionId}: no live room`)
      return
    }
    const data = JSON.stringify(frame)
    if (data.length > MAX_OUTBOUND_FRAME_BYTES) {
      // Skip rather than let the relay 1009-close the whole room (the projection
      // is byte-budgeted at the source, so this should not normally fire).
      this.opts.log?.(`[collab-transport] dropped oversized frame (${data.length}B) for ${sessionId}`)
      return
    }
    socket.send(data)
  }

  /** Leading-edge + trailing coalesced projection flush (see FLUSH_MIN_INTERVAL_MS). */
  private scheduleFlush(): void {
    const since = this.now() - this.lastFlushAt
    if (since >= FLUSH_MIN_INTERVAL_MS) {
      this.lastFlushAt = this.now()
      void this.runtime?.publishProjectionUpdates().catch(() => {})
      return
    }
    if (this.trailingFlushScheduled) return
    this.trailingFlushScheduled = true
    this.flushTimer = setTimeout(() => {
      this.trailingFlushScheduled = false
      this.lastFlushAt = this.now()
      void this.runtime?.publishProjectionUpdates().catch(() => {})
    }, FLUSH_MIN_INTERVAL_MS - since)
    this.flushTimer.unref?.()
  }

  private async handleInbound(roomId: string, data: string): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    const message = parseTransportMessage(data)
    if (!message) return
    const socket = this.rooms.get(roomId)?.socket
    if (!socket) return

    if (message.t === 'collab.req') {
      await this.handleRequest(runtime, roomId, socket, message)
      return
    }
    if (message.t === 'humanCollaboration.enc') {
      try {
        await runtime.routeEncryptedAction(message)
        // Coalesced flush of projection updates to subscribers (the runtime's
        // publishEncryptedProjection sink routes each sealed frame to its room).
        // Throttled so inbound-frame (e.g. subscribe) spam can't force unbounded
        // rebuild+reseal+send.
        this.scheduleFlush()
      } catch (err) {
        this.opts.log?.(
          `[collab-transport] route failed on room ${roomId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

  private async handleRequest(
    runtime: HumanCollaborationHostRuntimeLike,
    roomId: string,
    socket: TransportSocket,
    message: HumanCollaborationTransportRequest
  ): Promise<void> {
    try {
      if (message.method === 'begin') {
        const result = await runtime.beginAdmission(
          message.params as HumanCollaborationBeginHandshakeInput
        )
        socket.send(JSON.stringify(makeTransportResponse(message.reqId, { ok: true, result })))
        return
      }
      // 'confirm'
      const result = await runtime.confirmSas(message.params as HumanCollaborationConfirmSasInput)
      // Bind the established session to this room so its projection frames are
      // delivered here.
      this.sessionToRoom.set(result.sessionId, roomId)
      socket.send(JSON.stringify(makeTransportResponse(message.reqId, { ok: true, result })))
    } catch (err) {
      socket.send(
        JSON.stringify(
          makeTransportResponse(message.reqId, {
            ok: false,
            error: err instanceof Error ? err.message : 'Collaboration request failed.'
          })
        )
      )
    }
  }
}
