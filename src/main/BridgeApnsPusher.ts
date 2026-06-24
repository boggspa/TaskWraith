import { Http2ApnsPusher } from './Http2ApnsPusher'
import type { PushEnvelope } from '../shared/e2ee/pushSeal'

/**
 * BridgeApnsPusher — Phase C5 scaffold for desktop → iPhone wake-pushes via APNs.
 *
 * The real flow (when fully wired):
 *   1. iPhone pairs with the Mac (existing Phase C2 handshake).
 *   2. iPhone registers its APNs device token via a daemon RPC and the
 *      desktop stores `{pairID → token, env}` in `BridgeApnsTokenStore`.
 *   3. Long-running agent on the Mac hits a tool call that needs user
 *      approval.
 *   4. Mac's approval flow checks: is there a paired iOS device, and is
 *      the user away from the desktop? If yes:
 *      `apnsPusher.pushApprovalNeeded(pairID, { threadId, toolCallId, ... })`
 *   5. APNs delivers privacy-safe routing metadata only. The iPhone fetches
 *      user-visible approval details over the E2EE bridge after wake/reconnect.
 *   6. iPhone reconnects to the bridge, sees the pending approval, user
 *      decides. The decision flows back through the existing
 *      `bridge.requestActionAck` round-trip (kind: 'approvalReply').
 *
 * This file ships **only the interface + a no-op default**. The real APNs
 * HTTP/2 client (talking to api.push.apple.com / sandbox) lands when:
 *   - Apple Developer credentials are wired (the .p8 token-signing key,
 *     team ID, key ID, bundle ID for the iOS companion app).
 *   - The iOS companion app exists and can register its device token.
 *
 * Until then: the interface is honored at every approval point, but
 * `NoopApnsPusher` just logs the intent. This means the codebase shape
 * is stable and adding the real pusher is a constructor swap, not a
 * sweep of call sites.
 *
 * Environment knobs:
 *   - `TASKWRAITH_BRIDGE_APNS=production` — use production APNs gateway when
 *     a real pusher is configured (default if APNs is enabled).
 *   - `TASKWRAITH_BRIDGE_APNS=sandbox` — use sandbox APNs gateway.
 *   - `TASKWRAITH_BRIDGE_APNS_DRY_RUN=1` — even with a real pusher, log only;
 *     don't actually hit Apple's servers. Useful for staging tests.
 */

export type BridgeApnsEnv = 'production' | 'sandbox'

export interface BridgeApprovalPushPayload {
  /** The pairing identifier of the target iPhone. */
  pairID: string
  /** Opaque workspace id only. Never send a local filesystem path via APNs. */
  workspaceId?: string | null
  /** Thread the agent is running on. */
  threadId: string
  /** The pending tool-call id; iOS will use this to match against
   * `BridgeApprovalReplyAction.toolCallId` in the user's reply. */
  toolCallId: string
  /** Short user-facing description (e.g. "Run `rm -rf /tmp/foo`?"). */
  summary: string
  /** Optional deep-link path; iOS app can use this to jump straight to the
   * approval view. Format is host-app specific. */
  deepLinkPath?: string
  /** Optional approval-timeout deadline (ms since epoch). The iOS UI can
   * show a countdown; the desktop independently auto-denies on its own
   * timer. */
  expiresAt?: number
}

export type BridgeRemoteAttentionReason =
  | 'approval'
  | 'question'
  | 'taskNeedsAttention'
  | 'ensemble'
  | 'wakeup'
  | 'resume'
  | 'runComplete'
  | 'runFailed'

export interface BridgeRemoteAttentionPushPayload {
  pairID: string
  reason: BridgeRemoteAttentionReason
  workspaceId?: string | null
  threadId?: string
  runId?: string
  approvalId?: string
  questionId?: string
  wakeupId?: string
  taskId?: string
  projectionKind?: string
  generatedAt?: string
  /** Optional per-device ENCRYPTED rich content (run-complete/failed only). The
   * NSE decrypts it for a rich banner; Apple/the relay see only ciphertext. Set
   * per-device by RemoteAttentionApnsFanout (each device has a distinct key).
   * Serialized OUTSIDE `aps` so only the extension reads it. */
  twpush?: PushEnvelope
}

