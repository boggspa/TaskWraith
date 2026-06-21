import { readFileSync } from 'fs'
import type * as http2 from 'http2'
import { ApnsClient } from '../shared/apns/apnsSendCore'
import type {
  BridgeApnsEnv,
  BridgeApnsPusher,
  BridgeApnsPushResult,
  BridgeApprovalPushPayload,
  BridgeRemoteAttentionPushPayload,
  BridgeRemoteAttentionReason
} from './BridgeApnsPusher'

// derEcdsaToConcat moved to the shared keyless send-core (src/shared/apns); it
// is re-exported here so existing importers (and Http2ApnsPusher.test.ts) keep
// resolving it from this module.
export { derEcdsaToConcat } from '../shared/apns/apnsSendCore'

/**
 * Http2ApnsPusher — production APNs delivery for Tier-1 (the host owner's OWN
 * .p8).
 *
 * Thin wrapper over the keyless shared send-core (`ApnsClient`,
 * src/shared/apns). This class owns the Tier-1 concerns: loading the .p8 (from
 * a path or a safeStorage-decrypted PEM) and building the privacy-safe,
 * routing-only aps bodies. JWT minting + HTTP/2 delivery are delegated to
 * `ApnsClient`, which the Tier-2 relay gateway reuses with a project-held key
 * loaded OUTSIDE Electron main (docs/ios-push-gateway-design.md §7).
 *
 * One key + key id + team id triplet works for both production and sandbox APNs
 * gateways; the iOS device's reported env (from
 * `BridgeActionPayload.registerApnsToken`) picks which Apple host to target per
 * push.
 *
 * Token cleanup: when Apple returns `:status 410 Unregistered` or
 * `400 BadDeviceToken`, the device token is permanently invalid and should be
 * removed from `BridgeApnsTokenStore`. The send result reports the reason; the
 * caller decides whether to delete.
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

export class Http2ApnsPusher implements BridgeApnsPusher {
  /** Keyless shared transport (JWT mint + sticky HTTP/2 sessions + send). The
   * Tier-2 relay gateway uses the same ApnsClient with a project-held key
   * loaded outside Electron main. */
  private readonly client: ApnsClient
  /** Retained for the per-push apns-expiration window calc below. */
  private readonly now: () => Date

  constructor(config: Http2ApnsPusherConfig) {
    // Phase E1: accept either an in-memory PEM (`authKeyPem`) or a filesystem
    // path (`authKeyPath`). Settings-UI path uses the former (decrypted from
    // safeStorage); env-var path uses the latter. Exactly one must be provided;
    // PEM wins if both are set (it's already been validated through the
    // secure-storage round-trip). KEY LOAD stays here (Tier-1); the keyless
    // ApnsClient never reads files or secrets.
    let authKey: string
    if (config.authKeyPem && config.authKeyPem.trim()) {
      authKey = config.authKeyPem
    } else if (config.authKeyPath) {
      authKey = readFileSync(config.authKeyPath, 'utf-8')
    } else {
      throw new Error('Http2ApnsPusher: must provide either authKeyPem or authKeyPath')
    }
    if (!authKey.includes('BEGIN PRIVATE KEY')) {
      throw new Error(
        config.authKeyPath
          ? `Http2ApnsPusher: ${config.authKeyPath} does not look like a PEM-encoded PKCS8 private key (.p8)`
          : 'Http2ApnsPusher: provided authKeyPem does not look like a PEM-encoded PKCS8 private key (.p8)'
      )
    }
    this.now = config.now ?? ((): Date => new Date())
    this.client = new ApnsClient({
      authKeyPem: authKey,
      keyId: config.keyId,
      teamId: config.teamId,
      bundleId: config.bundleId,
      forceEnv: config.forceEnv,
      log: config.log,
      connect: config.connect,
      jwtLifetimeSeconds: config.jwtLifetimeSeconds,
      now: config.now
    })
  }

  async pushApprovalNeeded(_payload: BridgeApprovalPushPayload): Promise<BridgeApnsPushResult> {
    // The caller (ApprovalService) passes the device token via a
    // separate path. This signature predates the credentialed pusher;
    // we keep the BridgeApnsPusher contract intact and read the token
    // from a lookup the caller has separately threaded through. Use
    // pushApprovalToToken instead.
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
    return this.client.send({
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
    return this.client.send({
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
    return this.client.send({
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
    this.client.close()
  }

  // MARK: - aps body builders (Tier-1; privacy-safe, routing identifiers only)

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
