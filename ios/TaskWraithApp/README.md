# TaskWraith iOS companion

SwiftUI app that pairs with TaskWraith on the Mac over the `taskwraith-e2ee-v1`
relay transport and renders the remote task feed (approvals, questions, running
agents) with action controls. The ordinary task projection and actions are
end-to-end encrypted. Live Activity attributes/content state are the explicit
exception because ActivityKit must decode them; they are confined to the
privacy-safe allowlist documented below.

The app target is a thin wrapper; the substance lives in the `TaskWraithKit`
Swift package next door (the companion itself is feature-rich — pairing,
approvals/questions, global + side chats, ensemble roster, diff/file views,
token streaming, composer shells, first-launch guide, full-screen settings,
offline Demo Mode, workflow pause/resume/run-now controls, inline images, APNs
actions, configurable completion banners, and in-flight Live Activities):

- **`TaskWraithKit`** — the CryptoKit port of `src/shared/e2ee` + the
  `RelayTransportClient` and Codable domain models. Validated byte-for-byte
  against the Node lib by `swift test` (`InteropVectorsTests`) and against a live
  Node relay + Mac runtime by the T4d interop harness.
- **`TaskWraithUI`** — `RemoteSessionModel` (observable) + the SwiftUI views.
  Pure SwiftUI, so `swift build` compile-checks it.

## Build & run

The package itself builds and tests with the Swift toolchain alone:

```sh
cd ios/TaskWraithKit
swift build        # compiles TaskWraithKit + TaskWraithUI + the interop CLI
swift test         # interop vectors + session round-trip
```

