# Shot list — remaining captures

Inventory reconciled 2026-09-03 (second pass): **68 of 90 captured; 22 pending**.

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

**One PNG is retained on disk without a referencing page** —
`footer-control-row__shares-popover.png`, from a shot retired 2026-08-12. The
other former orphan, `composer__ensemble-mode-picker.png`, is now a live embed:
the 2026-09-03 recapture replaced the retired Turn/Continuous picker with the
Ensemble Orchestration Row the page actually documents. So "every PNG is
referenced" is still not an invariant here; "every page is accounted for" is.

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

These pages **do** have an image, so they are not part of the 22 pending and
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

## Capture-rig constraints found 2026-09-03

- **Canvas surfaces do not composite into the parent screenshot.** Each Canvas
  (emulator, browser, mesh viewport) is its own Electron page target, so
  `Page.captureScreenshot` against the renderer returns the dock chrome with a
  blank content area. Two consequences: a CDP driver must select the renderer
  target explicitly, because the *first* page target is whichever Canvas is open;
  and any shot needing dock chrome **and** live surface content in one frame has
  to be taken at OS level, not over CDP. **`fromSurface: true` does not fix
  this** — it was tried against a Canvas Browser with `example.com` genuinely
  loaded (the tab and address bar both render the URL) and the content area still
  came back blank, at native size and under a device-metrics override alike. Do
  not spend time re-testing it. `emulator-canvas` was therefore captured from the
  Canvas target directly and its caption no longer claims dock chrome, and
  `canvas-browser` shows the address bar with an empty browser — which is also
  the safest frame under the privacy rule.
- `canvas-multiview-pane` is blocked by the same boundary: a Canvas surface
  placed in a Multiview pane is still its own page target, so the pane renders
  with empty content in any CDP capture. It needs an OS-level screenshot.
- **Capture Canvas docks at 1700px window width or wider.** At 1397px the dock is
  376px and the Mesh Canvas import row overruns it by 43px, collapsing the
  description to one word per line and clipping a button. At 1700px the dock is
  679px and the row fits.

## Needs investigation before recapture

- `chats-and-threads__in-chat-search` — a 2026-07-09 capture attempt crashed the transcript with `Maximum update depth exceeded` after typing a query. This has not been reverified; test it in an isolated dev profile before taking the shot.

## Needs privacy-safe setup

- `settings-and-configuration__devices-tab` — **blocked two ways.** The verify
  recipe launches with `IOS_REMOTE_TRUE=0`, which forces the iOS bridge off, so
  no QR renders at all — the tab says so in place of the code. Enabling the
  bridge to produce one is exactly what the verify skill warns against, and a
  live QR is non-publishable regardless. The tab also shows the machine hostname
  and a Tailscale node identifier; both need redacting before any frame of this
  page is published.
- `settings-and-configuration__local-model-tool-surface` — **not reachable from a
  bare verify instance.** Ollama is running locally (its API answers on 11434),
  but Provider Tools lists the `TaskWraith-local` gateway as **unavailable** and
  Refresh does not change it. The page's own hint explains why: Ollama tools
  require a workspace thread so paths can be scoped by TaskWraith — but that was
  tested and did **not** resolve it: from a thread bound to `Test 1/master` the
  gateway still reports unavailable, and its settings block offers no connect or
  retry action. Something beyond the workspace binding is needed. Show the gateway profile — the direct
  tool list plus capability search/invoke — without exposing local endpoints or
  paths, and do not caption a tool count; the profile version changes and a
  pinned number rots silently.

## Needs live or transient desktop state

- `sidebar-navigation__project-references-studio` — needs a Project with at least one reference marked **Use next** and a generated draft on screen.
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

- `canvas-and-previews__canvas-multiview-pane`
- `media-audio-and-video__chat-media-dock`
- `media-audio-and-video__inline-transcript-media`
- `media-audio-and-video__multiview-media-pane`
- `media-audio-and-video__waveform-audio-player`

## Needs iOS paired content

- `canvas-and-previews__ios-canvas-preview` — the offline demo dataset has no Canvas sample.
- `media-audio-and-video__ios-media-playback` — the offline demo dataset has no media sample.

## Needs clean-profile or update state

- `getting-started__first-run-ensemble-task` — the Welcome sheet's **Try this first** card; use a scratch workspace and keep private paths out of frame.
- `getting-started__sidebar-onboarding-hint`
- `sidebar-navigation__update-pill`
