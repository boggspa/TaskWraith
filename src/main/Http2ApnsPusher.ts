import { createSign } from 'crypto'
import { readFileSync } from 'fs'
import * as http2 from 'http2'
import type {
  BridgeApnsEnv,
  BridgeApnsPusher,
  BridgeApnsPushResult,
  BridgeApprovalPushPayload,
  BridgeRemoteAttentionPushPayload,
  BridgeRemoteAttentionReason
} from './BridgeApnsPusher'

/**
 * Http2ApnsPusher — production APNs delivery via Apple's HTTP/2 endpoint.
 *
 * Replaces the Phase C5 `NoopApnsPusher` scaffold once credentials are
 * configured. Authenticates with Apple using a JWT signed (ES256) by
 * an APNs Authentication Key (.p8 file from Apple Developer → Keys).
 * One key + key id + team id triplet works for both production and
 * sandbox APNs gateways; the iOS device's reported env (from
 * `BridgeActionPayload.registerApnsToken`) picks which Apple host to
 * target per push.
 *
 * Wire format references:
 *   - JWT spec: Apple "Establishing a Token-Based Connection to APNs"
 *     https://developer.apple.com/documentation/usernotifications/sending_notification_requests_to_apns
 *   - HTTP/2 endpoints:
 *     - Production: https://api.push.apple.com:443
 *     - Sandbox:    https://api.sandbox.push.apple.com:443
 *   - Per-push request:
 *     POST /3/device/<hex-device-token>
 *     :authority, :method, :path are HTTP/2 pseudo-headers
 *     authorization: bearer <jwt>
 *     apns-topic: <bundle-id>
 *     apns-push-type: alert | background
 *     apns-priority: 10 (alert) or 5 (background)
 *     content-type: application/json
 *     body: { "aps": { ... } }
 *
 * Lifecycle:
 *   - JWT refreshed proactively at ~50min intervals (Apple rejects
 *     tokens older than 60min).
 *   - HTTP/2 session is single + sticky per env. Re-established on
 *     session error or after a long idle.
 *   - Errors are caught + returned as `delivered: false` with a
 *     reason; never throws. Caller (ApprovalService) can log + retry.
 *
 * Token cleanup: when Apple returns `:status 410 Unregistered` or
 * `400 BadDeviceToken`, the device token is permanently invalid and
 * should be removed from `BridgeApnsTokenStore`. This pusher reports
 * the reason in the result; the caller decides whether to delete.
 */

export interface Http2ApnsPusherConfig {
  /** Filesystem path to the .p8 key downloaded from Apple Developer.
   * Read at construction; the contents are cached in memory + the
   * file is not read again.
   *
   * Phase E1 (gap #1): now optional. The Settings-UI path persists the
   * .p8 PEM content via `safeStorage`, decrypts it on boot, and passes
   * the PEM string directly via `authKeyPem` to avoid round-tripping
   * the secret through the filesystem on each app launch. Exactly ONE
   * of `authKeyPath` / `authKeyPem` must be provided. */
  authKeyPath?: string
  /** PEM-encoded PKCS8 .p8 key content. Alternative to `authKeyPath`
   * for callers that already have the key in memory (e.g. decrypted
   * from Electron `safeStorage`). Must start with `-----BEGIN PRIVATE
   * KEY-----`. */
  authKeyPem?: string
  /** 10-char Key ID from Apple Developer Keys page. */
  keyId: string
  /** 10-char Team ID from Apple Developer Membership page. */
  teamId: string
  /** iOS bundle id (apns-topic header). */
  bundleId: string
  /** Force a specific environment for ALL pushes regardless of the
   * device-token's env. Useful for testing. When undefined, the env
   * field on `BridgeApprovalPushPayload` (passed in by caller) picks. */
  forceEnv?: BridgeApnsEnv
  /** Optional logger sink. */
  log?: (line: string) => void
  /** Inject a custom HTTP/2 connect for tests. Defaults to
   * `http2.connect` with the real Apple endpoints. */
  connect?: (authority: string) => http2.ClientHttp2Session
  /** JWT lifetime in seconds. Apple rejects > 60 minutes; default
   * to 50 minutes for safety margin. */
  jwtLifetimeSeconds?: number
  /** Clock injector for tests. */
  now?: () => Date
}

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

