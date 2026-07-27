# Human collaboration — two-Mac test runbook

**Status:** written 2026-07-26, ahead of the first real two-instance exercise.
Most of it is derived from the code paths, **not** from a completed run — treat
each "expected" line as a prediction to check, and correct this file as you go.

Actually verified 2026-07-27 (§2b only): two instances boot side by side under
`TASKWRAITH_INSTANCE_ID`, take separate userData without evicting each other,
and instance 1's embedded relay binds the offset port `:8789` while the release
build keeps `:8787`. The **collaboration flow itself is still unexercised.**

**Scenario this covers:** two Macs on **unrelated networks** — no shared LAN, no
shared tailnet, no relationship between the two machines beyond the invite you
send out of band.

---

## 1. Does the app support this at all?

Yes, via a door the collaboration UI never mentions by name.

The relay (`relay/src/server.ts`) is a dumb two-seat forwarder: one room per
collaborator, one `mac` seat and one `iphone` seat, frames forwarded verbatim.
It holds no keys and the `/v1/session/<roomId>` route is **unauthenticated by
design** — session ids are unguessable and every payload is end-to-end
encrypted, so seating a socket grants nothing on its own.

That means the collaborator does not need to be paired, on your tailnet, or on
your LAN. They need exactly one thing: **a relay URL they can reach from the
public internet.** Two ways to produce one:

| Lever | What it is | Cost |
|---|---|---|
| **Extra advertised relay door** (setting `iosRemoteManualRelayUrl`) | A public `wss://` URL you put in front of the host's *embedded* relay with any tunnel. Host still dials its own loopback; the collaborator dials the tunnel. | Zero infra — a quick tunnel is one command |
| `TASKWRAITH_RELAY_URL` env var | Both sides dial a relay you deployed yourself (the `relay/` package). | Needs a host + TLS |

**Use the first one tomorrow.** It is the shorter path and exercises the same
transport.

Why it clears the guards:
- `classifyRelayUrl` treats any non-loopback `wss:` URL as `remote`, so
  `remoteAvailable` is true and the invite-copy guard at `App.tsx:1643`
  (which hard-fails on `loopbackOnly`) does not fire.
- `selectAdvertisableRelayUrls` probes each candidate door before advertising it
  and **drops the dead ones with a readable warning**, so a stale tunnel URL
  won't silently ship inside an invite.

---

## 2. Host setup (do this before the other person is waiting)

1. **Enable remote access.** Settings → Devices. Creating an invite will
   auto-start the bridge (`prepareHumanCollaborationInviteTransport` calls
   `startIosRemoteBridge`), but starting it by hand first means you see failures
   now rather than mid-test.

2. **Note your relay port.** `defaultIosRelayPort()`:
   - packaged release build → **8787**
   - dev / packaged-debug build → **8788**
   - `TASKWRAITH_RELAY_PORT` overrides both.

3. **Put a public tunnel in front of it.** Any tunnel works; the relay only
   needs plain HTTP upgrade. For example:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

   That prints a `https://<random>.trycloudflare.com` URL.

4. **Advertise it.** Settings → Devices → (expand the networking details) →
   **"Extra advertised relay door"**. Enter the tunnel host as a wss URL:
   `wss://<random>.trycloudflare.com` — no path, no port. `normalizeManualRelayUrl`
   keeps an explicit port if you give one and leaves wss on 443 if you don't,
   which is what a tunnel wants.

5. **Create the share and copy the invite.** The invite JSON carries
   `relayUrls` (all advertisable doors), `roomId`, `shareId`, the invite token
   and `hostIdentityPubKeyB64`.

   > **Expected:** the copy succeeds and the alert does *not* say remote access
   > is off. If it says "No collaborator-reachable relay URL is available", the
   > tunnel door failed its probe — check the tunnel is still up, then create a
   > **fresh** invite (the doors are baked in at creation time).

6. **Send the invite out of band** (Signal, email, whatever). It is not a
   secret-free blob — it contains a single-use invite token — but the security
   model does not rest on it: admission still requires the 6-digit code compare.

## 2b. The same-Mac rehearsal (do this first — it costs 5 minutes)

You can run the whole flow against **two dev instances on one Mac** before
involving a second machine or a tunnel. Worth doing first: it separates "the
feature is broken" from "the network is broken", and it's the loop an agent can
drive over CDP.

`TASKWRAITH_INSTANCE_ID` (`src/main/devAppName.ts`, unpackaged builds only)
gives each instance its own app name, its own userData — so its own
single-instance lock and its own remote identity — and its own embedded relay
port (`8788 + n` for a numeric id):

**Host** — bridge ON, because the embedded relay *is* the door being dialled.
Lands on relay port 8789:

```bash
TASKWRAITH_INSTANCE_ID=1 npx electron .
```

**Collaborator** — bridge OFF is correct here; the collaborator client only ever
dials outward and never needs a relay of its own:

```bash
TASKWRAITH_INSTANCE_ID=2 IOS_REMOTE_TRUE=0 npx electron .
```

Instance 1 hosts, instance 2 joins.

**Which button you get depends on what the relay can advertise.** Verified on a
networked Mac 2026-07-27, instance 1 came up as:

```
[remote-bridge] embedded relay listening on :8789 — advertising ws://192.168.0.147:8789 → ws://100.99.131.73:8789 (lan+tailscale)
```

Both of those classify as **LAN** (`classifyRelayUrl` only calls a `ws://`
tailnet IP "remote" if it is `wss:` or a `.ts.net` name), so the guard that
fires is the LAN one and the button reads **"Copy LAN-only invite"**. That is
fine — a LAN door resolves to this same machine, so instance 2 reaches it.

