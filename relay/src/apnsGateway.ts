/*
 * Tier-2 APNs gateway — IMPLEMENTATION (P4 register/deregister + P5 trigger).
 *
 * Imported ONLY by relay/src/cli.ts (the standalone runner). It must NEVER be
 * imported — even for a type — by relay/src/server.ts, because server.ts is
 * bundled into Electron main and any module in its runtime graph ships to
 * every user. Types live in ./apnsGatewayTypes (erased). The CI guard
 * (scripts/guard-no-bundled-secrets.cjs) fails the build if this boundary
 * breaks — which is also why importing apnsSendCore HERE is legal: this
 * module is already forbidden from server.ts's graph.
 *
 * Privacy discipline (design §6.6): no token, pairID, threadId, or key
 * logging; uniform 400/404 error bodies that never say WHICH check failed;
 * uniform 200 on the trigger path so per-device delivery leaks nothing.
 */

import type { IncomingMessage, ServerResponse } from 'http'
import type { ApnsGateway } from './apnsGatewayTypes'
import { readJsonBody, respond, type ResolveDirectoryState } from './resolve'
import { ApnsTokenTable } from './apnsTokenTable'
import {
  isApnsDeregisterRequest,
  isApnsRegisterRequest,
  isTriggerRequest,
  pairIdFromIdentityPubKey,
  verifyApnsDeregisterRequest,
  verifyApnsRegisterRequest,
  verifyTriggerRequest,
  type TriggerRequest
} from '../../src/shared/e2ee/push'

const APNS_PATH_PREFIX = '/v1/apns/'
const PUSH_TRIGGER_PATH = '/v1/push/trigger'
const REGISTER_PATH = `${APNS_PATH_PREFIX}register`
const DEREGISTER_PATH = `${APNS_PATH_PREFIX}deregister`

/**
 * The strict trigger whitelist (design §5.3): the relay is the LAST gate
 * before Apple, so an unknown field REJECTS the frame — it is never
 * stripped-and-forwarded. Deliberately not a port of Tier-1's
 * sanitizePayload, which forwards workspaceId; the trigger carries no
 * workspace at all.
 */
const TRIGGER_FIELDS = new Set([
  'v',
  'macIdentityPubKey',
  'targetIphoneIdentityPubKey',
  'reason',
  'threadId',
  'runId',
  'taskId',
  'collapseId',
  'generatedAt',
  'issuedAt',
  'nonce',
  'sig'
])

/** Injection seam for tests and for cli.ts's real ApnsClient. */
export interface ApnsGatewaySender {
  send: (args: {
    deviceTokenHex: string
    env: 'production' | 'sandbox'
    pushType: 'alert'
    priority: number
    body: unknown
    collapseId?: string
  }) => Promise<{ delivered: boolean; reason?: string; status?: number }>
}

export interface ApnsGatewayConfig {
  /** Optional structured logger; defaults to a no-op (no token/threadId logging). */
  log?: (line: string) => void
  /** Durable token table location. Absent = in-memory only (tests). */
  tokenTablePath?: string
  /**
   * The resolve directory's shared state — the SAME object cli.ts hands to
   * RelayOptions.resolve.state, so the gateway shares the single-use nonce
   * set and can witness pairings. Absent = the gateway keeps its own nonce
   * map (register/deregister still work; witnessing degrades to open).
   */
  resolveState?: ResolveDirectoryState
  /** APNs sender; absent = triggers accept-and-drop (no key configured). */
  sender?: ApnsGatewaySender
  freshnessMs?: number
  coalesceMs?: number
  /** Per-Mac trigger budget (amplification guard, design §5.4). */
  triggerBucket?: { capacity: number; refillPerMinute: number }
  tokenTtlMs?: number
  now?: () => number
}

