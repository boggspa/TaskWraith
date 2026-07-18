# TaskWraith Companion — Privacy Policy (DRAFT)

> **DRAFT — engineering content last verified 2026-07-18; owner review still
> required.** Derived from `AppStorePrivacyNotes.md` (the internal privacy
> posture). Review, fill the placeholders, and host at a public URL before App
> Store submission. Keep this file and the hosted copy in sync.

_Effective date: `[USER: date]` · Contact: `[USER: support email]`_

## The short version

TaskWraith Companion is a remote control for the TaskWraith app on **your**
Mac. After you pair the two devices, your task content — prompts, agent
answers, approvals, file names, diffs — is **end-to-end encrypted between
your phone and your Mac**. We do not operate a server that can read it.

## What the app handles, and where it goes

- **Task content (encrypted end-to-end).** Everything you see in the app —
  transcripts, approvals, questions, diffs, usage summaries, workspace
  names — travels encrypted from your Mac to your phone. The relay server
  that routes this traffic sees only ciphertext and delivery metadata; it
  cannot decrypt content.
- **Relay transport metadata.** The relay sees ciphertext plus delivery data
  such as a pairing/session identifier, endpoint role, source IP, timing, and
  frame sizes. It cannot decrypt the task content inside those frames.
- **Push routing and status metadata.** If notifications are enabled, Apple's
  push service (APNs) sees the device token plus a routing payload that can
  include opaque pair, workspace, thread, run, tool-call, approval, question,
  wakeup, task, or projection identifiers; a coarse event reason or failure
  class; timestamps; and aggregate added/deleted line counts that may appear in
  a completion alert. Notification payloads never include prompts, commands,
  diff contents or hunks, file paths, file names, workspace names, model
  output, or your messages. Optional richer notification content is encrypted
  per device before it reaches APNs.
- **Photos and images.** If you attach an image to a prompt, it is sent over
  the same encrypted channel to your own Mac. Your Mac may then include it
  in the prompt it sends to the AI provider you configured there. The app
  only accesses photos you explicitly pick.
- **Push notification token.** If you allow notifications (asked only after
  a successful pairing, never at first launch), your device's APNs token is
  sent over the encrypted channel to your paired Mac and stored there as a
  routing identifier. Deny it and the app still works — open it to refresh.
- **Device identity key.** Pairing creates a cryptographic identity stored
  in your device's Keychain (this-device-only). It never leaves your device
  except as the public half used for pairing.

## What we do NOT do

- No TaskWraith account, no sign-in, no plaintext content backend.
- No tracking, no advertising identifiers, no analytics SDKs, no data sale.
- No access to your camera roll beyond images you pick; the camera is used
  only for scanning the pairing QR code.

## Demo mode

The built-in demo uses canned local sample data. It requires no pairing, no
network, no notifications, and no accounts; nothing leaves your device.

## Data retention and deletion

Task content lives on your devices: your Mac (the source of truth) and your
phone's local caches. Unpairing (or deleting the app) removes the phone's
access; your Mac keeps its own data under your control. Relay servers retain
only transient routing state needed to deliver messages.

## Third parties

- **Apple Push Notification service** — delivers notifications using the
  routing metadata described above.
- **Your AI providers** — configured and operated on your Mac, under the
  provider's own terms; the phone never talks to them directly.
- **Relay host** — routes ciphertext between your devices. `[USER: name the
  operator/host for the shipped default relay, or state that users
  self-host.]`

## Changes

We will update the hosted policy when the app's data handling changes and
note material changes in release notes.