To run the actual iOS app you need an Xcode app target. Generate one from the
checked-in spec with [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```sh
brew install xcodegen
cd ios/TaskWraithApp
xcodegen generate
open TaskWraith.xcodeproj   # pick a simulator or your device, Run
```

(Or create a new iOS App target in Xcode by hand, add the local `TaskWraithKit`
package, link the `TaskWraithUI` product, and add `Sources/TaskWraithApp.swift`.)

## Testing on a real iPhone / iPad

The project is wired for device runs — automatic signing, camera +
local-network usage strings, and an ATS exception so dev builds can speak
cleartext `ws://` to a LAN/Tailscale relay. Checklist:

1. **Xcode → Settings → Accounts**: make sure the Apple ID for your developer
   team is signed in, then select that team under Signing & Capabilities. Xcode
   mints the Apple Development certificate + provisioning profile on first run.
2. **Plug in the device** (or use Wi-Fi debugging) and pick it as the run
   destination. First install prompts the device for **Developer Mode**
   (Settings → Privacy & Security → Developer Mode → reboot), and you may need
   to trust the developer profile (Settings → General → VPN & Device
   Management).
3. **Network reachability**: the phone must reach the relay URL baked into the
   pairing QR. Same Wi-Fi as the Mac works (`TASKWRAITH_RELAY_URL` should use
   the Mac's LAN IP, not `localhost`); Tailscale is the nicest option across
   networks. The first connection triggers iOS's local-network permission
   prompt — accept it.
4. Run, tap **Scan QR code**, point it at the ghost QR on the Mac, compare the
   6-digit codes, confirm on the Mac. Done.

> ATS is already scoped to `NSAllowsLocalNetworking` only (no global
> `NSAllowsArbitraryLoads`). LAN relays use cleartext `ws://` on the local
> network; off-LAN/remote use works directly through the Mac's Tailscale
> `100.x` address. Tailscale Serve adds an optional `wss://` TLS/hostname door.

## Pairing locally

1. Start a relay: `cd relay && node --import tsx src/server.ts` (or any host the
   phone can reach — Tailscale works well).
2. Launch TaskWraith on the Mac. The iOS remote bridge is enabled by default:
   `TASKWRAITH_RELAY_URL=ws://<relay-host>:8787 npm run dev`
3. Open **Remote pairing** on the Mac. It shows a QR + a copyable pairing-code
   JSON, and a 6-digit confirm code once the phone connects.
4. In the app, paste the pairing-code JSON and tap **Pair**. Compare the 6-digit
   code, then tap **Pair** on the Mac. The task feed appears.

## TestFlight / App Store archive path

### P0 distribution gate — release-candidate cryptographic review

| DRI         | Target     | Status                                                                        |
| ----------- | ---------- | ----------------------------------------------------------------------------- |
| Chris Izatt | 2026-09-03 | **BLOCKING** — no new external TestFlight or App Store candidate until closed |

The DRI owns scheduling, evidence collection, finding closure, and the final
go/no-go record; the reviewer must be independent of the implementation being
reviewed. The review is against the exact release-candidate commit and exported
artifact. The v0.38 adversarial review remains useful historical evidence, but
it is not blanket approval for later APNs, Live Activity, voice-input, offline
outbox, media-annotation, or git-action deltas.

Closing the gate requires one checked-in release record naming the reviewed
commit and artifact, reviewer, review date, findings, disposition of every
CRITICAL/HIGH finding, accepted residual risk, and confirmation that the local
App Store privacy notes plus export-compliance answers still describe the
artifact that will ship. Feature completion never overrides this gate.

The generated Xcode project has a shared `TaskWraith` scheme and a Release
archive configuration. Use the scripts so versioning, entitlements, and export
options stay reproducible:

```sh
cd ios/TaskWraithApp
./scripts/bump-build.sh              # increments the current build number
TASKWRAITH_APPLE_TEAM_ID=ABCDE12345 \
ASC_API_KEY_ID=ABC123DEFG \
ASC_API_ISSUER_ID=00000000-0000-0000-0000-000000000000 \
ASC_API_KEY_PATH="/absolute/path/to/AuthKey_ABC123DEFG.p8" \
./scripts/archive-testflight.sh
```

The App Store Connect API key variables are passed to Xcode for automatic
provisioning. Set all three together; `ASC_API_KEY_PATH` must name the `.p8`
file on disk.

Before upload:

1. Confirm the **exported IPA** entitlements show `aps-environment = production`
   and `get-task-allow = false` (the script prints these). The archive-stage
   entitlements may read `development` / `get-task-allow = true` under automatic
   signing — that is expected; the export is what ships.
2. Complete the App Store Connect export-compliance questionnaire. This project
   sets `ITSAppUsesNonExemptEncryption=false`: the app's CryptoKit E2EE uses
   standard algorithms that qualify for the export-compliance exemption.
3. Read the local App Store privacy notes and make the App Store privacy answers
   match the selected distribution model.

Archive/export and upload are separate. After verifying the exported IPA, use
Transporter or upload it with the same App Store Connect API credentials:

```sh
xcrun altool --upload-app \
  -f "/absolute/path/to/TaskWraith.ipa" \
  --api-key "$ASC_API_KEY_ID" \
  --api-issuer "$ASC_API_ISSUER_ID" \
  --p8-file-path "$ASC_API_KEY_PATH" \
  --output-format json \
  --show-progress
```

## App Store screenshots (automated)

`scripts/appstore-screenshots.sh` produces the full ASC screenshot set with no
paired Mac and no XCUITest (accessibility snapshot queries time out against
this hierarchy — the harness drives plain `simctl` instead):

```sh
cd ios/TaskWraithApp
scripts/appstore-screenshots.sh                                  # both classes
TW_SCREENSHOT_DEVICES="iPhone 17 Pro Max" scripts/appstore-screenshots.sh
```

What it does per device class (defaults: 6.9" iPhone + 13" iPad): build once,
boot the simulator exclusively, pre-dismiss the first-launch sheet, install,
launch the **Debug-only** demo hooks, poll `simctl io screenshot` until content
renders (splash-sized captures retry; a leg that never renders exits non-zero),
and write `screenshots/<device>/NN-*.png` (gitignored). Knobs:
`TW_SCREENSHOT_DEVICES` (pipe-separated simulator names),
`TW_SCREENSHOT_MAX_WAIT`, `TW_SCREENSHOT_MIN_BYTES`.

The launch hooks (compiled only in Debug, argument-gated, inert otherwise):

- `-tw-demo` — boot straight into offline Demo Mode (the surface App Review
  exercises), no pairing.
- `-tw-demo-thread <id>` — after the demo applies, deep-link a canned thread
  (`demo-1`…`demo-3`) via the notification-tap navigation path.

Keep simulator ad-hoc signing ON for any automation against this app:
`CODE_SIGNING_ALLOWED=NO` strips the keychain-access-groups entitlement, the
identity seed read fails with `-34018`, and the app boots to the
"Device identity unavailable" recovery screen instead of the demo.

## Push notifications (post-pairing opt-in; delivery needs Mac credentials)

Release/TestFlight builds request notification permission **after a successful
pairing**, and register the APNs token to the user's paired Mac. The app works
fine if the user denies (open to reconnect/refresh).

Delivery requires the **Mac** to have APNs credentials configured. The committed
default is environment-backed; if a build enables the desktop Devices/APNs
settings surface, use that instead. Otherwise set these in the Mac's environment
before `npm run dev` / the packaged app launch:

```sh
TASKWRAITH_APNS_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
TASKWRAITH_APNS_KEY_ID=XXXXXXXXXX      # 10-char Key ID
TASKWRAITH_APNS_TEAM_ID=8CZML8FK2D     # 10-char Team ID
TASKWRAITH_APNS_BUNDLE_ID=com.taskwraith.companion
```

Without these the Mac uses a no-op pusher (pairing + manual reconnect still
work; no pushes delivered). APNs device tokens are local routing identifiers
stored by the paired Mac. The relay does not send push. For a consumer App Store
listing, don't market push as a hero feature unless the Mac ships with push
pre-configured — see the local App Store privacy notes in the release packet.

On supported iOS versions, Live Activities are enabled by default for paired
runs. The user can switch them off in the Mac's Notifications settings or in
iOS Settings, and can choose among the compiled solo, diff, attention, and
Ensemble layouts. A connected phone can maintain its card locally; configured
Mac APNs credentials additionally allow updates after the relay connection
drops and push-to-start on iOS 17.2+ after a grace period when the companion was
closed.

Live Activity pushes are not end-to-end encrypted: ActivityKit itself must
decode their attributes and content state. Their exhaustive allowlist is:
coarse phase and Unix start time; file, addition, and deletion counts; provider
product names and at most eight provider/phase seat pairs; layout and colour
values; and an opaque per-activity reference that is not a thread or run id.
They contain no prompt, response, summary, message, title, filename, path,
branch, repository/workspace name, account/user/install identifier, or other
privacy-sensitive value. Nothing privacy-sensitive may ever be seeded into
these values; adding a field requires a fresh privacy, security, and App Store
disclosure review.

Per-activity and push-to-start tokens stay in Mac process memory and are dropped
when the activity/device is forgotten or the process exits. Each paired
device's sandbox/production environment selects its APNs gateway. The Mac
removes a stored device token only after Apple's `410 Unregistered` response;
`BadDeviceToken` is retained because it can mean the wrong environment was
used.

## Security

The E2EE core is security-sensitive. Independent internal fresh-context reviews
of `TaskWraithKit` (and the shared `src/shared/e2ee`) were completed in 2026-06;
CRITICAL/HIGH findings were fixed. External human cryptography review remains a
public-release gate. The prior residual MED for silent identity regeneration is
closed: the Mac refuses unreadable or unprotectable identities, and iOS only
generates a new seed after a positive "not found" Keychain result.
