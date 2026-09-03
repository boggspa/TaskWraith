# Shot list — remaining captures

Inventory reconciled 2026-09-03 (second pass): **61 of 90 captured; 29 pending**.

The first pass reported 61 captured / 28 pending over an 89-page baseline. That
set did not reconcile against the tree: the baseline missed a page entirely, two
pages were outstanding yet invisible to the pending count because they carried no
`screenshot-pending` marker, and two PNGs on disk are referenced by no page. The
page-level accounting is now correct — every one of the 90 feature guide pages is
covered by exactly one of an embedded image or a marker, and SHOTLIST carries one
row per page.

Changes in this pass (bookkeeping only — no page or capture was deleted):

- `composer/ensemble-mode-picker.md` **marked pending**. The page was rewritten as
  the Ensemble Orchestration Row and now states there is no Turn/Continuous
  choice. Its capture shows exactly that retired picker and had been unlinked
  from the page without being re-marked, so the page counted as neither captured
  nor pending. The SHOTLIST caption is corrected from "Turn / Continuous options";
  the superseded PNG is **kept on disk** pending its replacement.
- `canvas-and-previews/emulator-canvas.md` **marked pending** and added to
  SHOTLIST — it had never been entered in the manifest at all, which is why the
  baseline read 89 rather than 90.
- The stale-capture section below is expanded from one entry to six, graded by
  how strong the evidence is.

**Two PNGs are retained on disk without a referencing page** —
`composer__ensemble-mode-picker.png` (superseded by the Orchestration Row
rewrite) and `footer-control-row__shares-popover.png` (from a shot retired
2026-08-12). They are deliberately kept, so "every PNG is referenced" is not an
invariant here; "every page is accounted for" is.

Two bonus composer variations in `composer-variations/` are not part of the
90-shot baseline.

The 2026-09-03 recaptures were taken from an isolated verify instance at
viewport 1500x980 (sidebar) / 1760x1100 (composer), `deviceScaleFactor: 2`,
**agent-aura intensity subtle** and the **`interface-claude` composer shell**.
Match those when replacing further shots: the `interface-chatgpt` shell clamps
the model label to 39px of the 67px it needs, so "Claude Opus" renders "Op…" at
every window width, and the cinematic aura washes the sidebar in bright cyan.

Capture replacements are being made against latest-source development apps. Use only the authorized `Test 1` through `Test 4` workspaces for live state, keep full private paths and unrelated content out of frame, and treat pairing QR codes and secrets as non-publishable. Personal agent/task metrics, usage telemetry, and demo transcripts are acceptable.

## Captured but stale — recapture without changing the pending count

These pages **do** have an image, so they are not part of the 29 pending and
must not be added to it — the pending set is defined as pages carrying a
`screenshot-pending` marker, and it has to keep matching that marker set
exactly. They are listed here because the capture on disk shows retired UI,
which is worse than an honest gap: the page reads as done.

Apart from the four taken on 2026-09-03, every capture dates from either
2026-07-09 or 2026-07-18, so 57 of the 61 are at least seven weeks behind the
renderer. The entries below are the ones with an identified invalidating commit;
absence from this list is not evidence a capture is current.

**Recaptured 2026-09-03** — `chats-and-threads__chat-types` (now shows
**Channels**, verified: zero `Shared` occurrences in the live sidebar),
`getting-started__welcome-screen` (heading-only hero, confirming `262c5668d`),
`composer__provider-model-permissions-pickers` (all four chips render in full),
and a first capture for `transcript-and-search__copy-transcript-button`.

**Still suspected stale from the commit record** — the change is named in a
commit that postdates the capture, but the exact framing has not been re-checked
against a live window. Verify at recapture rather than trusting either state:

- `getting-started__first-launch-sheet` — captured 2026-07-18. `378984605`
  (2026-08-30) replaced the historical Gemini card in First Launch with a themed
  Muse card. Note that other Gemini copy legitimately survives in the sheet for
  historical reporting, so only the card itself should have changed.