export class Http2ApnsPusher implements BridgeApnsPusher {
  private readonly authKey: string
  private readonly keyId: string
  private readonly teamId: string
  private readonly bundleId: string
  private readonly forceEnv?: BridgeApnsEnv
  private readonly log: (line: string) => void
  private readonly connectFn: (authority: string) => http2.ClientHttp2Session
  private readonly jwtLifetimeMs: number
  private readonly now: () => Date

  private cachedJwt: CachedJwt | null = null
  /** One persistent session per environment; lazily opened. */
  private sessions: Partial<Record<BridgeApnsEnv, CachedSession>> = {}

  constructor(config: Http2ApnsPusherConfig) {
    // Phase E1: accept either an in-memory PEM (`authKeyPem`) or a
    // filesystem path (`authKeyPath`). Settings-UI path uses the
    // former (decrypted from safeStorage); env-var path uses the
    // latter. Exactly one must be provided; we trust the caller's
    // intent if both happen to be set (PEM wins, since it's already
    // been validated through the secure-storage round-trip).
    if (config.authKeyPem && config.authKeyPem.trim()) {
      this.authKey = config.authKeyPem
    } else if (config.authKeyPath) {
      this.authKey = readFileSync(config.authKeyPath, 'utf-8')
    } else {
      throw new Error('Http2ApnsPusher: must provide either authKeyPem or authKeyPath')
    }
    if (!this.authKey.includes('BEGIN PRIVATE KEY')) {
      throw new Error(
        config.authKeyPath
          ? `Http2ApnsPusher: ${config.authKeyPath} does not look like a PEM-encoded PKCS8 private key (.p8)`
          : 'Http2ApnsPusher: provided authKeyPem does not look like a PEM-encoded PKCS8 private key (.p8)'
      )
    }
    this.keyId = config.keyId
    this.teamId = config.teamId
    this.bundleId = config.bundleId
    this.forceEnv = config.forceEnv
    this.log = config.log ?? (() => {})
    this.connectFn = config.connect ?? ((authority) => http2.connect(authority))
    this.jwtLifetimeMs = (config.jwtLifetimeSeconds ?? DEFAULT_JWT_LIFETIME_SECONDS) * 1000
    this.now = config.now ?? (() => new Date())
  }

  async pushApprovalNeeded(_payload: BridgeApprovalPushPayload): Promise<BridgeApnsPushResult> {
    // The caller (ApprovalService) passes the device token via a
    // separate path. This signature predates the credentialed pusher;
    // we keep the BridgeApnsPusher contract intact and read the token
    // from a lookup the caller has separately threaded through. For
    // the v1 wiring, the desktop's BridgeApnsTokenStore is the source
    // of truth and the caller looks up before calling — we get
    // `payload.pairID` and trust that a token exists.
    //
    // TODO Phase C-late+1: refactor BridgeApnsPusher to take an
    // explicit `deviceToken + env` parameter rather than just pairID,
    // so this method doesn't need to depend on an out-of-band lookup.
    // For now: returning a structured "not delivered, lookup not
    // wired" so the caller can fail gracefully.
    return {
      delivered: false,
      apnsId: '',
      reason:
        'Http2ApnsPusher: device-token lookup not wired in pushApprovalNeeded (use pushApprovalToToken instead)'
    }
  }

  async pushRemoteAttentionNeeded(
    _payload: BridgeRemoteAttentionPushPayload
  ): Promise<BridgeApnsPushResult> {
    return {
      delivered: false,
      apnsId: '',
      reason:
        'Http2ApnsPusher: device-token lookup not wired in pushRemoteAttentionNeeded (use pushRemoteAttentionToToken instead)'
    }
  }