export function createApnsGateway(config: ApnsGatewayConfig = {}): ApnsGateway {
  const log = config.log ?? ((): void => {})
  const now = config.now ?? Date.now
  const freshnessMs = config.freshnessMs ?? 2 * 60 * 1000
  const coalesceMs = config.coalesceMs ?? 30_000
  const bucketConfig = config.triggerBucket ?? { capacity: 10, refillPerMinute: 60 }
  const table = new ApnsTokenTable({
    path: config.tokenTablePath ?? '',
    ttlMs: config.tokenTtlMs,
    now,
    log
  })
  // Own nonce map when no shared resolve state rides along. Same single-use
  // semantics: nonce → expiry, sweep lazily.
  const ownNonces = new Map<string, number>()
  const seenNonces = config.resolveState?.seenNonces ?? ownNonces
  /** [pairID, threadId, reason] → expiry — the 30s coalesce (PRIMARY dedup). */
  const coalesce = new Map<string, number>()
  /** macIdentityPubKey → token bucket. */
  const buckets = new Map<string, { tokens: number; refilledAt: number }>()
  let closed = false

  const sweep = (): void => {
    const at = now()
    for (const [nonce, expiry] of ownNonces) {
      if (expiry <= at) ownNonces.delete(nonce)
    }
    for (const [key, expiry] of coalesce) {
      if (expiry <= at) coalesce.delete(key)
    }
  }

  const nonceIsReplayed = (nonce: string): boolean => {
    sweep()
    const expiry = seenNonces.get(nonce)
    if (expiry && expiry > now()) return true
    seenNonces.set(nonce, now() + 2 * freshnessMs)
    return false
  }

  const isFresh = (issuedAt: number): boolean => Math.abs(now() - issuedAt) <= freshnessMs

  const takeTriggerToken = (macKey: string): boolean => {
    const at = now()
    let bucket = buckets.get(macKey)
    if (!bucket) {
      bucket = { tokens: bucketConfig.capacity, refilledAt: at }
      buckets.set(macKey, bucket)
    }
    const refill = ((at - bucket.refilledAt) / 60_000) * bucketConfig.refillPerMinute
    bucket.tokens = Math.min(bucketConfig.capacity, bucket.tokens + refill)
    bucket.refilledAt = at
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  const macIsWitnessed = (macIdentityPubKey: string): boolean => {
    // SOFT check (design §10 open decision, resolved here as log-only): a
    // closed-phone registration legitimately outlives the short-TTL resolve
    // entry, so absence must not brick re-registration. A persisted
    // witnessed set is the recorded follow-up.
    if (!config.resolveState) return true
    return config.resolveState.registrations.has(macIdentityPubKey)
  }

  const handleRegister = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      respond(res, 400, { ok: false, error: 'bad request' })
      return
    }
    if (!isApnsRegisterRequest(body) || !verifyApnsRegisterRequest(body)) {
      respond(res, 404, { ok: false, error: 'not found' })
      return
    }
    if (!isFresh(body.issuedAt) || nonceIsReplayed(body.nonce)) {
      respond(res, 400, { ok: false, error: 'bad request' })
      return
    }
    const pairID = pairIdFromIdentityPubKey(body.iphoneIdentityPubKey)
    const existing = table.get(pairID, body.macIdentityPubKey)
    if (existing && body.issuedAt < existing.issuedAt) {
      // Replayed older registration — never roll a live token back.
      respond(res, 409, { ok: false, error: 'stale registration' })
      return
    }
    if (!macIsWitnessed(body.macIdentityPubKey)) {
      log('[apns-gateway] register for an unwitnessed host (accepted; soft check)')
    }
    table.upsert({
      pairID,
      macIdentityPubKey: body.macIdentityPubKey,
      deviceTokenHex: body.deviceTokenHex,
      env: body.env,
      notifyFinishedTurns: body.notifyFinishedTurns,
      issuedAt: body.issuedAt
    })
    log('[apns-gateway] register ok')
    respond(res, 200, { ok: true })
  }

  const handleDeregister = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      respond(res, 400, { ok: false, error: 'bad request' })
      return
    }
    if (!isApnsDeregisterRequest(body) || !verifyApnsDeregisterRequest(body)) {
      respond(res, 404, { ok: false, error: 'not found' })
      return
    }
    if (!isFresh(body.issuedAt) || nonceIsReplayed(body.nonce)) {
      respond(res, 400, { ok: false, error: 'bad request' })
      return
    }
    table.deregister(pairIdFromIdentityPubKey(body.iphoneIdentityPubKey), body.macIdentityPubKey)
    log('[apns-gateway] deregister ok')
    // Uniform whether or not an entry existed.
    respond(res, 200, { ok: true })
  }

  const deliverTrigger = async (request: TriggerRequest): Promise<void> => {
    const pairID = pairIdFromIdentityPubKey(request.targetIphoneIdentityPubKey)
    const entry = table.get(pairID, request.macIdentityPubKey)
    if (!entry) return
    // Both trigger reasons are finish events; honor the signed opt-out.
    if (!entry.notifyFinishedTurns) {
      log('[apns-gateway] trigger suppressed notifyFinishedTurns=false')
      return
    }
    const sender = config.sender
    if (!sender) {
      log('[apns-gateway] trigger accepted with no sender configured (dropped)')
      return
    }
    try {
      const outcome = await sender.send({
        deviceTokenHex: entry.deviceTokenHex,
        env: entry.env,
        pushType: 'alert',
        priority: 10,
        // Routing-only, content-free by construction: the relay can seal
        // nothing (it holds no pair keys), so the banner is generic and the
        // rich Tier-1 path stays the only content carrier.
        body: {
          aps: {
            alert: {
              title: 'TaskWraith',
              body: request.reason === 'runFailed' ? 'A task failed.' : 'A task finished.'
            },
            sound: 'default'
          }
        },
        collapseId: request.collapseId
      })
      if (outcome.delivered) {
        // P7 acceptance receipt: content-free and device-free. It proves Apple
        // accepted this relay send without logging token, pair, thread, or run.
        log(`[apns-gateway] send delivered env=${entry.env}`)
      } else if (/^Unregistered$/i.test(outcome.reason ?? '')) {
        // Apple's authoritative dead-token verdict — the ONLY reap signal.
        table.reapUnregistered(pairID, request.macIdentityPubKey)
      } else if (!outcome.delivered && /^BadDeviceToken$/i.test(outcome.reason ?? '')) {
        // DIVERGENCE from Tier-1, by design (§6.4): both Apple gateways
        // answer BadDeviceToken for the other env's token, so it is a soft
        // signal here — log, keep the registration.
        log('[apns-gateway] BadDeviceToken (kept; possible env mismatch)')
      }
    } catch (error) {
      log(`[apns-gateway] send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleTrigger = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      respond(res, 400, { ok: false, error: 'bad request' })
      return
    }
    // Strict whitelist BEFORE anything else: unknown fields reject.
    if (body && typeof body === 'object') {
      for (const key of Object.keys(body as Record<string, unknown>)) {
        if (!TRIGGER_FIELDS.has(key)) {
          respond(res, 400, { ok: false, error: 'bad request' })
          return
        }
      }
    }
    if (!isTriggerRequest(body) || !verifyTriggerRequest(body)) {
      respond(res, 404, { ok: false, error: 'not found' })
      return
    }
    if (!isFresh(body.issuedAt) || nonceIsReplayed(body.nonce)) {
      respond(res, 400, { ok: false, error: 'bad request' })
      return
    }
    if (!takeTriggerToken(body.macIdentityPubKey)) {
      respond(res, 429, { ok: false, error: 'over budget' })
      return
    }
    const pairID = pairIdFromIdentityPubKey(body.targetIphoneIdentityPubKey)
    const coalesceKey = [pairID, body.threadId ?? '', body.reason].join('\u0000')
    const held = coalesce.get(coalesceKey)
    if (held && held > now()) {
      // 200 so a buggy Mac does not retry-storm; the banner already exists.
      respond(res, 200, { ok: true, coalesced: true })
      return
    }
    coalesce.set(coalesceKey, now() + coalesceMs)
    // Uniform 200 regardless of delivery — per-device outcomes leak nothing.
    respond(res, 200, { ok: true })
    void deliverTrigger(body)
  }

  return {
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      const path = (req.url || '').split('?')[0]
      const owned = path === PUSH_TRIGGER_PATH || path.startsWith(APNS_PATH_PREFIX)
      if (!owned) return false
      if (closed) {
        respond(res, 503, { ok: false, error: 'closing' })
        return true
      }
      if (req.method !== 'POST') {
        respond(res, 404, { ok: false, error: 'not found' })
        return true
      }
      if (path === REGISTER_PATH) void handleRegister(req, res)
      else if (path === DEREGISTER_PATH) void handleDeregister(req, res)
      else if (path === PUSH_TRIGGER_PATH) void handleTrigger(req, res)
      else respond(res, 404, { ok: false, error: 'not found' })
      return true
    },
    close(): void {
      closed = true
      table.sweep()
      log('[apns-gateway] close')
    }
  }
}