- `transcript-and-search__transcript-message-stream` — captured 2026-07-09,
  before `bf27ead64` (expanded-card redesign: bare row, rim on card) and
  `c5dcb4f6e` (animated code-block rim removed).
- `approvals-and-permissions__approval-ledger` — captured 2026-07-09, before
  `0cec6f8ee` (2026-08-31) relabelled run-scoped grants. Confirm whether the
  changed labels actually surface in the Ledger panel before recapturing.

## Needs investigation before recapture

- `chats-and-threads__in-chat-search` — a 2026-07-09 capture attempt crashed the transcript with `Maximum update depth exceeded` after typing a query. This has not been reverified; test it in an isolated dev profile before taking the shot.

## Needs privacy-safe setup

- `settings-and-configuration__devices-tab` — use a demo or redacted pairing state; never publish a live QR code or device credential.
- `settings-and-configuration__local-model-tool-surface` — show the current Ollama gateway profile — the direct tool list plus capability search/invoke — without exposing local endpoints or paths. Do not caption a tool count; the profile version changes and a pinned number rots silently.
- `settings-and-configuration__channels-tab` — the page was rewritten for the Channels cutover and the stale pre-cutover Shares capture has been removed. Capture **Settings → Integrations → Channels** with a demo or redacted membership state; never publish a live invite code or member credential.

## Needs live or transient desktop state

- `composer__ultratask` — needs a model whose catalogue entry supports UltraTask, with the reasoning ladder open and the top stop selected.
- `sidebar-navigation__project-references-studio` — needs a Project with at least one reference marked **Use next** and a generated draft on screen.
- `composer__ensemble-mode-picker` — needs an Ensemble chat, showing the Fan-Out, Isolate and Turns controls on the second Roster Presets row.
- `approvals-and-permissions__pending-approval-modal`
- `chats-and-threads__sub-thread-delegation`
- `goals-todos-and-scheduling__todos`
- `notifications-and-status__provider-health-chips`
- `notifications-and-status__sub-thread-status-ticker` — **cannot be captured as
  described.** The strip was deleted outright on 2026-08-19 (`e48d38e33`):
  component, both mounts, CSS and tests, leaving only a comment in
  `ChatViewPane.tsx`. The page is retained by decision, so its shot needs a
  direction — either the page is rewritten around where sub-thread status lives
  now (transcript fleet cards and sub-thread chips, per the removal commit) and
  captured there, or the marker stays permanently unfillable.
- `transcript-and-search__agent-question-cards`
- `transcript-and-search__proposed-plan-cards`
- `transcript-and-search__queued-messages-row`

## Needs Canvas or media content

- `canvas-and-previews__canvas-browser` — keep private paths, vault URLs, and signed-in site content out of frame.
- `canvas-and-previews__canvas-multiview-pane`
- `canvas-and-previews__emulator-canvas` — source-ahead fixed demo; open it from the right
  Inspector's Canvas menu. Keep local source paths out of frame.
- `canvas-and-previews__mesh-canvas` — capture a redacted exported scene; do not show local source paths or vault URLs.
- `media-audio-and-video__chat-media-dock`
- `media-audio-and-video__inline-transcript-media`
- `media-audio-and-video__multiview-media-pane`
- `media-audio-and-video__waveform-audio-player`

## Needs iOS paired content

- `canvas-and-previews__ios-canvas-preview` — the offline demo dataset has no Canvas sample.
- `media-audio-and-video__ios-media-playback` — the offline demo dataset has no media sample.

## Needs clean-profile or update state

- `getting-started__external-provider-thread-import`
- `getting-started__first-run-ensemble-task` — the Welcome sheet's **Try this first** card; use a scratch workspace and keep private paths out of frame.
- `getting-started__sidebar-onboarding-hint`
- `sidebar-navigation__update-pill`
