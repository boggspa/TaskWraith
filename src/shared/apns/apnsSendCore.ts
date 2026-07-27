/*
 * apnsSendCore — keyless, Node-only APNs HTTP/2 send core.
 *
 * Shared by BOTH tiers: Tier-1 (src/main/Http2ApnsPusher — the host owner's own
 * .p8) and Tier-2 (the relay gateway — a project-held .p8 loaded in
 * relay/src/cli.ts). "Keyless" means this module never ACQUIRES a key (no fs /
 * secret reads): it is HANDED a PEM and signs with it. Node built-ins only
 * (crypto, http2) — no electron — so it is safe to run inside the standalone
 * relay too.
 *
 * Boundary: it must NEVER enter relay/src/server.ts's import graph (the relay
 * bundled into Electron main does no sending and holds no key). Enforced by
 * scripts/guard-no-bundled-secrets.cjs. See docs/ios-push-gateway-design.md §7.
 */

import { createSign } from 'crypto'
import * as http2 from 'http2'
import type { ApnsClientConfig, ApnsEnv, ApnsSendArgs, ApnsSendResult } from './types'

const DEFAULT_JWT_LIFETIME_SECONDS = 50 * 60
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com'
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com'

interface CachedJwt {
  token: string
  expiresAt: number // ms since epoch
}

interface CachedSession {
  session: http2.ClientHttp2Session
  authority: string
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Convert Node's DER-encoded ECDSA signature to APNs's required fixed-length
 * r||s concatenation.
 *
 * DER ECDSA signature format: SEQUENCE { INTEGER r, INTEGER s }. The INTEGER
 * values may have a leading 0x00 byte to disambiguate sign — strip those. The
 * output is two `sizePerInt`-byte values concatenated, left-zero-padded.
 */
export function derEcdsaToConcat(der: Buffer, sizePerInt: number): Buffer {
  if (der[0] !== 0x30) {
    throw new Error('derEcdsaToConcat: expected SEQUENCE tag 0x30')
  }
  // Skip SEQUENCE length byte(s). For ES256 sigs (~70-72 bytes total) it's
  // always a single length byte.
  let offset = 2
  if (der[1] & 0x80) {
    const lengthBytes = der[1] & 0x7f
    offset = 2 + lengthBytes
  }
  // Read r
  if (der[offset] !== 0x02) throw new Error('derEcdsaToConcat: expected INTEGER tag for r')
  const rLen = der[offset + 1]
  let r = der.subarray(offset + 2, offset + 2 + rLen)
  offset += 2 + rLen
  // Read s
  if (der[offset] !== 0x02) throw new Error('derEcdsaToConcat: expected INTEGER tag for s')
  const sLen = der[offset + 1]
  let s = der.subarray(offset + 2, offset + 2 + sLen)
  // Strip leading 0x00 if INTEGER was padded for sign.
  if (r[0] === 0x00 && r.length > sizePerInt) r = r.subarray(1)
  if (s[0] === 0x00 && s.length > sizePerInt) s = s.subarray(1)
  // Left-zero-pad to fixed size.
  const out = Buffer.alloc(sizePerInt * 2)
  r.copy(out, sizePerInt - r.length)
  s.copy(out, sizePerInt * 2 - s.length)
  return out
}

/** Build the JWT Apple requires: ES256-signed `{header.claims}` where
 * header = {alg:ES256, kid, typ:JWT} and claims = {iss:teamId, iat}. */
export function signEs256Jwt(args: {
  authKeyPem: string
  keyId: string
  teamId: string
  nowMs: number
}): string {
  const header = base64url(
    Buffer.from(JSON.stringify({ alg: 'ES256', kid: args.keyId, typ: 'JWT' }))
  )
  const claims = base64url(
    Buffer.from(JSON.stringify({ iss: args.teamId, iat: Math.floor(args.nowMs / 1000) }))
  )
  const signingInput = `${header}.${claims}`
  // Node's createSign for ES256 returns ASN.1 DER by default; APNs requires raw
  // r||s concatenation. Convert.
  const signer = createSign('SHA256')
  signer.update(signingInput)
  signer.end()
  const der = signer.sign(args.authKeyPem)
  return `${signingInput}.${base64url(derEcdsaToConcat(der, 32))}`
}

/** Apple's authoritative "permanently invalid token" reason.
 *
 * A wrong sandbox/production gateway yields 400 BadDeviceToken for a live
 * token, so callers must retain that registration and surface the environment
 * mismatch. Only 410 Unregistered proves that the token should be reaped.
 */
export function isDeadTokenReason(reason: string | undefined | null): boolean {
  return /^Unregistered$/i.test(reason ?? '')
}

/**
 * The keyless APNs transport: JWT mint (cached ~50min), one sticky HTTP/2
 * session per env, and a single `send`. Holds the PEM it is handed but never
 * loads it. One long-lived instance per process (Tier-1) or per env (Tier-2).
 */
export class ApnsClient {
  private readonly authKey: string
  private readonly keyId: string
  private readonly teamId: string
  private readonly bundleId: string
  private readonly forceEnv?: ApnsEnv
  private readonly log: (line: string) => void
  private readonly connectFn: (authority: string) => http2.ClientHttp2Session
  private readonly jwtLifetimeMs: number
  private readonly now: () => Date