**"Copy same-Mac invite"** is the fallback for when the relay has nothing but a
loopback door: an offline machine, or one where the LAN/tailnet doors fail
`selectAdvertisableRelayUrls`' reachability probe and get dropped from the
invite. Both hatches only appear once their guard has fired, so neither can be
mistaken for a real remote invite.

Getting the invite between instances: they share one clipboard, so copy on
instance 1 and paste into instance 2's join modal directly.

## 3. Collaborator setup

Nothing. Genuinely nothing — no bridge, no tunnel, no tailnet, no pairing. The
collaborator client only dials outward, and its socket factory is wired
unconditionally. They need the app, the invite text, and to be on a phone call
with you for the code compare.

Sidebar → **"Join Shared Chat"** → paste the invite.

---

## 4. Preflight checklist

Run through this before the other person is on the call:

- [ ] Host: remote access on, bridge running (no error under Devices)
- [ ] Host: tunnel process alive, its URL loads in a browser
- [ ] Host: "Extra advertised relay door" saved (blur the field — it saves on blur, not on keypress)
- [ ] Host: invite copies without the no-relay warning
- [ ] Host: Settings → Shares shows the share with "Invite issued"
- [ ] Host: **Activity log** expanded (Settings → Shares, bottom) — this is your live diagnostic
- [ ] Both: a voice channel for the 6-digit compare
- [ ] Collaborator: app open on the Join modal

---

## 5. The run

| Step | Do | Expect | Activity-log line |
|---|---|---|---|
| 1 | Collaborator pastes invite, clicks join | 6-digit code appears on **both** screens — collaborator in the join modal, host in a banner | `admission.began` |
| 2 | Compare codes aloud | Digits match | — |
| 3 | **Collaborator** clicks "codes match" | Collaborator lands in the read-only projection | `admission.sas_confirmed`, `invite.consumed` |
| 4 | Host sends a message in the chat | Collaborator sees it appear | — |
| 5 | Collaborator posts a comment | Host sees it badged **External** | `contribution.received` |
| 6 | Host switches preset to "Request host action" | Collaborator's composer offers the action-request intent | `share.rules_changed` |
| 7 | Collaborator sends an action request | Host sees an "Action request" badge + "Insert as draft" | `contribution.received` |
| 8 | Host clicks "Insert as draft" | Text lands in the host composer, wrapped with provenance, **not sent** | `draft.inserted` |
| 9 | Collaborator spams 5 comments fast | Some are dropped | `contribution.rejected` / `rate limit — too many, too fast` |
| 10 | Host restarts the app | Collaborator reconnects without a new invite | `admission.began` (reconnect — info notice, no code) |
| 11 | Host clicks "Stop sharing" | Collaborator loses access immediately | `share.revoked` |

Step 9 is worth doing deliberately: it's the fastest way to prove the Activity
log is telling you the truth about drops.

---

## 6. Known sharp edges

- **Quick-tunnel URLs rotate.** Restart the tunnel and every already-issued
  invite points at a dead door. Create a fresh invite after any tunnel restart.
- **Doors are frozen at invite-creation time.** Changing the advertised door
  later does not update an outstanding invite.
- **2 active collaborators per share** (`MAX_ACTIVE_COLLABORATORS`). The third
  is refused.
- **The projection is text only** — no media, no run ids, no metadata, secrets
  redacted, host paths collapsed. If a collaborator says "I can't see the
  image", that's the design, not a bug.
- **Projection is trimmed to ~600 KB** (oldest rows dropped) to stay under the
  relay's 1 MiB frame cap. A very long chat will show a truncated head.
- **The strongest preset is Auto-draft.** It pre-fills *your* composer; you
  still press send. `directLimited` (collaborator prompts the agent directly) is
  deliberately unsettable pending its own security review — if you find yourself
  wanting it during the test, write that down rather than reaching for it.
- **The collaborator is the one who confirms, not you.** Your banner shows the
  code and offers only **Reject**. Don't sit waiting for a Confirm button that
  isn't there — read your code aloud and let them press match.
- **Reject is blunt: it stops the entire share**, not just that one join attempt
  (see `hostAdmissionRejectAriaLabel` — "…and stop sharing"). Correct for a
  genuine mismatch, heavy-handed for a misheard digit. Worth noting how it feels
  in practice; a per-attempt refusal may be the right follow-up.
- **Two simultaneous joins** each get their own SAS banner keyed by handshake
  id, auto-expiring after 120s. A reconnect renders as an info notice with no
  code and no Reject — if you see a code, it's a fresh admission.

## 7. If the join fails

The collaborator's error now names **every** relay door that was tried and why
each one failed, e.g.:

```
Could not reach any of the 2 collaboration relay URLs in this invite.
  • wss://random.trycloudflare.com — Collaboration connect timed out.
  • ws://192.168.1.20:8787 — connect ECONNREFUSED
```

Read it literally — it tells you whether the tunnel is down (timeout/ENOTFOUND
on the wss door) or whether the invite simply never carried a public door (only
LAN/loopback URLs listed). Each door gets a 10s connect timeout, so a two-door
invite fails in ~20s rather than hanging.

---

## 8. What to record

The point of tomorrow is to find UX gaps, so capture:
- every place you had to *guess* what to do next
- every error message that didn't tell you the next action
- anything you had to check the code (or this file) to understand
- how long the whole thing took from "send invite" to "collaborator sees the chat"
