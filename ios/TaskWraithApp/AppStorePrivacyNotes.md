# TaskWraith iOS App Store Notes

## Privacy posture

TaskWraith Companion is a paired remote shell for a user-controlled Mac. Task
content, prompts, approvals, transcript projections, and actions are encrypted
end to end after pairing between the iOS device and the Mac. The developer
does not operate a plaintext task-content backend in the current architecture.

Metadata is not the same as task content. The relay and APNs can see routing
metadata such as a pair identifier, coarse reason, thread/run identifiers, and
timestamps. APNs payloads must not include prompts, commands, diffs, file
paths, filenames, workspace names, model output, or user messages.

Selected photos/images are transmitted only when the user attaches them to a
prompt, and they travel over the same paired encrypted channel to the user's
Mac/provider runtime.

## Remote notifications

Release/TestFlight builds request notification permission **after a successful
pairing** (not at cold launch). The user can deny; the app still works without
push (open the app to reconnect / refresh). When granted, the APNs device token
travels over the paired encrypted bridge to the user's own Mac and is stored
there — there is no developer-operated push backend.

**Push delivery depends on the user's Mac having APNs credentials.** The Mac
sends wake pushes only when an Apple APNs auth key (`.p8`) for the companion
bundle is configured via environment (`TASKWRAITH_APNS_KEY_PATH`,
`TASKWRAITH_APNS_KEY_ID`, `TASKWRAITH_APNS_TEAM_ID`, `TASKWRAITH_APNS_BUNDLE_ID`).
Without those, the Mac uses a no-op pusher: pairing and manual reconnect work,
but **no notifications are delivered**. The relay carries pairing/transport only
— it does not send push.

APNs payloads carry routing metadata only (pair identifier, coarse reason,
thread/run identifiers, timestamps) — never prompts, commands, diffs, file
paths, filenames, workspace names, model output, or user messages.

App Store Connect: declare push notifications; the data is the device token +
routing metadata, kept within the user's own device + Mac (no developer
backend). For a consumer launch, do **not** feature push as a hero capability
unless the Mac ships with push pre-configured — present it as optional/advanced.

## Export compliance

The companion implements app-level E2EE using CryptoKit primitives
AES-256-GCM, HKDF, and Curve25519. The project sets
`ITSAppUsesNonExemptEncryption=false`: these are standard algorithms that
qualify for the export-compliance exemption (decision recorded 2026-06-16).
Still complete the App Store Connect export-compliance questionnaire for each
build and record the classification in the release notes.