  async pushSilent(pairID: string): Promise<BridgeApnsPushResult> {
    return {
      delivered: false,
      apnsId: '',
      reason: `Http2ApnsPusher: device-token lookup not wired in pushSilent (pairID=${pairID})`
    }
  }

  /** Direct push to a specific device token. Use this when the caller
   * has already resolved the token + env (e.g. from
   * BridgeApnsTokenStore) — the most common production path. */
  async pushApprovalToToken(
    deviceTokenHex: string,
    env: BridgeApnsEnv,
    payload: BridgeApprovalPushPayload
  ): Promise<BridgeApnsPushResult> {
    const apsBody = this.buildApprovalApsBody(payload)
    const nowSec = Math.floor(this.now().getTime() / 1000)
    return this.deliver({
      deviceTokenHex,
      env,
      pushType: 'alert',
      priority: 10,
      body: apsBody,
      // Honor the approval's own deadline if present, else 1h; collapse on the
      // per-approval id so a re-send updates rather than stacks.
      expirationSeconds: payload.expiresAt ? Math.floor(payload.expiresAt / 1000) : nowSec + 3600,
      collapseId: payload.toolCallId || payload.threadId
    })
  }

  /** Silent push (no alert) used to wake the app + nudge it to
   * reconnect / sync state. */
  async pushSilentToToken(
    deviceTokenHex: string,
    env: BridgeApnsEnv,
    payload?: Omit<BridgeRemoteAttentionPushPayload, 'pairID'>
  ): Promise<BridgeApnsPushResult> {
    const body = this.buildSilentApsBody(payload)
    const nowSec = Math.floor(this.now().getTime() / 1000)
    return this.deliver({
      deviceTokenHex,
      env,
      pushType: 'background',
      priority: 5,
      body,
      // Silent wakes are only useful briefly — drop after 5min rather than
      // delivering a stale reconnect nudge hours later.
      expirationSeconds: nowSec + 300,
      collapseId: payload?.approvalId || payload?.questionId || payload?.threadId
    })
  }

  async pushRemoteAttentionToToken(
    deviceTokenHex: string,
    env: BridgeApnsEnv,
    payload: BridgeRemoteAttentionPushPayload
  ): Promise<BridgeApnsPushResult> {
    const body = this.buildRemoteAttentionApsBody(payload)
    const nowSec = Math.floor(this.now().getTime() / 1000)
    return this.deliver({
      deviceTokenHex,
      env,
      pushType: 'alert',
      priority: 10,
      body,
      expirationSeconds: nowSec + 3600,
      collapseId: payload.approvalId || payload.questionId || payload.threadId
    })
  }