export interface BridgeApnsPushResult {
  /** Whether the push was actually delivered (or attempted) to APNs. */
  delivered: boolean
  /** The Apple-side notification id when delivered. Empty string for
   * no-op pushers. */
  apnsId: string
  /** Reason for non-delivery, if `delivered` is false. */
  reason?: string
}

export interface BridgeApnsPusher {
  /** Discriminator: present + true ONLY on the no-op pusher (no APNs
   * credentials configured). Lets callers detect the LIVE "inert" state that
   * the persisted settings `configured` flag misses — e.g. a safeStorage
   * decrypt failure leaves settings saying configured while the live pusher
   * fell back to NoopApnsPusher. */
  readonly isNoop?: true

  /** Push a "tool call needs approval" notification to a paired iOS device.
   * Returns a structured result so the caller (ApprovalService) can log
   * whether the push went out. Never throws — failed pushes are surfaced
   * via `delivered: false`. */
  pushApprovalNeeded(payload: BridgeApprovalPushPayload): Promise<BridgeApnsPushResult>

  /** Push a generic, privacy-safe attention notification. The payload may
   * include routing identifiers only; user prompts, commands, paths, diffs,
   * and approval summaries must stay out of APNs. */
  pushRemoteAttentionNeeded(
    payload: BridgeRemoteAttentionPushPayload
  ): Promise<BridgeApnsPushResult>

  /** Push a low-priority "state sync" silent notification. Used to nudge
   * the iPhone bridge client to reconnect when it's been backgrounded
   * (e.g. after a new pairing on a different device, or when transcript
   * events have accumulated for the device's watched chats). */
  pushSilent(pairID: string): Promise<BridgeApnsPushResult>

  /** Token-targeted variants used by the per-device fan-out
   * (`RemoteAttentionApnsFanout`), which already resolves `{pairID → token,
   * env}` from the token store. Implementations that cannot deliver (Noop)
   * still return a visible `{delivered:false, reason:'noop'}` so the skip is
   * logged and testable rather than a silent early-return. */
  pushApprovalToToken(
    deviceTokenHex: string,
    env: BridgeApnsEnv,
    payload: BridgeApprovalPushPayload
  ): Promise<BridgeApnsPushResult>
  pushRemoteAttentionToToken(
    deviceTokenHex: string,
    env: BridgeApnsEnv,
    payload: BridgeRemoteAttentionPushPayload
  ): Promise<BridgeApnsPushResult>
  pushSilentToToken(
    deviceTokenHex: string,
    env: BridgeApnsEnv,
    payload?: Omit<BridgeRemoteAttentionPushPayload, 'pairID'>
  ): Promise<BridgeApnsPushResult>
}

/**
 * NoopApnsPusher — the default implementation. Logs intent but never hits
 * Apple. Always returns `delivered: false` with `reason: 'noop'`. This
 * keeps the rest of the codebase wired up while the iOS companion app +
 * Apple Developer credentials are still in flight.
 */
export class NoopApnsPusher implements BridgeApnsPusher {
  readonly isNoop = true
  private readonly log: (line: string) => void

  constructor(log?: (line: string) => void) {
    this.log = log ?? (() => {})
  }

  async pushApprovalNeeded(payload: BridgeApprovalPushPayload): Promise<BridgeApnsPushResult> {
    this.log(
      `[BridgeApnsPusher noop] would push approval pairID=${payload.pairID} ws=${payload.workspaceId ?? 'global'} thread=${payload.threadId} tool=${payload.toolCallId} — APNs not yet configured`
    )
    return { delivered: false, apnsId: '', reason: 'noop' }
  }

