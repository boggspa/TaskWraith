/*
 * Tier-2 APNs gateway — IMPLEMENTATION (scaffold).
 *
 * Imported ONLY by relay/src/cli.ts (the standalone runner). It must NEVER be
 * imported — even for a type — by relay/src/server.ts, because server.ts is
 * bundled into Electron main and any module in its runtime graph ships to every
 * user. Types live in ./apnsGatewayTypes (erased). The CI guard
 * (scripts/guard-no-bundled-secrets.cjs) fails the build if this boundary
 * breaks.
 *
 * P0 status: a scaffold only — no token table, no Apple .p8, no APNs calls. It
 * claims the gateway paths and returns 501 so the routing contract is visible
 * while the real implementation lands in later phases (P4 token table, P5
 * trigger + send). The .p8 will be read HERE (cli-only) from a runtime secret
 * (KMS / mounted file), never bundled. See docs/ios-push-gateway-design.md §9.
 */

import type { IncomingMessage, ServerResponse } from 'http'
import type { ApnsGateway } from './apnsGatewayTypes'

const APNS_PATH_PREFIX = '/v1/apns/'
const PUSH_TRIGGER_PATH = '/v1/push/trigger'

export interface ApnsGatewayConfig {
  /** Optional structured logger; defaults to a no-op (no token/threadId logging). */
  log?: (line: string) => void
}

/**
 * Construct the scaffold gateway. P0 takes no key. Real key material + the
 * token table arrive in later phases.
 */
export function createApnsGateway(config: ApnsGatewayConfig = {}): ApnsGateway {
  const log = config.log ?? ((): void => {})
  return {
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      const path = (req.url || '').split('?')[0]
      const owned = path === PUSH_TRIGGER_PATH || path.startsWith(APNS_PATH_PREFIX)
      if (!owned) return false
      // Scaffold: drain any body so the socket frees, then 501.
      req.resume()
      log(`[apns-gateway] 501 scaffold ${req.method ?? '?'} ${path}`)
      res.statusCode = 501
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ ok: false, error: 'not implemented' }))
      return true
    },
    close(): void {}
  }
}
