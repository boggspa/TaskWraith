/*
 * Tier-2 APNs gateway — TYPE-ONLY surface.
 *
 * This module contains ZERO runtime code. server.ts imports it with
 * `import type { ApnsGateway }`, which TypeScript erases entirely, so the
 * gateway IMPLEMENTATION (relay/src/apnsGateway.ts) and everything it will pull
 * in (the Apple HTTP/2 sender, the shared .p8) never enter server.ts's runtime
 * import graph — and therefore never bundle into Electron main's
 * out/main/index.js (src/main/index.ts imports server.ts at :227).
 *
 * The standalone runner (relay/src/cli.ts) is the ONLY module that imports the
 * implementation and constructs a gateway. The embedded relay passes none, so a
 * shipped app stays a blind forwarder that 404s every gateway path.
 *
 * Enforced by scripts/guard-no-bundled-secrets.cjs. See
 * docs/ios-push-gateway-design.md §4.
 */

import type { IncomingMessage, ServerResponse } from 'http'

/**
 * Finish-event reasons the Tier-2 gateway accepts on a push trigger. Blocking
 * reasons (approval/question/taskNeedsAttention) stay Tier-1 Mac-direct and are
 * intentionally absent here.
 */
export type TriggerReason = 'runComplete' | 'runFailed'

/**
 * The injected gateway capability. Inverse polarity to RelayOptions.hostInfo /
 * beginPair: present only on the project-operated standalone relay, absent on
 * the embedded + self-host relay (which 404s gateway paths).
 */
export interface ApnsGateway {
  /**
   * If `req` targets a gateway-owned path (/v1/apns/* or /v1/push/trigger), take
   * ownership of the response (synchronously or async) and return true. Return
   * false for any other path so the relay falls through to its 404.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Release timers / sessions / flush the token table on relay shutdown. */
  close: () => void | Promise<void>
}