  async pushRemoteAttentionNeeded(
    payload: BridgeRemoteAttentionPushPayload
  ): Promise<BridgeApnsPushResult> {
    this.log(
      `[BridgeApnsPusher noop] would push remote attention pairID=${payload.pairID} reason=${payload.reason} ws=${payload.workspaceId ?? 'global'} thread=${payload.threadId ?? ''} — APNs not yet configured`
    )
    return { delivered: false, apnsId: '', reason: 'noop' }
  }

  async pushSilent(pairID: string): Promise<BridgeApnsPushResult> {
    this.log(`[BridgeApnsPusher noop] would silent-push pairID=${pairID} — APNs not yet configured`)
    return { delivered: false, apnsId: '', reason: 'noop' }
  }

  async pushApprovalToToken(
    deviceTokenHex: string,
    _env: BridgeApnsEnv,
    payload: BridgeApprovalPushPayload
  ): Promise<BridgeApnsPushResult> {
    this.log(
      `[BridgeApnsPusher noop] would push approval-to-token tok=${deviceTokenHex.slice(0, 8)}… thread=${payload.threadId} tool=${payload.toolCallId} — APNs not configured`
    )
    return { delivered: false, apnsId: '', reason: 'noop' }
  }

  async pushRemoteAttentionToToken(
    deviceTokenHex: string,
    _env: BridgeApnsEnv,
    payload: BridgeRemoteAttentionPushPayload
  ): Promise<BridgeApnsPushResult> {
    this.log(
      `[BridgeApnsPusher noop] would push remote-attention-to-token tok=${deviceTokenHex.slice(0, 8)}… reason=${payload.reason} — APNs not configured`
    )
    return { delivered: false, apnsId: '', reason: 'noop' }
  }

  async pushSilentToToken(
    deviceTokenHex: string,
    _env: BridgeApnsEnv,
    _payload?: Omit<BridgeRemoteAttentionPushPayload, 'pairID'>
  ): Promise<BridgeApnsPushResult> {
    this.log(
      `[BridgeApnsPusher noop] would silent-push-to-token tok=${deviceTokenHex.slice(0, 8)}… — APNs not configured`
    )
    return { delivered: false, apnsId: '', reason: 'noop' }
  }
}

export interface BridgeApnsPusherOptions {
  /** Inject the env or read from `TASKWRAITH_BRIDGE_APNS`. */
  env?: BridgeApnsEnv
  /** Set true (or env: `TASKWRAITH_BRIDGE_APNS_DRY_RUN=1`) to log only. */
  dryRun?: boolean
  log?: (line: string) => void
  /** APNs credentials. When the required fields are present, the
   * factory returns a `Http2ApnsPusher` connecting to Apple. When
   * any required field is missing, the factory falls back to
   * `NoopApnsPusher` and logs.
   *
   * Phase E1 (gap #1): callers can now pass `authKeyPem` (the .p8
   * content decrypted from Settings safeStorage) as an alternative
   * to `authKeyPath` (the file-on-disk env-var fallback). Exactly
   * one of the two must be set.
   *
   * Env-var fallback paths: TASKWRAITH_APNS_KEY_PATH, TASKWRAITH_APNS_KEY_ID,
   * TASKWRAITH_APNS_TEAM_ID, TASKWRAITH_APNS_BUNDLE_ID. */
  credentials?: {
    authKeyPath?: string
    authKeyPem?: string
    keyId: string
    teamId: string
    bundleId: string
  }
}

/** Factory: returns either a real `Http2ApnsPusher` (when credentials are
 * configured) or `NoopApnsPusher` (no credentials). Credential
 * resolution: explicit `options.credentials` > env vars > none.
 *
 * Env-var convention:
 *   - TASKWRAITH_APNS_KEY_PATH   path to AuthKey_XXXXXXXXXX.p8
 *   - TASKWRAITH_APNS_KEY_ID     10-char Key ID from Apple Developer Keys
 *   - TASKWRAITH_APNS_TEAM_ID    10-char Team ID from membership page
 *   - TASKWRAITH_APNS_BUNDLE_ID  iOS app bundle id (e.g. com.example.TaskWraith.ios)
 *   - TASKWRAITH_BRIDGE_APNS     'sandbox' | 'production' (forced env; usually
 *                             omitted so per-device env from the token
 *                             registration picks)
 *   - TASKWRAITH_BRIDGE_APNS_DRY_RUN  '1' or 'true' to log instead of send
 *     (production: applied via the Http2ApnsPusher's forceEnv? no —
 *     dryRun returns the NoopApnsPusher to avoid network entirely).
 */
