/*
 * taskwraith-relay — a dumb, ciphertext-only WebSocket forwarder.
 *
 * Self-hostable (Tailscale / VPS / reverse-proxy). It knows NOTHING about the
 * taskwraith-e2ee-v1 payloads: it keeps one room per sessionId with at most one
 * `mac` and one `iphone` socket, and forwards every frame from one role to the
 * other VERBATIM. Plaintext handshake metadata + ciphertext both pass through
 * opaquely; the relay holds no key material. See src/shared/e2ee for the
 * protocol the endpoints speak across this pipe.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { createResolveDirectory, type ResolveDirectoryOptions } from './resolve'

type Role = 'mac' | 'iphone'

interface Room {
  mac?: WebSocket
  iphone?: WebSocket
  lastActivity: number
}

export interface RelayOptions {
  port?: number
  /** Max frame size; a frame larger than this closes the socket. */
  maxFrameBytes?: number
  /** Drop an idle room after this long with no traffic. */
  idleTtlMs?: number
  /** WS ping cadence; a socket that misses a whole interval is terminated. */
  heartbeatMs?: number
  /** Cap on concurrent rooms (resource-exhaustion bound; review MED). */
  maxRooms?: number
  /** Cap on concurrent sockets from one remote address. */
  maxConnectionsPerIp?: number
  /** Trusted-reconnect directory tuning (freshness window, max TTL). */
  resolve?: ResolveDirectoryOptions
  /**
   * Read-only host advertisement for QR-optional multi-host discovery. When set
   * (the per-host embedded relay), GET /v1/hostinfo returns this object so another
   * tailnet peer can learn whether the machine runs TaskWraith and fetch its
   * PUBLIC bootstrap material (identity pubkey + relay URLs). Returns null to
   * advertise nothing; absent on a shared relay that fronts many hosts (→ 404).
   * The relay stays dumb: it serializes whatever the provider returns and holds
   * no opinion on the shape. Trust is still the 6-digit SAS — nothing here is
   * secret.
   */
  hostInfo?: () => Record<string, unknown> | null
}

export interface RelayServerHandle {
  port: number
  roomCount: () => number
  registrationCount: () => number
  close: () => Promise<void>
}

const ROLE_HEADER = 'x-taskwraith-role'
const SESSION_PATH = /^\/v1\/session\/([A-Za-z0-9._-]+)$/

