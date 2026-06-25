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
}

export interface HumanCollaborationHostTransportOptions {
  socketFactory: TransportSocketFactory
  log?: (line: string) => void
}

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

  constructor(options: HumanCollaborationHostTransportOptions) {
    this.opts = options
  }

  /** Wire the runtime AFTER construction (the runtime is built with this
   * transport's `deliver` as its publishEncryptedProjection sink). */
  attachRuntime(runtime: HumanCollaborationHostRuntimeLike): void {
    this.runtime = runtime
  }

  /** Open (or reuse) the host's `mac`-seat listener for a collaborator room. */
  openRoom(relayUrl: string, roomId: string): void {
    const existing = this.rooms.get(roomId)
    if (existing && existing.socket) return
    const state: RoomState = existing ?? { roomId, relayUrl, socket: null }
    this.rooms.set(roomId, state)
    const url = `${relayUrl.replace(/\/$/, '')}/v1/session/${roomId}`
    state.socket = this.opts.socketFactory(
      url,
      { 'x-taskwraith-role': 'mac', 'x-taskwraith-protocol': HUMAN_COLLABORATION_PROTOCOL },
      {
        onOpen: () => this.opts.log?.(`[collab-transport] room ${roomId} open`),
        onMessage: (data) => void this.handleInbound(roomId, data),
        onClose: () => {
          const room = this.rooms.get(roomId)
          if (room) room.socket = null
        },
        onError: (err) => this.opts.log?.(`[collab-transport] room ${roomId} error: ${err.message}`)
      }
    )
  }

  /** Tear down a collaborator room (host stopped sharing / revoked). */
  closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId)
    room?.socket?.close()
    this.rooms.delete(roomId)
    for (const [sessionId, mapped] of this.sessionToRoom) {
      if (mapped === roomId) this.sessionToRoom.delete(sessionId)
    }
  }

  dispose(): void {
    for (const room of this.rooms.values()) room.socket?.close()
    this.rooms.clear()
    this.sessionToRoom.clear()
  }

  /** Outbound sink wired as the runtime's publishEncryptedProjection: route a
   * sealed projection frame to the room its session is bound to. */
  deliver(sessionId: string, frame: HumanCollaborationEncryptedFrame): void {
    const roomId = this.sessionToRoom.get(sessionId)
    const socket = roomId ? this.rooms.get(roomId)?.socket : null
    if (!socket) return
    socket.send(JSON.stringify(frame))
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
        // Flush projection updates to subscribers (the runtime's
        // publishEncryptedProjection sink routes each sealed frame to its room).
        await runtime.publishProjectionUpdates()
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