export function createBridgeApnsPusher(options: BridgeApnsPusherOptions = {}): BridgeApnsPusher {
  const log = options.log ?? (() => {})
  // Read env if not explicitly provided.
  const envVar = process.env.TASKWRAITH_BRIDGE_APNS
  const env: BridgeApnsEnv = options.env ?? (envVar === 'sandbox' ? 'sandbox' : 'production')
  const dryRun =
    options.dryRun ??
    (process.env.TASKWRAITH_BRIDGE_APNS_DRY_RUN === '1' ||
      process.env.TASKWRAITH_BRIDGE_APNS_DRY_RUN === 'true')

  if (dryRun) {
    log(`[BridgeApnsPusher] dryRun=true → using NoopApnsPusher (logged, never delivered)`)
    return new NoopApnsPusher(log)
  }

  const creds = resolveCredentials(options)
  if (!creds) {
    log(
      `[BridgeApnsPusher] using NoopApnsPusher (env=${env}) — credentials missing. Set TASKWRAITH_APNS_KEY_PATH + TASKWRAITH_APNS_KEY_ID + TASKWRAITH_APNS_TEAM_ID + TASKWRAITH_APNS_BUNDLE_ID to enable real push delivery.`
    )
    return new NoopApnsPusher(log)
  }

  try {
    // Static import via the file's top-level import block (below).
    // Originally lazy-required to defer http2 module load, but vitest's
    // ESM transform makes dynamic require fragile. http2 is a Node
    // built-in — load cost is negligible — so static import is fine.
    const pusher = new Http2ApnsPusher({
      authKeyPath: creds.authKeyPath,
      authKeyPem: creds.authKeyPem,
      keyId: creds.keyId,
      teamId: creds.teamId,
      bundleId: creds.bundleId,
      forceEnv: options.env, // explicit option forces; otherwise per-device env wins
      log
    })
    log(
      `[BridgeApnsPusher] using Http2ApnsPusher (keyId=${creds.keyId}, teamId=${creds.teamId}, bundleId=${creds.bundleId}, source=${creds.authKeyPem ? 'pem' : 'path'})`
    )
    return pusher
  } catch (err) {
    log(
      `[BridgeApnsPusher] failed to instantiate Http2ApnsPusher (${err instanceof Error ? err.message : String(err)}) — falling back to NoopApnsPusher`
    )
    return new NoopApnsPusher(log)
  }
}

function resolveCredentials(
  options: BridgeApnsPusherOptions
): BridgeApnsPusherOptions['credentials'] | null {
  if (options.credentials) {
    const c = options.credentials
    if ((c.authKeyPath || c.authKeyPem) && c.keyId && c.teamId && c.bundleId) {
      return c
    }
    return null
  }
  // Env-var fallback (file-on-disk path only). The settings-UI flow
  // injects credentials directly via `options.credentials` with a
  // decrypted PEM string; we never read sensitive material from env
  // when settings has populated values.
  const authKeyPath = process.env.TASKWRAITH_APNS_KEY_PATH
  const keyId = process.env.TASKWRAITH_APNS_KEY_ID
  const teamId = process.env.TASKWRAITH_APNS_TEAM_ID
  const bundleId = process.env.TASKWRAITH_APNS_BUNDLE_ID
  if (authKeyPath && keyId && teamId && bundleId) {
    return { authKeyPath, keyId, teamId, bundleId }
  }
  return null
}
