# TaskWraith iOS App Store Notes

## Privacy posture

TaskWraith Companion is a paired remote shell for a user-controlled Mac. Task
content, prompts, approvals, transcript projections, and actions are encrypted
end to end after pairing between the iOS device and the Mac. The developer
does not operate a plaintext task-content backend in the current architecture.

The encrypted Mac-to-phone projection can include provider readiness labels,
workspace counts and capability flags, setup-command labels, usage/quota
windows, welcome-dashboard statistics, workflow/read-only chat summaries, and
local UI preferences. These are shown to orient the user on the companion; they
are not sent to a TaskWraith plaintext backend.

Metadata is not the same as task content. The relay and APNs can see routing
metadata such as a pair identifier, coarse reason, thread/run identifiers, and
timestamps. APNs payloads must not include prompts, commands, diffs, file
paths, filenames, workspace names, model output, or user messages.

Selected photos/images are transmitted only when the user attaches them to a
prompt, and they travel over the same paired encrypted channel to the user's
Mac. They may then be sent by the Mac to the selected provider runtime/account
as part of the user's prompt.

Offline Demo Mode uses canned local sample data and does not require pairing,
relay transport, APNs registration, or provider accounts.

## Remote notifications

Release/TestFlight builds request notification permission **after a successful
pairing** (not at cold launch). The user can deny; the app still works without
push (open the app to reconnect / refresh). When granted, the APNs device token
travels over the paired encrypted bridge to the user's own Mac and is stored
there as a routing identifier.

**Push delivery depends on APNs credentials for the companion bundle.** The
current default is user/Mac-owned configuration, either from the desktop settings
surface or environment (`TASKWRAITH_APNS_KEY_PATH`, `TASKWRAITH_APNS_KEY_ID`,
`TASKWRAITH_APNS_TEAM_ID`, `TASKWRAITH_APNS_BUNDLE_ID`). Without those, the Mac
uses a no-op pusher: pairing and manual reconnect work, but **no notifications
are delivered**. If a project-operated APNs gateway is enabled for a
distribution, App Store answers and privacy copy must disclose APNs device
tokens and routing triggers handled by that gateway.

APNs payloads carry routing metadata only (pair identifier, coarse reason,
thread/run identifiers, timestamps) — never prompts, commands, diffs, file
paths, filenames, workspace names, model output, or user messages.

App Store Connect: declare push notifications; the data is the device token +
routing metadata. For a consumer launch, do **not** feature push as a hero
capability unless the Mac or distribution ships with push pre-configured —
present it as optional/advanced.

## Export compliance

The companion implements app-level E2EE using CryptoKit primitives
AES-256-GCM, HKDF, and Curve25519. The project sets
`ITSAppUsesNonExemptEncryption=false`: these are standard algorithms that
qualify for the export-compliance exemption (decision recorded 2026-06-16).
Still complete the App Store Connect export-compliance questionnaire for each
build and record the classification in the release notes.
