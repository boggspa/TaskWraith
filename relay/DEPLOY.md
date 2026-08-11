# Relay deployment + Tier-2 APNs gateway runbook

This lives in `relay/` (not `docs/` — that directory is gitignored) and is
the P8 artifact of `docs/ios-push-gateway-design.md`.

## What the gateway changes about the relay's trust posture

The plain relay is a blind ciphertext forwarder holding no key material.
**A gateway-enabled relay is not**: it holds the project APNs `.p8`, a
routing-only token table, and it newly *sees* device tokens, the
phone↔Mac reachability graph, and turn-completion timing. Content stays
sealed end-to-end — but "preserves E2EE blindness" would be an overstated
claim and must not appear in user-facing copy (design §8.2). SECURITY.md
carries the forked posture.

## Secret handling — the three rules

1. The `.p8` is **never** in the repo, an image layer, or an env-var PEM.
   It reaches the process as a **mounted file**: systemd `LoadCredential`
   (see `taskwraith-relay.service`) or a Docker secret.
2. `TASKWRAITH_RELAY_APNS_KEY_PATH` is the only way the process learns the
   key location, and `relay/src/cli.ts` is the only module that reads it.
   The Electron app cannot construct a gateway at all — enforced by
   `scripts/guard-no-bundled-secrets.cjs` in CI.
3. Once real keys exist, add the key id to `TASKWRAITH_SECRET_FINGERPRINTS`
   in CI so the bundle scan would catch an accidental embed.

## Environment reference

| Variable | Meaning |
| --- | --- |
| `TASKWRAITH_RELAY_APNS_GATEWAY=1` | Enable the gateway (off = blind relay) |
| `TASKWRAITH_RELAY_APNS_KEY_PATH` | Mounted `.p8` path |
| `TASKWRAITH_RELAY_APNS_KEY_ID` | Apple key id for the `.p8` |
| `TASKWRAITH_RELAY_APNS_TEAM_ID` | Apple team id (`8CZML8FK2D`) |
| `TASKWRAITH_RELAY_APNS_BUNDLE_ID` | Defaults to `com.taskwraith.companion` |
| `TASKWRAITH_RELAY_APNS_TOKENS_PATH` | Durable token table (default `./apns-tokens.json`) |
| `PORT` / `HOST` | Listener |

Sender-less mode (gateway on, no key envs) accepts registrations and drops
triggers — useful for staging the table before the key decision lands.

## Key rotation runbook

1. Create the replacement key in the Apple Developer portal (App Store
   Connect → Keys). Both keys stay valid during the swap.
2. Install the new `.p8` beside the old one
   (`/etc/taskwraith/apns-key-new.p8`), update `LoadCredential` and
   `TASKWRAITH_RELAY_APNS_KEY_ID`, `systemctl daemon-reload && systemctl
   restart taskwraith-relay`.
3. Verify a staging device receives a trigger (`journalctl -u
   taskwraith-relay` shows `register ok` + no send failures).
4. Revoke the old key in the portal, delete the old file.
5. Update `TASKWRAITH_SECRET_FINGERPRINTS` in CI to the new key id.

Compromise path: revoke FIRST in the portal (Apple-side kill), then rotate
as above. The token table contains no secrets — routing hashes and device
tokens only — and does not need to be purged on key rotation.

## Mac-side wiring (P6)

A Mac WITHOUT its own APNs credentials becomes Tier-2 by setting
`TASKWRAITH_PUSH_GATEWAY_URL` to this relay's base URL (ws:// and http://
forms both accepted). The XOR is strict and global: a Mac with a live
`.p8` never fires the gateway, so one finish never lands twice. Tier-2
inherits Tier-1's suppressions — nothing is sent while the user is at the
Mac, and `TASKWRAITH_BRIDGE_APNS_DRY_RUN` suppresses Tier-2 as well (a
dry-run pusher is a simulation, not an absence of credentials).

## The P7 gate (not this document's job)

Before any broad rollout, the design's P7 single-device end-to-end test
must pass: one real phone, app force-quit, owner `.p8` ABSENT from the
sending Mac, project relay in the middle → the finish banner lands, no
double-banner with a second owner-key Mac, and the opt-out suppresses.
