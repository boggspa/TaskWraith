import type { ClientHttp2Session } from 'http2'

/*
 * Shared APNs types for the keyless send-core (src/shared/apns/apnsSendCore.ts).
 * Used by Tier-1 (src/main/Http2ApnsPusher) and the Tier-2 relay gateway.
 * Node-only zone (the send-core imports http2/crypto); never import from the
 * renderer.
 */

export type ApnsEnv = 'production' | 'sandbox'
/** `liveactivity` is NOT interchangeable with the others: Apple routes it to a
 *  DIFFERENT topic (`<bundleId>.push-type.liveactivity`). The send-core derives
 *  that topic from this field rather than taking it as a parameter — a
 *  liveactivity push sent to the plain bundle topic is rejected with
 *  `TopicDisallowed`, and there is no combination of the two worth allowing. */
export type ApnsPushType = 'alert' | 'background' | 'liveactivity'
export type ApnsPriority = 5 | 10

export interface ApnsSendResult {
  /** Whether the push was delivered (HTTP 200 from Apple). */
  delivered: boolean
  /** Apple-side notification id when delivered; empty otherwise. */
  apnsId: string
  /** Apple's `reason` (or a transport error message) when not delivered. */
  reason?: string
}

export interface ApnsSendArgs {
  deviceTokenHex: string
  env: ApnsEnv
  pushType: ApnsPushType
  priority: ApnsPriority
  /** The fully-built JSON aps body. The send-core is payload-AGNOSTIC: callers
   *  build their own body (Tier-1 routing-safe approval/attention; Tier-2
   *  routing-only finish events). */
  body: string
  /** Absolute unix-seconds deadline; APNs stores + retries until then. */
  expirationSeconds?: number
  /** apns-collapse-id (<=64 bytes) so re-sends of the same item replace rather
   *  than stack, and a flood can't trip per-app throttling. */
  collapseId?: string
}

export interface ApnsClientConfig {
  /** PEM-encoded PKCS8 .p8 content, ALREADY loaded. The send-core never reads
   *  files or secrets: Tier-1 decrypts from Electron safeStorage, the Tier-2
   *  relay loads from a runtime secret (KMS / mounted file) in cli.ts. */
  authKeyPem: string
  /** 10-char Key ID from the Apple Developer Keys page. */
  keyId: string
  /** 10-char Team ID. */
  teamId: string
  /** iOS bundle id (apns-topic header). */
  bundleId: string
  /** Force a specific environment for ALL sends regardless of per-send env. */
  forceEnv?: ApnsEnv
  log?: (line: string) => void
  /** Inject a custom HTTP/2 connect (tests). Defaults to http2.connect. */
  connect?: (authority: string) => ClientHttp2Session
  /** JWT lifetime in seconds; Apple rejects > 60 min. Default 50 min. */
  jwtLifetimeSeconds?: number
  /** Clock injector (tests). */
  now?: () => Date
}
