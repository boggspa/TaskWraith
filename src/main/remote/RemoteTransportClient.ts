/*
 * RemoteTransportClient — the Mac (Electron-main) endpoint of the
 * taskwraith-e2ee-v1 transport. Connects to the relay, runs the `mac`-side
 * E2eeSession handshake, surfaces the pairing confirm code to the renderer,
 * holds trust pending the user's finalize, then pipes app messages both ways:
 *   send(method, params)  → the exact shape BridgeBroadcaster / BridgeRunEventSink
 *                            `notify(method, params)` produce.
 *   onMessage(method, p)  → the inverse of BridgeActionRouter.route(method, p).
 *
 * Socket + clock are injected so the whole client is unit-testable without a
 * real WebSocket (see RemoteTransportClient.test.ts).
 */

import { E2eeSession } from '../../shared/e2ee/session'
import {
  exportRawEd25519PublicKey,
  importRawEd25519PublicKey,
  type KeyPair
} from '../../shared/e2ee/keys'
import { E2EE_PROTOCOL, parseFrame, type E2eeFrame } from '../../shared/e2ee/protocol'

export interface TransportSocketHandlers {
  onOpen: () => void
  onMessage: (data: string) => void
  onClose: (code: number) => void
  onError: (err: Error) => void
}

export interface TransportSocket {
  send: (data: string) => void
  close: () => void
}

export type TransportSocketFactory = (
  url: string,
  headers: Record<string, string>,
  handlers: TransportSocketHandlers
) => TransportSocket

export interface RemoteTransportClientOptions {
  identityKeyPair: KeyPair
  socketFactory: TransportSocketFactory
  /** Resumed pairing: pre-pin the iPhone identity so the handshake
   * auto-trusts (no user prompt). Omit for a fresh QR pairing. */
  pinnedPeerIdentityRaw?: Buffer
  /** Fired ONLY when trust is genuinely held for the user's decision — a
   * pinned-key reconnect establishes silently. */
  onConfirmCode?: (sessionId: string, code: string) => void
  onMessage?: (method: string, params: unknown) => void
  onEstablished?: (sessionId: string) => void
  onConnectionChange?: (connected: boolean) => void
  /** RC5: a same-epoch resume detected an unfillable replay-buffer gap on the
   * live session — the caller should push a full snapshot to this device. */
  onReplayGap?: () => void
  log?: (line: string) => void
  now?: () => number
  pingIntervalMs?: number
  pingTimeoutMs?: number
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

export class RemoteTransportClient {
  private readonly opts: RemoteTransportClientOptions
  private session: E2eeSession | null = null
  private socket: TransportSocket | null = null
  private relayUrl = ''
  private sessionId = ''
  private connected = false
  private trustResolver: ((ok: boolean) => void) | null = null
  /** Raw Ed25519 key of the iPhone, pinned after the user confirms pairing. */
  private trustedPeerRaw: Buffer | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** RC6: timestamp of the last decrypted TRANSPORT_PONG. The liveness watchdog
   * marks the logical link down (setConnected(false)) if no pong lands within
   * `pingTimeoutMs` — WITHOUT closing the socket or disposing the session, so a
   * returning phone re-handshakes over the still-open Mac↔relay socket. */
  private lastPongAt = 0
  private reconnectAttempt = 0
  private disposed = false

  constructor(options: RemoteTransportClientOptions) {
    this.opts = options
    this.trustedPeerRaw = options.pinnedPeerIdentityRaw ?? null
  }

  /** Begin listening for an iPhone on a (freshly minted) pairing session. */
  beginSession(relayUrl: string, sessionId: string): void {
    this.relayUrl = relayUrl
    this.sessionId = sessionId
    this.reconnectAttempt = 0
    this.openSocket()
  }

  /** Resolve the held trust decision (user tapped confirm / cancel). */
  finalizePairing(confirmed: boolean): void {
    if (confirmed && this.pendingPeerRaw) this.trustedPeerRaw = this.pendingPeerRaw
    this.trustResolver?.(confirmed)
    this.trustResolver = null
  }

  /** Send an application message to the iPhone (no-op until established). */
  send(method: string, params?: unknown): void {
    if (this.session?.isEstablished) this.session.sendApp(method, params)
  }

  get isConnected(): boolean {
    return this.connected
  }

  get currentSessionId(): string {
    return this.sessionId
  }

  /** The Mac identity public key (raw 32B) for the QR bootstrap payload. */
  macIdentityRaw(): Buffer {
    return exportRawEd25519PublicKey(this.opts.identityKeyPair.publicKey)
  }

  /** The pinned iPhone identity key (raw 32B), null until pairing is confirmed.
   * The runtime derives the audit `pairID` from this — never from a
   * client-supplied field. */
  trustedPeerIdentityRaw(): Buffer | null {
    return this.trustedPeerRaw
  }

  dispose(): void {
    this.disposed = true
    this.stopPing()
    this.socket?.close()
    this.socket = null
    this.session = null
    this.setConnected(false)
  }

  private pendingPeerRaw: Buffer | null = null

