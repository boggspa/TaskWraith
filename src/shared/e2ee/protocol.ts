/*
 * taskwraith-e2ee-v1 — wire protocol definitions.
 *
 * Pure types + constants, no crypto import, so the relay, the Electron-main
 * transport client, the Node fake-iPhone harness, and (eventually) the CryptoKit
 * iOS client all agree on the same frame shapes. See ./keys, ./keyschedule,
 * ./cipher, ./session for the implementation.
 *
 * Wire encoding: each WebSocket text message is one UTF-8 JSON object. All
 * binary fields are base64 (standard alphabet, padded). Public keys travel as
 * RAW 32 bytes (see ./keys for the DER<->raw conversion that makes this match
 * CryptoKit's rawRepresentation).
 */

export const E2EE_PROTOCOL = 'taskwraith-e2ee-v1'

/** HKDF info strings — directional so a key is never used for both directions. */
export const HKDF_INFO_MAC_TO_IPHONE = `${E2EE_PROTOCOL} mac->iphone`
export const HKDF_INFO_IPHONE_TO_MAC = `${E2EE_PROTOCOL} iphone->mac`

export type Role = 'mac' | 'iphone'

/** Direction names the SENDER. Drives both the AES key and the nonce prefix. */
export type Direction = 'mac->iphone' | 'iphone->mac'

/** 4-byte big-endian nonce prefix per direction (then 8-byte BE seq). */
export const NONCE_PREFIX: Record<Direction, number> = {
  'mac->iphone': 0x00000001,
  'iphone->mac': 0x00000002
}

export function sendDirectionForRole(role: Role): Direction {
  return role === 'mac' ? 'mac->iphone' : 'iphone->mac'
}
export function recvDirectionForRole(role: Role): Direction {
  return role === 'mac' ? 'iphone->mac' : 'mac->iphone'
}

// ── Control-plane frames (plaintext over the relay) ──────────────────────────

export interface ClientHelloFrame {
  t: 'clientHello'
  protocol: string
  sessionId: string
  role: 'iphone'
  /** base64 raw 32B X25519 ephemeral public key. */
  ephemeralPubKey: string
  /** base64 16B random. */
  nonce: string
}

export interface ServerHelloFrame {
  t: 'serverHello'
  protocol: string
  sessionId: string
  ephemeralPubKey: string
  nonce: string
  /** base64 raw 32B Ed25519 Mac identity public key. */
  macIdentityPubKey: string
}

export interface ClientAuthFrame {
  t: 'clientAuth'
  sessionId: string
  /** base64 raw 32B Ed25519 iPhone identity public key. */
  iphoneIdentityPubKey: string
  /** 6-digit transcript-derived confirmation code (shown on both screens). */
  confirmCode: string
  /** base64 64B Ed25519 signature over the handshake transcript hash. */
  transcriptSig: string
}

export interface ServerAuthFrame {
  t: 'serverAuth'
  sessionId: string
  transcriptSig: string
}

// ── Data-plane frame (E2EE application channel) ──────────────────────────────

export interface EncryptedFrame {
  t: 'enc'
  sessionId: string
  /** Per-connection transport counter (drives the GCM nonce). Resets on reconnect. */
  seq: number
  /** base64 12B nonce (redundant-but-explicit; receiver recomputes + validates). */
  nonce: string
  /** base64 AES-256-GCM ciphertext. */
  ct: string
  /** base64 16B GCM tag. */
  tag: string
  /** Highest contiguous app msgId received from the peer (drives replay-buffer trim). */
  ack: number | null
}

export type E2eeFrame =
  | ClientHelloFrame
  | ServerHelloFrame
  | ClientAuthFrame
  | ServerAuthFrame
  | EncryptedFrame

// ── App message (the plaintext inside an EncryptedFrame) ─────────────────────

/**
 * The decrypted payload of an `enc` frame. `method`/`params` mirror the exact
 * shape `BridgeBroadcaster`/`BridgeRunEventSink` `notify(method, params)`
 * produce and that `BridgeActionRouter.route(method, params)` consumes.
 * `msgId` is monotonic across reconnects (drives the replay buffer + ack).
 * `transport.*` methods are handled inside the session (ping/pong/resume).
 */
export interface AppMessage {
  msgId: number
  method: string
  params?: unknown
  /** Authenticated copy of the sender's receive high-water mark. The legacy
   * EncryptedFrame.ack field remains on the wire for compatibility, but peers
   * must trust only this decrypted value when trimming replay buffers. */
  ack?: number | null
}

export const TRANSPORT_PING = 'transport.ping'
export const TRANSPORT_PONG = 'transport.pong'
export const TRANSPORT_RESUME = 'transport.resume'

// ── Type guards (used by the relay forwarder + handshake parser) ─────────────

export function isE2eeFrame(value: unknown): value is E2eeFrame {
  if (!value || typeof value !== 'object') return false
  const t = (value as { t?: unknown }).t
  return (
    t === 'clientHello' ||
    t === 'serverHello' ||
    t === 'clientAuth' ||
    t === 'serverAuth' ||
    t === 'enc'
  )
}

export function parseFrame(raw: string): E2eeFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isE2eeFrame(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** QR / deep-link bootstrap payload the Mac shows and the iPhone scans. */
export interface PairingBootstrapPayload {
  v: 1
  protocol: string
  relayUrl: string
  /** Ordered relay candidates the phone should try (LAN ws:// first, then
   * the wss:// Tailscale front door). Additive on v1: old phones ignore the
   * key and keep dialing `relayUrl`; new phones prefer this list so ONE
   * pairing works from home Wi-Fi and cellular alike — no re-pair when the
   * network story changes. */
  relayUrls?: string[]
  sessionId: string
  /** base64 raw 32B Ed25519 Mac identity public key. */
  macIdentityPubKey: string
  macDisplayName: string
  /** Host OS — 'mac' | 'windows' | 'linux'. Additive on v1 (old phones ignore
   * it); new phones use it to pick a per-OS glyph and host-generic copy so a
   * Windows/Linux host doesn't read as "your Mac". NOT part of the transcript
   * hash, so it never affects the 6-digit SAS. */
  hostPlatform?: string
  /** ms epoch; the pairing window closes after this. */
  expiresAt: number
}
