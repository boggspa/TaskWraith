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

Release/TestFlight builds do not request APNs registration by default. The
current desktop APNs sender is a local-admin/development feature that requires
an Apple APNs auth key for the companion bundle; that is not a reviewable
consumer App Store design. Keep release registration disabled until one of
these is true:

- A developer-controlled push relay owns the APNs key and sends metadata-only
  wake pushes.
- Distribution is explicitly scoped to local-admin/internal builds with
  documented APNs key management outside App Store review.

Debug builds can opt into local APNs registration for development. Release
builds can only opt in by compiling with `TASKWRAITH_ENABLE_APNS_REGISTRATION`
after the release owner accepts the distribution model.

## Export compliance

The companion implements app-level E2EE using CryptoKit primitives
AES-256-GCM, HKDF, and Curve25519. The project sets
`ITSAppUsesNonExemptEncryption=false`: these are standard algorithms that
qualify for the export-compliance exemption (decision recorded 2026-06-16).
Still complete the App Store Connect export-compliance questionnaire for each
build and record the classification in the release notes.
