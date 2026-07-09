# Shot list — remaining captures

Captured by Claude (computer-use + iOS Simulator): **59 of 83**. `settings-and-configuration__devices-tab` was **deleted on purpose** — it exposed a real pairing QR code + device data; capture that one by hand with a demo/blurred QR. The `footer-control-row__devices-popover` shot is fine — no QR, just device names. All saved as PNG in this folder with the exact `SHOTLIST.md` filenames, light theme where the surface is light, native resolution (Electron 4K‑at‑1×; iOS iPhone 17 Pro @3×), tight‑cropped per feature. Two bonus **composer variations** (not in the shot list) live in `composer-variations/`.

**Visual-QA pass (2026-07-09):** every embedded shot was checked by a two-stage agent workflow (sonnet judge → opus re-verify: *does the image actually depict the feature its page documents?*). 52/60 passed first time. Of the 8 flagged: **5 re-captured & corrected** (`file-changes-row` was the git-branch pill → now the File-changes card; `fan-out` was a clipped one-liner → now the Off/Read/Write/All menu; `plus-tools-menu` showed only the Add section → now all three sections; `create-ensemble-chat` showed an active ensemble → now the "New Ensemble chat" draft with the toggle highlighted; `permission-elevation-sheet` was the posture *picker* → now the live Trusted-Session confirmation sheet — **and the page itself was realigned**: it had documented the designed `ApprovalModeElevationSheet` ("Enable Full Access" + disposable-device checkbox), which is only wired into the plan-import flow, not the composer picker; in the live app the picker's only elevation confirmation is the Trusted-Session sheet, Workspace Write raises silently (flagged as a follow-up task). Stale preset lists ("Full Workspace Access" as a picker preset) were also fixed on the pickers + provider-health pages; the workflows pages' "Full Workspace Access" label is correct for their separate unattended-permissions control.) The other 3: `getting-started__welcome-screen` **reverted to `screenshot-pending`** (new drafts open in ensemble mode; the solo welcome with starter-prompts/heatmaps wasn't cleanly reachable); `settings-and-configuration__shares-tab` **kept** (honest empty state — populating the cards needs a live share, a side-effect on user data); `ensemble-mode__ios-ensemble-ui` **kept** with a corrected caption (shows the ensemble transcript + multi-agent run-details rather than the chip-strip/roster editor — the ideal roster-page shot was blocked by simulator tap-automation flakiness).

**iOS shots** were taken from the app's offline **Demo mode** in the iPhone 17 Pro simulator: `ensemble-mode__ios-ensemble-ui` and `notifications-and-status__push-notifications` are done. (The push shot needed a one-line, **uncommitted-and-reverted** patch to `enterDemoMode` so demo mode would fire the notification-permission prompt — the source tree is clean again.) `ios-canvas-preview` and `ios-media-playback` are **not reachable in Demo mode** — the demo dataset has no canvas or media sample content, so they need a real paired Mac pushing live canvas/media to the phone.

Everything below is **not yet captured** — grouped by *why*. None are code problems; they need runtime state, a device, or (one case) a bug fix.

## ⚠️ Blocked by a bug — needs a fix, not a screenshot
- `chats-and-threads__in-chat-search` — Opening ⌘F in-chat search and typing a query **crashed the transcript surface** with `Maximum update depth exceeded` (React infinite render loop). Reproduced once, recovered via "Reload window". Worth investigating before documenting.

## Need a chat that contains media (audio / video / image attachments)
- `media-audio-and-video__chat-media-dock`
- `media-audio-and-video__inline-transcript-media`
- `media-audio-and-video__waveform-audio-player`
- `media-audio-and-video__multiview-media-pane`
  → Open (or create) a chat with an audio/video/image attachment, then ping me.

## Need live / dynamic run state
- `transcript-and-search__run-cockpit-panel` — needs an active run (or the "Open Run rail" toggle; I couldn't locate it with no run in flight).
- `transcript-and-search__queued-messages-row` — queue a message while a run is in progress.
- `transcript-and-search__diff-hover-preview` — needs the expanded **File changes card** with hoverable per-file rows (the collapsed "N files changed" row above the composer doesn't expand here).
- `goals-todos-and-scheduling__todos` — needs a chat where an agent actually **published a todo checklist** (the Plan popover was empty: "No plan steps published yet").
- `notifications-and-status__provider-health-chips` — only render when a provider is in a warning/degraded state.
- `transcript-and-search__proposed-plan-cards` — needs a Plan-mode reply that is plan-shaped.

## Need a specific action/state I didn't want to trigger on your data
- `chats-and-threads__pinned-messages` — requires **pinning a message** (persists to your chat). Right-click → "Pin message" exists; say the word and I'll pin one, shoot it, and unpin.
- `chats-and-threads__sub-thread-delegation` — needs a sub-thread actually delegated/running.

## Canvas
- `canvas-and-previews__canvas-multiview-pane` — needs a Canvas open inside a split multiview pane. (The `canvas-composer-button` shot IS captured.)

## Small telemetry-icon shot I couldn't positively confirm
- `transcript-and-search__copy-transcript-button` — it's the copy icon in the **workspace** composer's telemetry row (next to the run timecode). I mapped ensemble/screen-watch/goal/schedule/blackboard/plan/multiview/canvas but didn't land a "Copy transcript" tooltip. Point me at it and it's a 30-second grab.

## iOS (companion app / simulator)
- ✅ `ensemble-mode__ios-ensemble-ui` — **captured** (Demo mode, iPhone 17 Pro sim).
- ✅ `notifications-and-status__push-notifications` — **captured** (lock screen, `simctl push`).
- `canvas-and-previews__ios-canvas-preview` — **not in the demo dataset**; needs a real paired Mac with a Canvas open.
- `media-audio-and-video__ios-media-playback` — **not in the demo dataset**; needs a real paired Mac with a media chat.

## Onboarding / first-run states (hard to reach without wiping local state)
- `getting-started__welcome-screen` — the no-chat center stage (greeting + starter prompts + usage dashboard + heatmaps). New drafts open in **ensemble** mode (sticky), so "New Chat" lands on the ensemble draft, not the solo welcome; the ensemble glyph didn't toggle back to solo in testing. Reach it by launching with ensemble mode off, or closing all chats.
- `getting-started__first-launch-sheet` — only on true first launch.
- `sidebar-navigation__update-pill` — only when an update is available/downloading.
- `getting-started__sidebar-onboarding-hint` — only when no workspaces are loaded.

## Dynamic approval / health cards (transient, need to be triggered live)
- `approvals-and-permissions__pending-approval-modal` — appears only while an approval is pending (with countdown).
- `notifications-and-status__participant-health` — inserted for a moment as a round dispatches.
- `notifications-and-status__sub-thread-status-ticker` — only while a sub-thread is running.
- `transcript-and-search__agent-question-cards` — only when a participant asks a question mid-run.
