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

import { readFileSync } from 'fs'
import { createRelayServer, type RelayOptions } from './server'
import { createApnsGateway, type ApnsGatewaySender } from './apnsGateway'
import { createResolveDirectoryState } from './resolve'

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || undefined

// cli.ts is the ONLY place a Tier-2 APNs gateway is ever constructed — the
// embedded relay (Electron main) never does, so the project .p8 + gateway impl
// never ship in the app. OFF unless explicitly enabled on this standalone
// deployment. The .p8 loads HERE from a runtime secret (a mounted file via
// systemd LoadCredential / Docker secret — never an image COPY layer, never
// an env-var PEM). See the APNs gateway design §4 and
// the private deployment runbook.
const options: RelayOptions = { port, ...(host ? { host } : {}) }
if (process.env.TASKWRAITH_RELAY_APNS_GATEWAY === '1') {
  // Shared resolve-directory state: the SAME registrations + single-use
  // nonce set serve /v1/resolve/* (via RelayOptions.resolve.state) and the
  // gateway, so a nonce spent on one surface is spent on both and the
  // gateway can witness pairings.
  const resolveState = createResolveDirectoryState({})
  options.resolve = { ...(options.resolve ?? {}), state: resolveState }

  let sender: ApnsGatewaySender | undefined
  const keyPath = process.env.TASKWRAITH_RELAY_APNS_KEY_PATH
  const keyId = process.env.TASKWRAITH_RELAY_APNS_KEY_ID
  const teamId = process.env.TASKWRAITH_RELAY_APNS_TEAM_ID
  const bundleId = process.env.TASKWRAITH_RELAY_APNS_BUNDLE_ID || 'com.taskwraith.companion'
  if (keyPath && keyId && teamId) {
    // Deferred import keeps apnsSendCore out of every graph until the
    // operator has actually mounted a key.
    void import('../../src/shared/apns/apnsSendCore').then(({ ApnsClient }) => {
      const client = new ApnsClient({
        authKeyPem: readFileSync(keyPath, 'utf8'),
        keyId,
        teamId,
        bundleId,
        // eslint-disable-next-line no-console
        log: (line: string) => console.log(line)
      })
      sender = {
        // The gateway's sender seam passes the aps payload as a structured
        // object with an unvalidated numeric priority; ApnsClient writes the
        // body raw to the wire and requires the exact APNs priority set.
        send: (args) =>
          client.send({
            ...args,
            priority: args.priority === 5 ? 5 : 10,
            body: JSON.stringify(args.body)
          })
      }
      // eslint-disable-next-line no-console
      console.log('[taskwraith-relay] APNs sender ready (key mounted)')
    })
  } else {
    // eslint-disable-next-line no-console
    console.log(
      '[taskwraith-relay] APNs gateway WITHOUT a sender (no TASKWRAITH_RELAY_APNS_KEY_PATH/_KEY_ID/_TEAM_ID) — registrations accepted, triggers dropped'
    )
  }
  options.apnsGateway = createApnsGateway({
    // eslint-disable-next-line no-console
    log: (line) => console.log(line),
    tokenTablePath: process.env.TASKWRAITH_RELAY_APNS_TOKENS_PATH || './apns-tokens.json',
    resolveState,
    // Late-binding: the sender resolves after the dynamic import completes.
    sender: {
      send: (args) => {
        if (!sender) return Promise.resolve({ delivered: false, reason: 'no sender' })
        return sender.send(args)
      }
    }
  })
  // eslint-disable-next-line no-console
  console.log('[taskwraith-relay] APNs gateway enabled')
}

void createRelayServer(options)
  .then((handle) => {
    // eslint-disable-next-line no-console
    console.log(`[taskwraith-relay] listening on ${host || '*'}:${handle.port}`)
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      `[taskwraith-relay] failed to start: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  })