export function createRelayServer(options: RelayOptions = {}): Promise<RelayServerHandle> {
  // Snapshot frames carry every visible chat's projections in one app
  // message; 256K was too tight once real workspaces went on the allowlist
  // (ws kills the CONNECTION on violation — code 1009 — not just the frame).
  const maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024
  const idleTtlMs = options.idleTtlMs ?? 5 * 60 * 1000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  // Resource-exhaustion bounds (security review): an attacker that opens many
  // sockets on unique session ids — kept alive by ws auto-pong — would
  // otherwise grow `rooms` without limit. Cap total rooms + per-IP sockets.
  const maxRooms = options.maxRooms ?? 4096
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? 64
  const rooms = new Map<string, Room>()
  const connectionsPerIp = new Map<string, number>()
  const resolveDirectory = createResolveDirectory(options.resolve)

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.url || '').startsWith('/v1/resolve')) {
      resolveDirectory.handle(req, res)
      return
    }
    if ((req.url || '').split('?')[0] === '/v1/hostinfo') {
      // Read-only discovery advertisement (see RelayOptions.hostInfo). GET/HEAD
      // only; 404 when no provider is configured or it advertises nothing.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.end('method not allowed')
        return
      }
      const info = options.hostInfo?.() ?? null
      if (!info) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(info))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  const wss = new WebSocketServer({ server: http, maxPayload: maxFrameBytes })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const path = (req.url || '').split('?')[0]
    if (path === '/v1/resolve') {
      let handled = false
      const timer = setTimeout(() => {
        if (!handled && ws.readyState === WebSocket.OPEN) ws.close(4005, 'resolve timeout')
      }, 10_000)
      timer.unref?.()
      ws.once('message', (data: RawData) => {
        handled = true
        clearTimeout(timer)
        let body: unknown
        try {
          body = JSON.parse(data.toString())
        } catch {
          body = null
        }
        const result = resolveDirectory.resolveJson(body)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ ...(result.body as Record<string, unknown>), status: result.status }))
          ws.close(result.status === 200 ? 1000 : 4000, 'resolve complete')
        }
      })
      ws.on('close', () => clearTimeout(timer))
      ws.on('error', () => clearTimeout(timer))
      return
    }
    const match = SESSION_PATH.exec(path)
    const role = String(req.headers[ROLE_HEADER] || '') as Role
    if (!match || (role !== 'mac' && role !== 'iphone')) {
      ws.close(4001, 'bad session or role')
      return
    }
    const sessionId = match[1]
    const remoteIp =
      (req.socket && req.socket.remoteAddress) || String(req.headers['x-forwarded-for'] || '?')
    const ipCount = connectionsPerIp.get(remoteIp) ?? 0
    if (ipCount >= maxConnectionsPerIp) {
      ws.close(4004, 'too many connections')
      return
    }
    let room = rooms.get(sessionId)
    if (!room) {
      if (rooms.size >= maxRooms) {
        ws.close(4003, 'relay at capacity')
        return
      }
      room = { lastActivity: Date.now() }
      rooms.set(sessionId, room)
    }
    connectionsPerIp.set(remoteIp, ipCount + 1)
    const incumbent = room[role]
    if (incumbent) {
      // Takeover, not reject. A role seat is only a FORWARDING slot — trust
      // is established end-to-end by the e2ee handshake against the pinned
      // identity, and sessionIds are unguessable (UUID via QR or signed
      // resolve), so seating a newcomer grants nothing by itself. Rejecting
      // the newcomer (the old 4002 behavior) deadlocked trusted reconnect:
      // an app killed behind a proxy (tailscale serve) leaves a zombie
      // socket that never FINs, and the live peer's pongs kept the room's
      // idle sweep from ever reaping it — so the REAL device could never
      // get its seat back. Single occupancy still holds: the incumbent is
      // evicted before the newcomer is seated.
      incumbent.close(4006, 'replaced by a newer connection')
      const evict = setTimeout(() => incumbent.terminate(), 2_000)
      evict.unref?.()
      incumbent.once('close', () => clearTimeout(evict))
    }
    room[role] = ws
    const peerRole: Role = role === 'mac' ? 'iphone' : 'mac'

    ws.on('message', (data: RawData) => {
      const r = rooms.get(sessionId)
      if (!r) return
      // Only the current seat-holder forwards — an evicted incumbent may
      // linger up to its terminate grace, but its frames are dead.
      if (r[role] !== ws) return
      r.lastActivity = Date.now()
      const peer = r[peerRole]
      if (peer && peer.readyState === WebSocket.OPEN) {
        // Forward bytes verbatim — the relay never parses or decrypts.
        peer.send(data)
      }
    })

    // WS-level heartbeat, two jobs:
    //   1. Keep a LIVE-but-quiet socket (parked Mac listener) counted as
    //      room activity so the idle sweeper doesn't reap it.
    //   2. Reap THIS socket if it stops ponging. The room-level sweep can't
    //      do that: lastActivity is room-wide, so a live peer's pongs kept
    //      a dead socket's room fresh forever. A phone killed behind a
    //      proxy (tailscale serve) never FINs — without per-socket
    //      liveness its seat stayed occupied indefinitely.
    let alive = true
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (!alive) {
        ws.terminate() // fires 'close' → cleanup frees the seat
        return
      }
      alive = false
      ws.ping()
    }, heartbeatMs)
    heartbeat.unref?.()
    ws.on('pong', () => {
      alive = true
      const r = rooms.get(sessionId)
      if (r) r.lastActivity = Date.now()
    })

    const cleanup = (): void => {
      clearInterval(heartbeat)
      const remaining = (connectionsPerIp.get(remoteIp) ?? 1) - 1
      if (remaining <= 0) connectionsPerIp.delete(remoteIp)
      else connectionsPerIp.set(remoteIp, remaining)
      const r = rooms.get(sessionId)
      if (!r) return
      if (r[role] === ws) r[role] = undefined
      if (!r.mac && !r.iphone) rooms.delete(sessionId)
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, room] of rooms) {
      if (now - room.lastActivity > idleTtlMs) {
        room.mac?.close(4003, 'idle')
        room.iphone?.close(4003, 'idle')
        rooms.delete(id)
      }
    }
  }, Math.max(1000, Math.floor(idleTtlMs / 4)))
  sweeper.unref?.()

  return new Promise<RelayServerHandle>((resolve, reject) => {
    // Surface bind failures (EADDRINUSE etc.) as a rejection instead of an
    // uncaught 'error' event — the embedded-relay path in Electron main
    // catches this and disables pairing with a clear log line.
    http.once('error', (err) => {
      clearInterval(sweeper)
      reject(err)
    })
    http.listen(options.port ?? 0, () => {
      const addr = http.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        roomCount: () => rooms.size,
        registrationCount: () => resolveDirectory.registrationCount(),
        close: () =>
          new Promise<void>((res) => {
            clearInterval(sweeper)
            resolveDirectory.close()
            for (const room of rooms.values()) {
              room.mac?.terminate()
              room.iphone?.terminate()
            }
            rooms.clear()
            wss.close(() => http.close(() => res()))
          })
      })
    })
  })
}

// Standalone runs live in ./cli.ts (`npx tsx relay/src/cli.ts`). The old
// `require.main === module` auto-start was removed deliberately: this module
// is now ALSO imported by Electron main (the embedded relay), where the
// bundled top-level `module` IS `require.main` — the guard would have
// auto-bound a rogue relay on every app launch, gate or no gate.
