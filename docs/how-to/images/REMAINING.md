# Shot list — remaining captures

Inventory reconciled 2026-08-16 against the 2026-07-18 latest-source capture pass: **61 of 86 captured; 25 pending**. The folder holds 62 top-level PNGs, one of which is not a current capture: `footer-control-row__shares-popover.png` is an orphan left behind by a shot retired on 2026-08-12. That leaves 61 captures against 86 guide pages — of which one
(`chats-and-threads__chat-types`) is known stale rather than current, so 60 are
trustworthy today. See "Captured but stale" below. Two bonus composer variations in `composer-variations/` are not part of the 86-shot baseline.

Capture replacements are being made against latest-source development apps. Use only the authorized `Test 1` through `Test 4` workspaces for live state, keep full private paths and unrelated content out of frame, and treat pairing QR codes and secrets as non-publishable. Personal agent/task metrics, usage telemetry, and demo transcripts are acceptable.

## Captured but stale — recapture without changing the pending count

These pages **do** have an image, so they are not part of the 25 pending and
must not be added to it — the pending set is defined as pages carrying a
`screenshot-pending` marker, and it has to keep matching that marker set
exactly. They are listed here because the capture on disk shows retired UI,
which is worse than an honest gap: the page reads as done.

- `chats-and-threads__chat-types` — captured 2026-07-18, three weeks before the
  Channels rename (`c3001deac`, 2026-08-11). It still shows a **"Shared"**
  sidebar section; `>Shared<` has zero occurrences in `Sidebar.tsx` today. The
  page's prose and alt text have been corrected to "Channels", so the image is
  now the only thing still asserting the old label.

## Needs investigation before recapture

- `chats-and-threads__in-chat-search` — a 2026-07-09 capture attempt crashed the transcript with `Maximum update depth exceeded` after typing a query. This has not been reverified; test it in an isolated dev profile before taking the shot.

## Needs privacy-safe setup

- `settings-and-configuration__devices-tab` — use a demo or redacted pairing state; never publish a live QR code or device credential.
- `settings-and-configuration__local-model-tool-surface` — show the current Ollama gateway profile (41 direct tools plus capability search/invoke) without exposing local endpoints or paths.
- `settings-and-configuration__channels-tab` — the page was rewritten for the Channels cutover and the stale pre-cutover Shares capture has been removed. Capture **Settings → Integrations → Channels** with a demo or redacted membership state; never publish a live invite code or member credential.

## Needs live or transient desktop state

- `approvals-and-permissions__pending-approval-modal`
- `chats-and-threads__sub-thread-delegation`
- `goals-todos-and-scheduling__todos`
- `notifications-and-status__provider-health-chips`
- `notifications-and-status__sub-thread-status-ticker`
- `transcript-and-search__agent-question-cards`
- `transcript-and-search__copy-transcript-button`
- `transcript-and-search__proposed-plan-cards`
- `transcript-and-search__queued-messages-row`
- `transcript-and-search__run-cockpit-panel`

## Needs Canvas or media content

- `canvas-and-previews__canvas-browser` — added after the capture pass and never registered; keep private paths, vault URLs, and signed-in site content out of frame.
- `canvas-and-previews__canvas-multiview-pane`
- `canvas-and-previews__mesh-canvas` — capture a redacted exported scene; do not show local source paths or vault URLs.
- `media-audio-and-video__chat-media-dock`
- `media-audio-and-video__inline-transcript-media`
- `media-audio-and-video__multiview-media-pane`
- `media-audio-and-video__waveform-audio-player`

## Needs iOS paired content

- `canvas-and-previews__ios-canvas-preview` — the offline demo dataset has no Canvas sample.
- `media-audio-and-video__ios-media-playback` — the offline demo dataset has no media sample.

## Needs clean-profile or update state

- `getting-started__sidebar-onboarding-hint`
- `sidebar-navigation__update-pill`