  private cachedJwt: CachedJwt | null = null
  /** One persistent session per environment; lazily opened. */
  private sessions: Partial<Record<ApnsEnv, CachedSession>> = {}

  constructor(config: ApnsClientConfig) {
    this.authKey = config.authKeyPem
    this.keyId = config.keyId
    this.teamId = config.teamId
    this.bundleId = config.bundleId
    this.forceEnv = config.forceEnv
    this.log = config.log ?? ((): void => {})
    this.connectFn = config.connect ?? ((authority): http2.ClientHttp2Session => http2.connect(authority))
    this.jwtLifetimeMs = (config.jwtLifetimeSeconds ?? DEFAULT_JWT_LIFETIME_SECONDS) * 1000
    this.now = config.now ?? ((): Date => new Date())
  }

  /** Deliver one push to a resolved device token. Never throws; failures come
   * back as { delivered:false, reason }. */
  async send(args: ApnsSendArgs): Promise<ApnsSendResult> {
    const env = this.forceEnv ?? args.env
    try {
      const session = this.ensureSession(env)
      const jwt = this.ensureJwt()
      return await this.sendRequest({ session, jwt, ...args, env })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[ApnsClient] send failed: ${message}`)
      return { delivered: false, apnsId: '', reason: message }
    }
  }

  /** Tear down all open HTTP/2 sessions. Idempotent. */
  close(): void {
    for (const env of Object.keys(this.sessions) as ApnsEnv[]) {
      const cached = this.sessions[env]
      if (cached) {
        try {
          cached.session.close()
        } catch {
          /* best effort */
        }
        delete this.sessions[env]
      }
    }
    this.cachedJwt = null
  }

  private ensureSession(env: ApnsEnv): http2.ClientHttp2Session {
    const existing = this.sessions[env]
    if (existing && !existing.session.closed && !existing.session.destroyed) {
      return existing.session
    }
    const authority = env === 'production' ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX
    const session = this.connectFn(authority)
    session.on('error', (err) => {
      this.log(`[ApnsClient] session error (${env}): ${err.message}`)
    })
    session.on('close', () => {
      // Lazy reconnect on next send; just drop the cache.
      delete this.sessions[env]
    })
    this.sessions[env] = { session, authority }
    this.log(`[ApnsClient] opened HTTP/2 session to ${authority}`)
    return session
  }

  private ensureJwt(): string {
    const nowMs = this.now().getTime()
    if (this.cachedJwt && this.cachedJwt.expiresAt > nowMs + 60_000) {
      return this.cachedJwt.token
    }
    const token = signEs256Jwt({
      authKeyPem: this.authKey,
      keyId: this.keyId,
      teamId: this.teamId,
      nowMs
    })
    this.cachedJwt = { token, expiresAt: nowMs + this.jwtLifetimeMs }
    this.log(`[ApnsClient] minted new JWT (kid=${this.keyId})`)
    return token
  }

  private sendRequest(args: {
    session: http2.ClientHttp2Session
    jwt: string
    deviceTokenHex: string
    env: ApnsEnv
    pushType: 'alert' | 'background' | 'liveactivity'
    priority: 5 | 10
    body: string
    expirationSeconds?: number
    collapseId?: string
  }): Promise<ApnsSendResult> {
    return new Promise<ApnsSendResult>((resolve) => {
      const headers: http2.OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${args.deviceTokenHex}`,
        authorization: `bearer ${args.jwt}`,
        // Derived, never passed in. A Live Activity push goes to a dedicated
        // topic; send it to the plain bundle topic and Apple answers 400
        // TopicDisallowed.
        'apns-topic':
          args.pushType === 'liveactivity'
            ? `${this.bundleId}.push-type.liveactivity`
            : this.bundleId,
        'apns-push-type': args.pushType,
        'apns-priority': String(args.priority),
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(args.body))
      }
      if (typeof args.expirationSeconds === 'number' && Number.isFinite(args.expirationSeconds)) {
        headers['apns-expiration'] = String(Math.max(0, Math.floor(args.expirationSeconds)))
      }
      if (args.collapseId) {
        // apns-collapse-id is capped at 64 bytes by Apple.
        headers['apns-collapse-id'] = args.collapseId.slice(0, 64)
      }
      const req = args.session.request(headers)
      let status = 0
      let apnsId = ''
      let responseBody = ''
      req.on('response', (responseHeaders) => {
        status = (responseHeaders[':status'] as number) ?? 0
        apnsId = (responseHeaders['apns-id'] as string) ?? ''
      })
      req.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString('utf-8')
      })
      req.on('end', () => {
        if (status === 200) {
          resolve({ delivered: true, apnsId })
          return
        }
        // Apple returns a JSON body with `reason: "..."` on errors.
        let reason = `HTTP ${status}`
        try {
          const parsed = JSON.parse(responseBody) as { reason?: string }
          if (parsed.reason) reason = parsed.reason
        } catch {
          /* keep status-only reason */
        }
        resolve({ delivered: false, apnsId, reason })
      })
      req.on('error', (err) => {
        resolve({ delivered: false, apnsId: '', reason: err.message })
      })
      req.setEncoding('utf-8')
      req.write(args.body)
      req.end()
    })
  }
}
