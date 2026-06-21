/*
 * Standalone relay runner — for self-hosting the relay somewhere other than
 * the Mac (a VPS, a home server, a Tailscale node):
 *
 *   npx tsx relay/src/cli.ts            # listens on :8787
 *   PORT=9000 npx tsx relay/src/cli.ts
 *
 * When TaskWraith runs with IOS_REMOTE_TRUE=1 and NO TASKWRAITH_RELAY_URL,
 * the app embeds this same relay in-process instead — no external command
 * needed. Set TASKWRAITH_RELAY_URL to point the app at a relay started here.
 */

import { createRelayServer, type RelayOptions } from './server'
import { createApnsGateway } from './apnsGateway'

const port = Number(process.env.PORT || 8787)

// cli.ts is the ONLY place a Tier-2 APNs gateway is ever constructed — the
// embedded relay (Electron main) never does, so the project .p8 + gateway impl
// never ship in the app. OFF unless explicitly enabled on this standalone
// deployment. The P0 scaffold takes no key and 501s owned paths; later phases
// load the .p8 here from a runtime secret (KMS / mounted file). See
// docs/ios-push-gateway-design.md §4.
const options: RelayOptions = { port }
if (process.env.TASKWRAITH_RELAY_APNS_GATEWAY === '1') {
  options.apnsGateway = createApnsGateway({
    // eslint-disable-next-line no-console
    log: (line) => console.log(line)
  })
  // eslint-disable-next-line no-console
  console.log('[taskwraith-relay] APNs gateway scaffold enabled (501 until implemented)')
}

void createRelayServer(options)
  .then((handle) => {
    // eslint-disable-next-line no-console
    console.log(`[taskwraith-relay] listening on :${handle.port}`)
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      `[taskwraith-relay] failed to start: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  })
