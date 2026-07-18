# Shot list — remaining captures

Inventory after the 2026-07-18 latest-source capture pass: **63 of 85 captured; 22 pending**. The count comes from 63 top-level PNGs in this folder plus 22 guide pages marked `screenshot-pending`. Two bonus composer variations in `composer-variations/` are not part of the 85-shot baseline.

Capture replacements are being made against latest-source development apps. Use only the authorized `Test 1` through `Test 4` workspaces for live state, keep full private paths and unrelated content out of frame, and treat pairing QR codes and secrets as non-publishable. Personal agent/task metrics, usage telemetry, and demo transcripts are acceptable.

## Needs investigation before recapture

- `chats-and-threads__in-chat-search` — a 2026-07-09 capture attempt crashed the transcript with `Maximum update depth exceeded` after typing a query. This has not been reverified; test it in an isolated dev profile before taking the shot.

## Needs privacy-safe setup

- `settings-and-configuration__devices-tab` — use a demo or redacted pairing state; never publish a live QR code or device credential.
- `settings-and-configuration__local-model-tool-surface` — show the current Ollama gateway profile (39 direct tools plus capability search/invoke) without exposing local endpoints or paths.

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

- `canvas-and-previews__canvas-multiview-pane`
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
