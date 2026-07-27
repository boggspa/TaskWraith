# TaskWraith iOS App Store Notes

## Privacy posture

TaskWraith Companion is a paired remote shell for a user-controlled Mac. Task
content, prompts, approvals, transcript projections, and actions are encrypted
end to end after pairing between the iOS device and the Mac. The developer
does not operate a plaintext task-content backend in the current architecture.
Live Activity attributes/content state are the explicit exception because
ActivityKit must decode them; the strict non-sensitive allowlist is documented
below.

The encrypted Mac-to-phone projection can include provider readiness labels,
workspace counts and capability flags, setup-command labels, usage/quota
windows, welcome-dashboard statistics, workflow/chat/board summaries, run and
provider status, aggregate file-change/diff counts, and local UI preferences.
These are shown to orient the user on the companion; they are not sent to a
TaskWraith plaintext backend.

Metadata is not the same as task content. The relay forwards encrypted frames
but can observe transport metadata such as the session identifier, endpoint
role, source IP, timing, and frame sizes. For an ordinary alert/wake push, APNs
receives a device token and a routing/status payload that can include opaque
pair, workspace, thread, run, tool-call, approval, question, wakeup, task, or
projection identifiers; a coarse reason or failure class; timestamps; and
aggregate diff-addition/deletion counts. An optional richer notification blob
is encrypted per device before it reaches APNs. Readable alert payloads must not
include prompts, commands, diff contents or hunks, file paths, filenames,
workspace names, model output, or user messages.

Live Activity pushes are different: their attributes and content state cannot
be end-to-end encrypted because ActivityKit decodes them. Apple receives only a
coarse phase and Unix start time; file, addition, and deletion counts; provider
product names and at most eight provider/phase seat states; the selected
compiled layout and colour values; and an opaque per-activity reference that is
not a thread or run id. This state contains no prompt, response, summary,
message, title, filename, path, branch, repository/workspace name,
account/user/install identifier, or other privacy-sensitive value. Nothing
privacy-sensitive may ever be seeded into these values. Any field expansion
requires a fresh privacy, security, and App Store disclosure review.

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
current committed default is user/Mac-owned environment configuration
(`TASKWRAITH_APNS_KEY_PATH`, `TASKWRAITH_APNS_KEY_ID`,
`TASKWRAITH_APNS_TEAM_ID`, `TASKWRAITH_APNS_BUNDLE_ID`). Desktop APNs credential
UI may be enabled in local/test builds, but should be treated as build-gated
unless the shipping app exposes it. Without credentials, the Mac uses a no-op
pusher: pairing and manual reconnect work, but **no notifications are
delivered**. If a project-operated APNs gateway is enabled for a distribution,
App Store answers and privacy copy must disclose APNs device tokens and routing
triggers handled by that gateway.

Ordinary alert/wake APNs payloads carry routing/status metadata only: opaque
pair, workspace, thread, run, tool-call, approval, question, wakeup, task, and
projection identifiers; a coarse reason or failure class; timestamps; and
aggregate added or deleted line counts that a completion alert may display.
They never include prompts, commands, diff contents or hunks, file paths,
filenames, workspace names, model output, or user messages; optional richer
content is encrypted per device before delivery. The separately disclosed Live
Activity allowlist above is readable by ActivityKit.

Live Activities are enabled by default on supported paired devices, with an
in-app Mac switch and the iOS system switch available to turn them off.
Per-activity and push-to-start tokens are held only in Mac process memory. APNs
delivery retains the sandbox/production environment reported for each device;
stored device tokens are removed only after Apple's authoritative
`410 Unregistered` response.

App Store Connect: declare push notifications and review the privacy answers
against the actual distribution architecture. The minimum technical inventory
is the APNs device token, ordinary routing/status metadata, and the Live
Activity allowlist above, all used for app functionality—not analytics,
advertising, profiling, or tracking. Do not assume “Data Not Collected” merely
because there is no plaintext TaskWraith backend; document how each field,
Apple service, and any project-operated gateway fits Apple's current
“collected” definition and retention test. Apple's
[App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
and
[ActivityKit push documentation](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)
are the operator references. For a consumer launch, do **not** feature push as a
hero capability unless the Mac or distribution ships with push pre-configured;
present it as optional/advanced.

## Export compliance

The companion implements app-level E2EE using CryptoKit primitives
AES-256-GCM, HKDF, and Curve25519. The project sets
`ITSAppUsesNonExemptEncryption=false`: these are standard algorithms that
qualify for the export-compliance exemption (decision recorded 2026-06-16).
Still complete the App Store Connect export-compliance questionnaire for each
build and record the classification in the release notes.
