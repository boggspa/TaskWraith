# TaskWraith iOS companion

SwiftUI app that pairs with TaskWraith on the Mac over the `taskwraith-e2ee-v1`
relay transport and renders the remote task feed (approvals, questions, running
agents) with action controls — all end-to-end encrypted.

This is the thin UI shell. The substance lives in the `TaskWraithKit` Swift
package next door:

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

> ⚠️ The ATS `NSAllowsArbitraryLoads` exception is for development only —
> switch the relay to `wss://` (TLS) and remove the exception before any
> TestFlight build, alongside the crypto review noted below.

## Pairing locally

1. Start a relay: `cd relay && node --import tsx src/server.ts` (or any host the
   phone can reach — Tailscale works well).
2. Launch TaskWraith on the Mac. The iOS remote bridge is enabled by default:
   `TASKWRAITH_RELAY_URL=ws://<relay-host>:8787 npm run dev`
3. Open **Remote pairing** on the Mac. It shows a QR + a copyable pairing-code
   JSON, and a 6-digit confirm code once the phone connects.
4. In the app, paste the pairing-code JSON and tap **Pair**. Compare the 6-digit
   code, then tap **Pair** on the Mac. The task feed appears.

## Not yet wired (intentional scaffold gaps)

- **Incremental run-event rendering** — the feed renders the projection snapshot;
  live `bridge.runEvent` streaming into a transcript view is a follow-up.

## TestFlight / App Store archive path

The generated Xcode project has a shared `TaskWraith` scheme and a Release
archive configuration. Use the scripts so versioning, entitlements, and export
options stay reproducible:

```sh
cd ios/TaskWraithApp
./scripts/bump-build.sh              # or ./scripts/bump-build.sh 42
TASKWRAITH_APPLE_TEAM_ID=ABCDE12345 ./scripts/archive-testflight.sh
```

Before upload:

1. Confirm the archived entitlement prints `aps-environment = production`.
2. Complete the App Store Connect export-compliance questionnaire. This project
   conservatively sets `ITSAppUsesNonExemptEncryption=true` because the app
   implements app-level E2EE with CryptoKit.
3. Read `AppStorePrivacyNotes.md` and make the App Store privacy answers match
   the selected distribution model.

Remote notifications are intentionally disabled by default in Release builds.
The current Mac-side APNs sender is a local-admin/development feature that
requires an APNs auth key for the companion bundle; that is not suitable for a
consumer TestFlight/App Store review flow. Re-enable Release APNs registration
only after a developer-controlled push service exists, or for an explicitly
internal/local-admin distribution by compiling with
`TASKWRAITH_ENABLE_APNS_REGISTRATION`.

## Security

The E2EE core is security-sensitive. Recommend an independent crypto review of
`TaskWraithKit` (and the shared `src/shared/e2ee`) before a public App Store
submission.