  /** Tear down all open HTTP/2 sessions. Idempotent. */
  close(): void {
    for (const env of Object.keys(this.sessions) as BridgeApnsEnv[]) {
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

  // MARK: - Internal

  private async deliver(args: {
    deviceTokenHex: string
    env: BridgeApnsEnv
    pushType: 'alert' | 'background'
    priority: 5 | 10
    body: string
    /** Absolute unix-seconds deadline; APNs stores+retries until then. */
    expirationSeconds?: number
    /** apns-collapse-id (<=64 bytes) so re-sends of the same item replace
     * rather than stack, and a tool-call flood can't trip per-app throttling. */
    collapseId?: string
  }): Promise<BridgeApnsPushResult> {
    const env = this.forceEnv ?? args.env
    try {
      const session = await this.ensureSession(env)
      const jwt = this.ensureJwt()
      const result = await this.sendRequest({ session, jwt, ...args, env })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[Http2ApnsPusher] deliver failed: ${message}`)
      return { delivered: false, apnsId: '', reason: message }
    }
  }

  private ensureSession(env: BridgeApnsEnv): http2.ClientHttp2Session {
    const existing = this.sessions[env]
    if (existing && !existing.session.closed && !existing.session.destroyed) {
      return existing.session
    }
    const authority = env === 'production' ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX
    const session = this.connectFn(authority)
    session.on('error', (err) => {
      this.log(`[Http2ApnsPusher] session error (${env}): ${err.message}`)
    })
    session.on('close', () => {
      // Lazy reconnect on next deliver; just drop the cache.
      delete this.sessions[env]
    })
    this.sessions[env] = { session, authority }
    this.log(`[Http2ApnsPusher] opened HTTP/2 session to ${authority}`)
    return session
  }

  private ensureJwt(): string {
    const nowMs = this.now().getTime()
    if (this.cachedJwt && this.cachedJwt.expiresAt > nowMs + 60_000) {
      return this.cachedJwt.token
    }
    const token = this.signJwt(nowMs)
    this.cachedJwt = { token, expiresAt: nowMs + this.jwtLifetimeMs }
    this.log(`[Http2ApnsPusher] minted new JWT (kid=${this.keyId})`)
    return token
  }

  /** Build the JWT Apple requires: ES256-signed `{header.claims}` where
   * header = {alg:ES256, kid, typ:JWT} and claims = {iss:teamId, iat}. */
  private signJwt(nowMs: number): string {
    const header = base64url(
      Buffer.from(
        JSON.stringify({
          alg: 'ES256',
          kid: this.keyId,
          typ: 'JWT'
        })
      )
    )
    const claims = base64url(
      Buffer.from(
        JSON.stringify({
          iss: this.teamId,
          iat: Math.floor(nowMs / 1000)
        })
      )
    )
    const signingInput = `${header}.${claims}`
    // Node's createSign for ES256 returns ASN.1 DER signature by
    // default; APNs requires raw r||s concatenation. Convert.
    const signer = createSign('SHA256')
    signer.update(signingInput)
    signer.end()
    const der = signer.sign(this.authKey)
    const raw = derEcdsaToConcat(der, 32)
    const signature = base64url(raw)
    return `${signingInput}.${signature}`
  }

  private buildApprovalApsBody(payload: BridgeApprovalPushPayload): string {
    return JSON.stringify(
      stripNullish({
        aps: {
          alert: {
            title: 'TaskWraith needs attention',
            body: 'Open TaskWraith to respond.'
          },
          category: APNS_CATEGORY_APPROVAL,
          sound: 'default',
          'mutable-content': 1
        },
        // Routing identifiers only. Do not put command text, paths, diffs,
        // summaries, or deep-link paths into APNs payloads.
        pairID: payload.pairID,
        workspaceId: privacySafeWorkspaceId(payload.workspaceId),
        threadId: payload.threadId,
        toolCallId: payload.toolCallId
      })
    )
  }

  private buildSilentApsBody(payload?: Omit<BridgeRemoteAttentionPushPayload, 'pairID'>): string {
    return JSON.stringify(
      stripNullish({
        aps: { 'content-available': 1 },
        reason: payload?.reason,
        workspaceId: privacySafeWorkspaceId(payload?.workspaceId),
        threadId: payload?.threadId,
        runId: payload?.runId,
        approvalId: payload?.approvalId,
        questionId: payload?.questionId,
        wakeupId: payload?.wakeupId,
        taskId: payload?.taskId,
        projectionKind: payload?.projectionKind,
        generatedAt: payload?.generatedAt
      })
    )
  }

  private buildRemoteAttentionApsBody(payload: BridgeRemoteAttentionPushPayload): string {
    return JSON.stringify(
      stripNullish({
        aps: {
          // Title/body vary by reason (the reason is already in the payload, so
          // this leaks nothing new) — a generic "needs attention" string can't
          // tell an approval from a finished run on the lock screen.
          alert: remoteAttentionAlert(payload.reason),
          // Lights up the lock-screen Approve/Deny buttons for blocking reasons.
          // undefined for non-blocking reasons → JSON.stringify omits it, so a
          // run-complete push stays button-less.
          category: remoteAttentionCategory(payload.reason),
          sound: 'default',
          'mutable-content': 1
        },
        pairID: payload.pairID,
        reason: payload.reason,
        workspaceId: privacySafeWorkspaceId(payload.workspaceId),
        threadId: payload.threadId,
        runId: payload.runId,
        approvalId: payload.approvalId,
        questionId: payload.questionId,
        wakeupId: payload.wakeupId,
        taskId: payload.taskId,
        projectionKind: payload.projectionKind,
        generatedAt: payload.generatedAt
      })
    )
  }

  private sendRequest(args: {
    session: http2.ClientHttp2Session
    jwt: string
    deviceTokenHex: string
    env: BridgeApnsEnv
    pushType: 'alert' | 'background'
    priority: 5 | 10
    body: string
    expirationSeconds?: number
    collapseId?: string
  }): Promise<BridgeApnsPushResult> {
    return new Promise<BridgeApnsPushResult>((resolve) => {
      const headers: http2.OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${args.deviceTokenHex}`,
        authorization: `bearer ${args.jwt}`,
        'apns-topic': this.bundleId,
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
      req.on('response', (headers) => {
        status = (headers[':status'] as number) ?? 0
        apnsId = (headers['apns-id'] as string) ?? ''
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

// MARK: - Helpers

/** UNNotificationCategory identifiers the iOS app registers. The category on
 * the push selects which action buttons (Approve/Deny) appear on the lock
 * screen. Only blocking reasons get a category; others stay button-less. */
const APNS_CATEGORY_APPROVAL = 'TW_APPROVAL'
const APNS_CATEGORY_QUESTION = 'TW_QUESTION'

function remoteAttentionCategory(reason: BridgeRemoteAttentionReason): string | undefined {
  if (reason === 'approval') return APNS_CATEGORY_APPROVAL
  if (reason === 'question') return APNS_CATEGORY_QUESTION
  return undefined
}

/** Lock-screen title/body per reason. Privacy-safe: `reason` is already a
 * payload field, so this adds no new information — it only makes the
 * notification legible instead of a single generic string for every event. */
function remoteAttentionAlert(reason: BridgeRemoteAttentionReason): { title: string; body: string } {
  switch (reason) {
    case 'approval':
      return { title: 'Approval required', body: 'TaskWraith needs your approval to continue.' }
    case 'question':
      return { title: 'TaskWraith has a question', body: 'Open TaskWraith to answer.' }
    case 'taskNeedsAttention':
      return { title: 'Task needs attention', body: 'Open TaskWraith to review.' }
    case 'runComplete':
      return { title: 'Task complete', body: 'Your TaskWraith run finished.' }
    case 'runFailed':
      return { title: 'Task failed', body: 'A TaskWraith run needs your attention.' }
    default:
      return {
        title: 'TaskWraith needs attention',
        body: 'Open TaskWraith to review the latest task state.'
      }
  }
}

function stripNullish<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  )
}

function privacySafeWorkspaceId(workspaceId: string | null | undefined): string | null | undefined {
  if (workspaceId === null || workspaceId === undefined) return workspaceId
  const trimmed = workspaceId.trim()
  if (!trimmed || /[/\\]/.test(trimmed) || trimmed.startsWith('~') || /^[A-Za-z]:/.test(trimmed)) {
    return null
  }
  return trimmed
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Convert Node's DER-encoded ECDSA signature to APNs's required
 * fixed-length r||s concatenation.
 *
 * DER ECDSA signature format:
 *   SEQUENCE { INTEGER r, INTEGER s }
 *
 * The INTEGER values may have a leading 0x00 byte to disambiguate
 * sign — strip those. The output is two `size`-byte values
 * concatenated, left-zero-padded to `size`.
 */
export function derEcdsaToConcat(der: Buffer, sizePerInt: number): Buffer {
  if (der[0] !== 0x30) {
    throw new Error('derEcdsaToConcat: expected SEQUENCE tag 0x30')
  }
  // Skip SEQUENCE length byte(s). For ES256 sigs (~70-72 bytes total)
  // it's always a single length byte.
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