  private openSocket(): void {
    if (this.disposed) return
    this.session = new E2eeSession({
      role: 'mac',
      sessionId: this.sessionId,
      identityKeyPair: this.opts.identityKeyPair,
      peerIdentityPublicKey: this.trustedPeerRaw
        ? importRawEd25519PublicKey(this.trustedPeerRaw)
        : undefined,
      send: (frame: E2eeFrame) => this.socket?.send(JSON.stringify(frame)),
      onAppMessage: (method, params) => this.opts.onMessage?.(method, params),
      // The confirm code surfaces from decideTrust (unpinned path only) so a
      // trusted reconnect never re-prompts the user.
      onEstablished: () => {
        this.reconnectAttempt = 0
        this.setConnected(true)
        this.startPing()
        this.opts.onEstablished?.(this.sessionId)
      },
      onPong: () => this.onPong(),
      onReplayGap: () => this.opts.onReplayGap?.(),
      trustPeer: (peerRaw, code) => this.decideTrust(peerRaw, code),
      log: this.opts.log
    })

    const url = `${this.relayUrl.replace(/\/$/, '')}/v1/session/${this.sessionId}`
    this.socket = this.opts.socketFactory(
      url,
      { 'x-taskwraith-role': 'mac', 'x-taskwraith-protocol': E2EE_PROTOCOL },
      {
        onOpen: () => this.session?.start(),
        onMessage: (data) => {
          const frame = parseFrame(data)
          if (frame) void this.session?.handleFrame(frame)
        },
        onClose: () => this.onSocketClosed(),
        onError: (err) => this.opts.log?.(`[transport] socket error: ${err.message}`)
      }
    )
  }

  /** Trust decision:
   *   - Pinned mode (resumed pairing): trust ONLY the pinned key; any other
   *     identity is denied outright with NO user prompt. The whole point of a
   *     trusted reconnect is "this device silently, everyone else rejected" —
   *     surfacing a confirm code for a stranger who reached the resolved
   *     session would be a confusing, abusable prompt.
   *   - Fresh pairing (no pin): surface the confirm code and hold for the
   *     user's finalize.
   * Reconnect after a confirmed pairing pins the key (finalizePairing), so
   * the pinned branch covers all post-pairing reconnects too. */
  private decideTrust(peerRaw: Buffer, code: string): boolean | Promise<boolean> {
    if (this.trustedPeerRaw) return this.trustedPeerRaw.equals(peerRaw)
    this.pendingPeerRaw = peerRaw
    // Create the promise (assigning trustResolver) BEFORE firing onConfirmCode.
    // A caller that finalizes SYNCHRONOUSLY inside the prompt callback (e.g. an
    // auto-accept harness) would otherwise resolve a not-yet-set trustResolver
    // and the handshake would hang forever. Set first, then prompt.
    const promise = new Promise<boolean>((resolve) => {
      this.trustResolver = resolve
    })
    this.opts.onConfirmCode?.(this.sessionId, code)
    return promise
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    this.opts.onConnectionChange?.(value)
  }

  private startPing(): void {
    this.stopPing()
    // Fresh baseline at each establish so we never insta-trip the watchdog on a
    // connection that just came up.
    this.lastPongAt = this.now()
    const interval = this.opts.pingIntervalMs ?? 20_000
    this.pingTimer = setInterval(() => this.livenessTick(), interval)
    this.pingTimer.unref?.()
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** RC6: a decrypted pong proves the peer is live. Refresh the timestamp and, if
   * the link had been marked down on the SAME session, self-heal it back up with
   * no re-handshake. */
  private onPong(): void {
    this.lastPongAt = this.now()
    if (this.session?.isEstablished) this.setConnected(true)
  }

  /** RC6: fired every ping interval. Send the keepalive ping AND, if too long has
   * passed since the last pong on a connected link, mark it down. Crucially this
   * does NOT close the socket, dispose the session, or touch the reconnect
   * machinery — the dead peer is the PHONE, not the Mac's relay socket. A
   * returning phone re-handshakes over the still-open socket (re-firing
   * onEstablished → setConnected(true) + a fresh ping baseline); recovery of
   * content is the phone's own Slice-2 pull. Pinging continues after mark-down so
   * a same-session pong can self-heal via onPong. */
  private livenessTick(): void {
    const timeout = this.opts.pingTimeoutMs ?? 60_000
    if (this.connected && this.now() - this.lastPongAt > timeout) {
      this.setConnected(false)
    }
    this.session?.ping()
  }

  private onSocketClosed(): void {
    this.stopPing()
    this.setConnected(false)
    this.socket = null
    if (this.disposed || !this.trustedPeerRaw) {
      // Never paired (or shutting down) → don't auto-reconnect a dead pairing.
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const base = this.opts.reconnectDelayMs ?? 1_000
    const max = this.opts.maxReconnectDelayMs ?? 30_000
    const delay = Math.min(max, base * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    const timer = setTimeout(() => {
      if (this.disposed) return
      this.openSocketForReconnect()
    }, delay)
    timer.unref?.()
  }

  private openSocketForReconnect(): void {
    // Reuse the pinned peer key so the fresh handshake auto-trusts.
    this.openSocket()
    if (this.trustedPeerRaw && this.session) {
      // The session learns the peer key from clientAuth; decideTrust pins-match.
    }
  }
}
