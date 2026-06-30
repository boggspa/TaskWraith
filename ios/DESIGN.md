# TaskWraith iOS — design direction

> Maintainer-set direction (June 2026). The goal is **remote chat-thread
> management**, not app-wide parity with the desktop.

## North star

Manage TaskWraith chat threads from iPhone/iPad with transcript-flow parity —
the same *reading experience* as the desktop transcript (identity labels, tool
traces, status chrome), skinned in TaskWraith's own theme tokens.

## Reference UX (format, not skin)

- **Codex iOS app** — home IA: device header, Projects (= our workspaces) with
  nested chats, search, prominent New Chat CTA; thread view with collapsed
  "N previous messages ›", file-change cards, monospace inline code.
- **Claude iOS app** — transcript composure: clean prose rows, message action
  affordances, bottom composer with model pill + voice.

We borrow the *formats*; all colors/typography come from `TWTheme`
(Sources/TaskWraithUI/Theme.swift), which mirrors the desktop `theme.css`
tokens (`#141414` bg, `#1c1c20/#24242a/#2e2e36` surfaces, chroma
`#5a8cff/#bf7cff/#41c7e5`, white-alpha text ramp). Dark-first.

## Scope rules

- **iPhone**: workspace and allowed global-thread management — list, read,
  reply, start, stop, approve/answer, inspect usage/readiness, and respond to
  questions without becoming the desktop configuration surface.
- **iPad**: the shell for advanced affordances. NavigationSplitView, richer
  inspector tabs, file/diff review, and larger settings surfaces should breathe
  here before being compressed onto phone.
- **Ensemble + guest parity matters**: panel messages carry the SAME
  participant identity as the desktop transcript tag (`Provider / Role
  (Model)`) via the `speaker` field on thread rows (Mac commit e44f56cd).
- **Providers are not gated per-workspace by default** anymore — the Mac's
  allowlist add-form preselects every provider + both approval modes (one-tap
  grant). The gate still exists for users who want it.

## Current state (1.6.0)

- App icon: current variants are regular, WWDC26, monoline, and glass, backed by
  the checked-in `AppIcon-*` asset sets.
- Pairing: QR/paste pairing, confirm-code verification, persisted paired Mac,
  trusted reconnect, local-network preflight, and Tailscale-oriented off-LAN
  setup. Demo Mode works without a paired Mac and uses local canned data.
- Home: Mac/device header, Workflows section, global/side/guest chat visibility,
  collapsed iPad sidebar headers, usage/readiness surfaces, and a rebuilt
  Pair-with-Mac screen in TaskWraith chrome.
- Thread: speaker-labelled rows, token streaming, inline image attachments,
  "still working" anchor during tool calls, proposal/question/approval cards,
  file editor, Diff Studio, usage tab, notes, side chats, and provider-skinned
  composer shells.
- Settings: full-screen settings for General, Appearance, Approvals, Providers,
  Roster, MCP, Workspaces, pinned messages, Model usage, Local servers, and
  Devices. Provider setup and deep MCP configuration remain Mac-owned.
- First launch: the iOS first-launch sheet orients users around Mac-owned setup,
  provider readiness, workspace capability flags, usage snapshots, composer/theme
  variations, approvals, Ensemble basics, and Mac-only power tools.

## Historical state (v0.3)

- App icon: full appearance set from `design-assets/TaskWraith App Icon/`
  (Default / Dark / TintedLight in `TaskWraithApp/Assets.xcassets`).
- Pairing: ghost QR scan (camera) or paste; confirm-code screen; **persisted
  paired Mac** (`PairedMacRecord` in UserDefaults — public material only;
  the phone's private identity seed stays in Keychain). Launch auto-resumes
  via relay resolve (`resumeIfIdle`); "Reconnect to <Mac>" + "Forget this
  Mac" affordances. The Mac pins this phone's identity, so resume is silent.
- Home: ghost masthead (package resource `ghost-mark.png`), Mac header +
  status dot, approvals/questions, workspaces-as-projects, orphan "Chats",
  New chat sheet with provider accent dots.
- Thread: collapsed-history line, speaker-labelled rows, tool chips,
  attention tinting, run-summary chip, **provider-skinned composer shell**
  (accent pill/border/send + "Ask <Provider> anything…" + model pill) —
  the Swift analog of the desktop's per-provider composer chrome.
- iPad: split view (sidebar list + detail).
- Mac-side invariant worth knowing: chat records carry mixed workspace-id
  conventions (uuid + legacy display-name); `WorkspaceIdentity.ts`
  canonicalizes at every bridge boundary. threadSnapshots ship only for the
  12 most-recent chats (relay frame budget) — older threads show their card;
  on-demand snapshot fetch is the planned follow-up.

## v0.4 additions

- **On-demand thread snapshots**: `threadSnapshotRequest` action (read-only,
  `monitor` capability) → Mac pushes one `threadSnapshot` envelope over
  `bridge.broadcastRemoteProjection`. Phone requests on thread-open and
  re-requests (700 ms debounce) on every `bridge.runEvent` for that thread —
  streaming-adjacent freshness without parsing run events yet.
- Sidebar-parity home rows: provider-colored bullet, status chip,
  sub-threads nested under parents (`parentChatId`, "↳ Sub-thread" chip),
  workspace chat-count badges.
- Composer: approval-mode menu (Default / Plan) folded into a compact pill;
  denied acks surface inline above the composer (note: allowlist entries
  must include 'plan' in allowedApprovalModes or Plan sends are denied).
- Ghost masthead asset = ClearLight variant (visible on dark chrome).

## v0.5 additions

- **Token-level progressive streaming**: the phone accumulates
  `bridge.runEvent` agent-output content deltas into a live assistant
  bubble (`streamingTexts`) that grows per token; the in-flight snapshot
  row for the same runId is hidden while streaming, and the final
  snapshot supersedes the bubble ~1s after exit. Follow-up runs reset
  the bubble at the run boundary.
- **Thinking indicator**: provider-tinted "<Provider> is thinking" +
  pulsing dots while a run is active with no content yet; the static
  run-status chip only renders for terminal states.
- **Ensemble roster strip**: `ensembleState` envelopes decode into
  per-thread roster chips above the composer — provider-tinted, active
  participant highlighted, per-participant status dots.
- **Provider-tinted transcript names**: speaker labels parse their
  provider ("Codex · gpt-5.4", "Kimi / Researcher") and tint with the
  provider accent; solo assistant rows tint via the thread's provider.
- **Welcome starters**: empty threads show the desktop's three starter
  cards (Map project / Plan a change / Make improvement) that prefill
  the composer.

## v0.6 — welcome / compose hero pass

- Compose sheet (solo / ensemble / global) redesigned around a **hero
  card**: mode-accent gradient wash, ghost mark with accent glow, and
  "in <Workspace>" with the workspace name accent-bold (desktop's glowing
  workspace headline). Mode accents: solo = live provider accent,
  ensemble = chroma-2 purple, global = chroma-3 cyan.
- **WORK IN FOLDER chip row** (desktop parity) replaces the boxed menu
  picker; selected chip fills with the mode accent.
- Ensemble **participants preview**: provider chips from the Mac's
  configured-provider catalog (wrapped via FlowChips) instead of a wall
  of explainer text.
- **Starter cards with icon plates** (map / clipboard / wand) + corner
  arrow affordance — shared `starterIcon()` keeps the compose sheet and
  the in-thread welcome card visually identical.
- Prompt field uses the composer-shell chrome and lights its border with
  the mode accent once non-empty; **Start is a full-width accent capsule
  at the bottom** (thumb reach) instead of a gray toolbar corner button.
- In-thread `ThreadWelcomeCard` got the same hero gradient + glow + icon
  starters.

## v0.7 — roster editing + satellite parity

- **Ensemble rosters are phone-editable** at creation: the compose sheet's
  PARTICIPANTS section is a full editor — add (provider menu), remove
  (min 2), per-seat provider + model menus (from the synced catalogs),
  and speaking-order reordering via chevrons. Sent as createThread
  `participants[]`; untouched rosters omit the field so the Mac's
  default roles/instructions apply (Mac commit 715bcb07).
- **Satellite home list** (desktop-sidebar parity): thread rows lost
  their container bubbles — flat rows, hidden separators; only ACTIVE
  threads (running / awaiting approval-question) get a faint provider-
  accent wash + border so live work pops.
- **Welcome screen parity**: compose hero is now the desktop's centered
  satellite headline — "New {Provider} thread for **WS**." / "New
  Ensemble chat in **WS**." with accent-bold workspace over a radial
  ambient wash (no card box), centered WORK IN FOLDER chips, and a
  **workspace activity heatmap** at the bottom (6 four-hour rows × 21
  days, bucketed from synced chat created/updated timestamps — sparse
  but real) with the ghost peeking over it.

## v0.8 — streaming feel + transcript typography

- **TokenRevealText**: ChatGPT-grade token flow. Reveal is decoupled from
  arrival — network chunks land in bursts, so a ~30fps pump advances a
  revealed-length cursor at an adaptive rate (geometric catch-up:
  `max(2, backlog/8)` chars/tick, so it never trails a fast model), and
  the newest ~26 revealed characters render through a 3-band alpha ramp
  (0.30 → 0.55 → 0.78 → solid) — tokens fade in at the tail and solidify
  as they age out. Pure render-layer; transport untouched. Gotcha
  encoded in the component: the pump task captures the view struct by
  value, so the moving target lives in @State (`goal`) — a plain `let`
  goes stale as the stream grows.
- **Avenir Next transcript typography**: `TWFont.transcript()` (Avenir
  Next Regular/Medium/DemiBold/Bold, Dynamic-Type aware via relativeTo)
  on transcript bodies — snapshot rows + the streaming bubble. Labels,
  chips, and chrome stay SF.

## v0.9 — rotating heatmaps, attachments, @-mentions

- **Rotating welcome heatmaps**: the compose sheet cycles three flavors
  every 90s with a crossfade (desktop parity) — WORKSPACE ACTIVITY
  (chroma-1), ALL WORKSPACES (chroma-3), WEEKLY RHYTHM (hour × weekday,
  chroma-2) — with flavor pips and the ghost peeking over the grid.
  Starter prompt cards removed from the compose sheet (the in-thread
  welcome card keeps its starters).
- **Image attachments, phone → Mac**: photo button in the thread
  composer (PhotosPicker, max 15, matching the desktop composer count)
  → downscaled to ≤1280px JPEG with a quality walk-down to ≤330KB each
  → composerPrompt `imageAttachments` (Mac validates the same 15-image
  count with a per-image base64 budget for bridge payload safety). The Mac
  materializes temp files and forwards via AgentRunPayload.imagePaths —
  the SAME lane the desktop composer uses (Mac commit 80603a04). Rows
  surface `imageAttachmentCount` → "N images attached" chip in the
  transcript (full pixel round-trip viewer is the next slice).
- **Ensemble @-mentions**: typing @ in an ensemble composer shows
  provider-tinted suggestion chips from the live roster; insertion uses
  the no-space alias form ("@CodeReviewer") which the Mac's
  EnsembleMentionAlias already resolves (it registers concat variants).
  Transcript previews colorize known participant mentions with the
  participant's provider accent (conservative exact-alias matching).

## v0.10 — transcript fidelity (markdown + tool cards)

- Mac previews are **newline-preserving** (d0aef37e): sanitizePreview
  keeps line structure (spaces/tabs collapse, blank runs cap at one),
  so markdown blocks survive the wire.
- **MarkdownLite** renders transcript bodies: headings, bullet/numbered
  lists, fenced code (mono card, h-scroll), simple `|` tables (compact
  mono grid), blockquotes, paragraphs — inline bold/italic/code/links
  via AttributedString, inline code tinted chroma-3 mono, and
  participant @mentions tinted per provider inside any block.
- **ToolActivityCards** replace the generic "N tools" line: per-call
  rows with category icon (terminal/pencil/doc/magnifier/person.2),
  tool name, touched-file tail (mono, head-truncated), per-edit
  **+N/−M diff chips** (green/red), status dot, and a clipped result
  line — fed by toolSummary.tools (capped 12; "+N more" overflow line).
  Streaming bubble stays plain text; markdown applies when the final
  snapshot row supersedes it.

## v0.11 — iPad first-class pass

- **Sidebar taps fixed**: `List(selection:)` + `.tag` only fires in edit
  mode on `.plain`-style iPadOS lists (broken silently since the
  satellite-rows pass). Regular-width rows are now explicit Buttons that
  set the split-view selection; the selected row carries a stronger
  accent wash + chevron (the satellite rule's "unless selected" arm).
- **Detail column wrapped in NavigationStack** (titles/toolbars render;
  `.id(taskId)` resets per selection); single shared List for both size
  classes. Validated on the iPad Pro 13-inch (M5) simulator.
- iPad remains the designated home for advanced affordances (sub-thread
  tree, side-by-side diff) per the scope rules above.

## v0.12 — inspector + changes row

- **Thread inspector** (`.inspector`, iOS 17): right-hand panel on iPad,
  sheet on iPhone — toolbar `sidebar.right` toggle. Tabs:
  - **Changes**: the run's `diffSummary` projection (now decoded into
    `diffSummaries[threadId]`) — totals header (+N/−M, file count),
    Created/Edited/Deleted chips, per-file mono rows with status dot and
    diff stats, truncation notice pointing at the Mac for full review.
  - **Agents**: sub-threads / side chats / guests delegated from this
    thread (taskCards with `parentChatId == threadId`), relation chips +
    provider accents; tapping selects the child on iPad
    (`model.navigationTarget` → split selection; iPhone push-from-detail
    needs the NavigationStack(path:) refactor — later slice).
- **Above-composer changes row** (Codex-app parity, both devices):
  "N files changed +X −Y · Review ›" capsule above the composer when the
  thread has run changes; tapping opens the inspector's Changes tab.
  Create PR from phone = needs a new bridge action — next-slice list.

## v0.13 — iPad selection, take two (the size-class trap)

- The v0.11 fix branched on `horizontalSizeClass` INSIDE HomeView — but
  NavigationSplitView columns report a COMPACT size class, so the iPad
  sidebar silently ran the iPhone path: `NavigationLink(value:)` with no
  `navigationDestination` in that column ("link cannot be activated").
  HomeView now takes an explicit `explicitSelection` flag from
  ConnectedShell — sidebar rows are selection Buttons by construction,
  never environment-inferred. Rule of thumb encoded here: never derive
  split-vs-stack behavior from the size class once you're INSIDE a
  split view's columns.

## v0.14 — temporal fade tail (streaming polish)

- TokenRevealText's fade bands were POSITIONAL (always the last ~26
  revealed chars) — a network pause froze the tail half-faded
  ("stuck shimmer"). A second `solidified` cursor now trails `revealed`:
  while tokens flow it stays one band-width behind (fade tail bounded);
  when the pump catches up it enters a SETTLE phase (+6 chars/tick) that
  melts the tail to solid ~150ms after flow pauses, and re-opens
  seamlessly when the stream resumes. All inside the existing 30fps
  pump — no SwiftUI animation APIs (concatenated Text runs can't tween
  per-run alpha anyway).

## v0.15 — composer shell three-decker (desktop parity)

- The composer is now ONE bordered container of three stacked rows,
  mirroring the desktop shell: **ChangesAttachedRow** (top corners 16,
  branch icon + "N files changed +X −Y" + Review changes pill → opens
  the inspector), the **Composer body** (corners flatten where rows
  attach — `attachedTop`/`attachedBottom`), and **TelemetryFooterRail**
  (bottom corners 16): one RUN timecode (hh:mm:ss, ticks 1s via
  TimelineView while running, frozen at final duration — deliberately
  no wall-clock twin), workspace name, and "Xk in / Yk out · $cost"
  from the new runSummary telemetry (tokensIn/tokensOut/costText).
- Hairline separators between rows; unified strokeBorder overlay.

## v0.16 — flat provider/model labels + honest nil model

- The composer's provider/model picker lost its capsule container:
  flat text labels (provider dot + accent-tinted name, model in
  textPrimary, muted up/down chevron) — the whole text run is the Menu
  tap target. Desktop composer accessory-row parity.
- The picker no longer force-picks catalog defaults on appear/provider
  change: nil modelId is MEANINGFUL (inherit the chat's model on
  existing threads / provider default on new ones — resolved Mac-side
  per the model-inheritance slice). Force-picking was stamping the
  default over the chat's real model before the snapshot landed.
  Provider switches only clear a model that belongs to the old catalog.

## v0.17 — editable in-thread roster strip (iPad + iPhone)

- The read-only EnsembleRosterStrip is replaced by EditableRosterStrip:
  one horizontally-scrolling chip row (works at iPhone width — wrapping
  rows judged messier), trailing + menu (provider list) to append.
- Chip tap → RosterChipEditor sheet (medium/large detents; popover-class
  UX on iPad): Enabled toggle, Role field, Goal/Brief TextEditor,
  provider + model menus, Earlier/Later movers, destructive Remove
  (guarded: last participant can't be removed).
- Long-press-drag chips to reorder (DropDelegate reorders the draft live
  with animation; commit on drop).
- Every commit ships the FULL roster via the new ensembleRosterUpdate
  action (steer capability). id-matched entries preserve Mac-side
  fields the phone doesn't carry (runtime profile, permissions, linked
  sessions); omission removes; new chips mint from same-provider seeds.
  Draft reconciles from RemoteEnsembleState.roster (configured
  participants, present even when idle) unless mid-edit/drag.
- NOT ported (desktop-only for now): roster presets row ("Save
  current…"), per-chip context-usage badges (tokens not in the
  projection), per-participant reasoning/fast-mode/permission pickers.

## v0.18 — sub-agent identity parity (names, hues, identicon badge)

- Task cards for sub-threads ship agentName/agentAccent/agentSlug — read
  from the PARENT chat's persisted providerMetadata.agentIdentities (the
  desktop's registry), so phone names are byte-identical to the Mac's
  (Hubert Cumberdale stays Hubert Cumberdale; no re-derivation drift).
- AgentIdentityBadge (minimal-parity identicon): accent ring + ghost
  mark tinted with the agent's accent + an orbital satellite dot whose
  angle derives from the SAME FNV-1a hash as the desktop's identicon
  picker (utf16 units, 0x811c9dc5/0x01000193) — echoing the catalog's
  orbital motif without porting 54 hand-drawn SVGs.
- Applied: inspector Agents tab (badge + accent-tinted name + the
  agent's hue outlining its card, desktop-invocation-card style) and
  home-list sub-thread rows (badge replaces the provider dot; agent
  name leads the title).
- Full hand-drawn catalog rendering on iOS = future slice (would need
  the named SVGs converted to bundled assets).

## v0.19 — sidebar tidy + Pins/Notes

- Section headers are FLAT (no capsule container): SF Pro subheadline
  semibold, sentence case, count badge only.
- Parent chats with sub-thread/side-chat children get a leading
  disclosure chevron — collapse the tree to just the parent
  (collapsedParents @State; animated).
- Pinned + Recents sections above the workspace groups (pinned from the
  card's new `pinned` flag; Recents = top 4 parents by updatedAt,
  hidden when trivial).
- Settings cog next to the ⋯ menu → AppSettingsSheet (theme controls
  stubbed for the next pass; mirrors desktop themes where sensible —
  composer theming explicitly deferred).
- Inspector gains a third tab, **Notes**: thread-notes editor (saves via
  setThreadNotes; reconciles from snapshot.notes unless focused) + the
  pinned-message list (snapshot.pinnedRows, unpin per row). Pin FROM
  the transcript: long-press any message → "Pin message"
  (toggleMessagePin). Both actions gated under startTurn.

## v0.20 — themes, the full identicon catalog, date-gated masthead

- **Themes** (Settings → Themes, desktop Appearance parity minus
  composer shells): System Theme (8 dark variants — Dark/Midnight/Blue/
  Purple/Ocean/Forest/Sunset/Obsidian, each a bg+surface tint set),
  Accent Theme (System/Blue/Purple/Pink/Orange/Green/Red/Yellow → drives
  chroma1 everywhere), Tool Call Theme (Match accent / Graphite / Cyan /
  Amber / Violet → ToolActivityCards category color). TWThemeStore
  persists to UserDefaults; TWTheme tokens became @MainActor computed
  statics; RootView keys on store.revision so a change rebuilds the
  tree. Light themes deferred (the app is a dark-surface design).
- **Full identicon catalog on-device**: all 54 named characters baked
  from design-assets SVGs via qlmanage (WebKit renders the CSS-classed
  SVGs perfectly; Xcode's native SVG importer can't) → 512px PNGs in
  the package Resources (~3MB) loaded via Bundle.module.
  AgentIdentityBadge prefers the real character art (accent ring kept);
  the minimal ghost+orbital badge remains the fallback for unknown
  slugs. Re-bake: qlmanage -t -s 512 -o tmp design-assets/
  agent-identicon/named/*.svg → rename identicon-{slug}.png → Resources.
- **Masthead logo**: MastheadLogoView shows ghost-guy-wwdc26 until
  9 Jul 2026 then flips to ghost-guy-sticker automatically (date gate —
  no code change to revert). Loads from Bundle.module Resources (the
  earlier 'didn't render' mystery was assets living in the APP catalog
  while views live in the PACKAGE bundle).

## v0.21 — lifecycle arc (final): drops, quits, graceful status

**Quit-mid-run analysis (verified in code, not just observed):** a
phone-initiated run is fully Mac-owned the moment composerPrompt is
ACCEPTED — dispatchAgentRun runs in Electron main with the DESKTOP
window as the streaming sender, and the bridge accumulator persists
text/tools/diffs main-side on 250ms flushes. The phone is a pure
viewer: killing the app mid-run cannot interrupt the run, lose
transcript content, or skip the runDiff/finalize path. On return, the
trusted reconnect's establish snapshot covers recent threads and the
NEW visibleThreadId re-request covers the open-but-older one. The only
process that can kill a run is the Mac app itself quitting (same as a
desktop-initiated run).

**Shell-preserving reconnect:** transient drops after a successful
session no longer eject the user to the pairing screen. RootView keeps
ConnectedShell mounted whenever wasEverConnected && hasStoredPairing
and overlays a ConnectionBanner — amber "Reconnecting…" with a spinner
during .connecting, red "Connection lost" + Retry on .error (retry =
reconnectIfStale). Fresh pairings still get the full PairingView.
(Swift trap encoded here: `case .a, .b where guard:` binds the where
to the LAST pattern only — both arms need the clause.)

**Post-reconnect sync:** on every establish the model re-requests the
snapshot for `visibleThreadId` (set/cleared by ThreadDetailView) — the
open thread may be outside the establish broadcast's recent-N window.

**Graceful status banners:** raw caption-text errors above the composer
are replaced by StatusBanner — severity-tinted bubbles (red error /
amber warning / blue info / green success) with WHITE text, an icon,
and a dismiss ×. Severity is heuristic (denied/failed/error → red;
timeout/lost/reconnect → amber; saved/pinned/started → green);
twFriendlyMessage rewrites the common raw messages ("Your Mac didn't
respond in time — it may be busy or asleep."). Errors persist until
dismissed; info/success auto-fade after 3.5s.

(Type-checker note: ThreadDetailView's modifier chain needed AnyView
stage-breaks — listCore → navigationChrome → toolbarChrome — once the
lifecycle modifiers landed.)

## v0.22 — boss batch (structure + flow)

- **Views.swift split** (pure moves, no behavior change): AppShell /
  HomeListViews / ThreadDetailViews / EnsembleViews / WelcomeViews /
  ComposerView / ComposeTaskViews / AttentionRows / PairingViews +
  NewChatCanvas. Same module — no visibility changes needed.
- **Inline New Chat canvas**: solo "New chat" no longer opens a sheet —
  it renders IN the main pane (iPad: sentinel selection "new-chat";
  iPhone: navigationDestination push). Welcome hero above, composer
  midway, rotating heatmap below (where the reference app shows starter
  prompts). On send the canvas BECOMES the transcript (claims
  navigationTarget, swaps to ThreadDetailView in place). Ensemble/global
  keep the compose sheet.
- **Heatmap cells are 1:1 squares** — cell size derives from available
  width (4–9pt), grid centers and shrinks instead of stretching.
- **Refresh button** (arrow.clockwise, next to the cog): disconnect +
  trusted-reconnect redial — covers "phone launched before the Mac app"
  without waiting on backoff.
- **Workspace picker in the telemetry rail**: primary workspace is fixed
  (the thread's); the menu grants ONE secondary allowlisted workspace to
  subsequent runs (composerPrompt.extraWorkspaceIds → signed
  ExternalPathGrants, write/thisRun). Rail label reads "Test 3 + AGBench"
  while active. Multi-grant runs render one attached changes row PER
  workspace (WorkspaceChangesAttachedRow, stats from
  diffSummary.workspaces — stats-only on the wire; the nested
  files[].hunks lane is stripped with the rest).

## v0.23 — final polish (jump pill, light themes, roster-in-shell, ensemble media)

- **Jump-to-latest pill**: black circle, white arrow, white rim — and
  CENTERED just above the composer shell (the trailing spot sat on the
  roster's + button). Still appears only after an upward scroll.
- **Light themes**: TWSystemTheme grows Light / Alabaster / Mist
  (isLight). Text tokens (textPrimary→Muted) + border flipped to
  @MainActor computed black-opacity variants on light themes; every
  hardcoded preferredColorScheme(.dark) replaced by .twColorScheme().
  Both light AND dark families now show in Settings → Themes.
- **Sidebar plane**: per-theme sidebarBg (~4% white lift on dark themes,
  ~4% darker on light) applied to the home list.
- **Roster row in the shell** (iPad AND iPhone): EditableRosterStrip
  gained attached/isShellTop modes — it renders INSIDE the composer
  three-decker, always stacked UNDER the changes row(s), chips centered,
  the + at the END of the chip run (not pinned to the screen edge).
  The floating satellite strip is gone.
- **Ensemble Add media**: ensembleSteer carries imageAttachments
  (composerPrompt's shape/caps); the executor materializes temp files
  into startRound imageAttachments {path,name} — the desktop ensemble
  composer's exact lane. The photo button shows for ensembles again.
- (Type-checker: ThreadDetailView is now FOUR AnyView stages — listCore
  → navigationChrome → followChrome → toolbarChrome — plus the shell
  stack extracted to its own builder. xcodebuild's frontend budget is
  stricter than `swift build` debug; split early.)

## v0.24 — rim, run cards, queued chip, canvas accents

- **Composer rim + lifted deck**: ComposerShellGlassModifier paints the
  deck with the new per-theme composerBg (lighter than surface2 on dark
  themes, darker on light — boss's inverse rule) plus a top-lit gradient
  rim (white 0.18→0.02 on dark; black 0.10→0.02 on light). The TextField
  got its own INNER surface2 container (stays as-was) with border.
- **Per-run Task-complete cards** (desktop parity, the boss's "doh"):
  snapshot.runSummaries (oldest→newest, capped 12) lets the phone
  interleave a TaskCompleteCard after EACH run's final transcript row —
  header (Task complete/Run failed + ended time + "Worked for…"),
  Run-details rows (MODEL/STATUS/DURATION/TOKENS/TOTAL/COST), and for
  the LATEST run a File-changes section from the diff projection
  (per-file status dots + +/−, 8-file cap with overflow line). Persists
  per thread for existing chats and phone-initiated runs alike; the old
  RunSummaryChip remains only for runs with no visible rows.
- **Queued/steered visibility**: how it works — phone ensemble sends go
  through ensembleSteer (starts a round when idle, injects steering when
  active); mid-round prompts the orchestrator can't inject yet sit in
  the work-session queue. NEW: the roster row shows an amber
  "N queued" chip (tray icon) from ensembleState.queuedPromptCount, so
  queued prompts are no longer invisible on the phone. Steered text
  appears as normal user rows once injected (Mac writes them to the
  transcript).
- **Canvas accents**: the New-chat hero workspace label, ghost glow, and
  selected workspace chips follow the PROVIDER theme accent via a
  providerEcho binding from the embedded composer — not the user's
  settings accent (boss-spotted chroma1 leak fixed).

## v0.25 — stacked queued prompts (desktop parity)

- RemoteEnsembleState ships queuedPrompts [{index, text<=280}] in the
  COMBINED injection order (legacy slot + array — the order the
  orchestrator drains). One Mac-side queue, any-device origin: items
  queued from the desktop OR from phone steers that fell back to the
  queue all appear, on both surfaces.
- QueuedPromptsStack renders the desktop's stacked rows as a shell deck
  section directly UNDER the changes row(s) and ABOVE the roster row:
  ↪ icon, 2-line text, Steer, trash, … menu. Per-item actions ride
  ensembleQueueItem {index, textPrefix race-guard, steerNow|remove} —
  steerNow pulls the item and starts a steer round exactly like the
  desktop's queued-row Steer.
- The amber "N queued" chip on the roster row remains as the compact
  fallback when texts are absent (older Mac builds).
- Queue items are plain strings — no origin metadata, so no
  "from iPhone" badging without a store change ({text, source}).

## v0.26 — canvas for ALL chat types (compose sheet retired)

- NewChatCanvasView gained a mode (.workspace/.ensemble/.global): one
  welcome surface for every chat type — hero (mode accents: provider /
  chroma2 ensemble / chroma3 global), workspace chips, composer area,
  rotating heatmap below.
  (Superseded post-v0.41: NewChatBootstrapView now creates the empty Mac
  thread first and renders the shared ThreadEmptyWelcomeCanvas — one welcome
  surface for new AND reopened-empty chats; the standalone NewChatCanvasView
  was removed.)
- Ensemble mode embeds a canvas-native CREATION roster editor
  (provider/model menus, up/down/remove/add, speaking-order caption;
  untouched roster sends nil so Mac defaults apply) + prompt field +
  chroma2 Start → startEnsemble; on ack the canvas BECOMES the
  ensemble transcript (same claim mechanism as solo).
- Global mode: Create button (chroma3) → createThread global, then an
  inline "Created on your Mac — managed from the desktop for now"
  state (global chats remain invisible in projections — the standing
  policy gap, honestly surfaced rather than faking a transcript).
- All three New-menu entries route to the canvas: iPad via sentinels
  (new-chat / new-ensemble / new-global[:ws]), iPhone via
  navigationDestination(item: ComposeMode). ComposeTaskViews.swift is
  DELETED — the sheet era is over.

## v0.27 — flow chips + reconnect-rehydrate hardening

- **FlowChips is a true flow now**: TWFlowLayout (custom Layout) — chips
  keep INTRINSIC width with fixed 6pt spacing, rows centered. The old
  adaptive LazyVGrid stretched columns evenly across the row, putting
  weird gaps between the workspace pills on the canvas.
- **Connected-but-empty after Mac restart** (Codex-diagnosed: reconnect
  and rehydrate are separate concerns):
  - Mac: every device establish schedules a throttle-cleared SECOND
    broadcastSnapshot ~1.5s later — the establish-time snapshot can
    fire while store/allowlist state is still settling, and nothing
    else rebroadcasts until a mutation. Logged
    ('post-establish rehydrate snapshot sent') for field diagnosis.
  - iOS: non-destructive empty-state guards — an empty taskCard
    snapshot or empty workspace list arriving while we HOLD state is
    kept-not-wiped (settling Mac >> real revocation; the re-seed
    corrects either way), and the silent try? decode returns now print
    '[tw] DECODE FAILED: …' so contract drift is visible instead of
    masquerading as 'connected, nothing accessible'.

## v0.28 — guests + side-chats tab (boss mini-missions)

- **Guest participants** (solo threads): a + next to the composer's
  provider/model labels opens the provider→model tree; the active guest
  renders as a green-accent chip (identity name when assigned, ×
  removes, tap-to-change). One guest per thread — the desktop's
  set/remove semantics via new setGuestParticipant /
  removeGuestParticipant actions riding chatService (the same code the
  desktop IPC calls). Current-guest state derives from the child card
  with the guestParticipant relation — no new wire state needed.
- **Side chats inspector tab** (4th tab): lists the thread's side chats
  (Guest / Isolated chips, identity badges, status dots, tap-to-open
  via the cross-column nav) + a "New side chat" provider menu →
  createSideChat (ack returns threadId; singleProvider mode default —
  ensembleClone/fanOut modes accepted by the action for later UI).
- All three actions gate under startTurn (thread create/configure write
  class) — default read-write entries cover them.

## v0.29 — input cluster + pill placement

- **Input cluster container**: the media button + text field + send
  button now share ONE dark-gray inner container at 50% opacity
  (surface2 @ 0.5, rounded 12, hairline border) inside the composer
  deck — the field-only box from v0.24 is gone. Attached rows above
  (changes/queue/roster) and the telemetry rail below keep their own
  surfaces, per the spec.
- **Jump-to-latest pill** now overlays the SCROLL REGION (attached
  before the safeAreaInset) instead of the whole stage — it floats
  just above the composer shell rather than sitting on the rail.

## v0.30 — heatmap provider filters + token chips

- **Usage rollup over the bridge**: buildExternalUsageRollup sums the
  cached usage records per provider for the 24h/7d/90d windows — the
  SAME numbers the desktop External Activity header shows.
  bridge.broadcastUsageRollup ships it on establish, post-prewarm, and
  every 2h refresh.
- **RotatingActivityHeatmap** grew the desktop's controls: provider
  filter pills (All + providers present in events/rollup, isolating the
  grid per provider) and right-aligned 24h/7D/90D token chips
  (943M/4.80B-style compact formatting; chips follow the selected
  provider filter; hidden entirely when no rollup — older Macs).
- Desktop heatmap titles: Avenir Next, title case (CSS-only — strings
  were already 'External Activity').

## v0.31 — Usage inspector tab (iOS UX v1 SIGNOFF)

- **Usage tab** (5th inspector tab): MODEL USAGE sidebar parity.
  Per-provider sections (accent glyph tile + provider label) with limit
  rows: label + "resets HH:mm / d MMM" + right-aligned NN%, the
  desktop's exact bar anatomy — 6pt track at textPrimary 8%, fill
  gradient defined in TRACK coordinates (accent 0–60% → amber #F59E0B
  @90% → red #DC2626 @100%) masked to the used fraction — and the
  limitLabel caption ('N% remaining', Kimi 'n / m remaining', Cursor
  'This cycle'). Activity heatmap + rollup chips at the bottom; "as of
  HH:mm" staleness caption.
- **Feed**: bridge.broadcastModelUsage — codex/claude/kimi/cursor quota
  windows, with historical Gemini data preserved where present, via the SAME
  TTL-cached snapshot fetchers the
  desktop IPC uses (90s–2m fresh), shipped on establish + ~6s after
  launch + every 7.5 minutes. A few KB bounded at source (8 windows/
  provider) — no transport chunking needed against the relay's 1MB cap.
  Grok's PTY credits probe deliberately excluded (expensive + gated;
  desktop-only for now).
- Recon for this slice ran as an ultracode workflow (4 parallel
  readers: desktop card anatomy/CSS, data source, bridge pattern,
  phone anchors) — findings anchored the parity contract.

🎉 iOS UX v1 signed off. TestFlight hardening begins (crypto review,
ATS, store assets, broader device QA).

## v0.32 — approval/question parity (Codex-flagged, audit-verified)

**The wire was broken**: iOS sent decision "approve"/"deny" but the Mac
validator's union is accept|acceptForSession|acceptForWorkspace|decline
|cancel — every phone approval tap was rejected as malformed. Question
replies sent questionId; the validator requires promptId — also
rejected. Both fixed; questionReply sends BOTH keys for old-Mac compat.

- **Full card decodes**: MobileApprovalCard gains body/provider/
  requestedAt/expiresAt/actions/workspacePath (the phantom `summary`
  kept as legacy); MobileQuestionCard gains promptId/question/context/
  createdAt/expiresAt/provider with resolvedId/resolvedQuestion legacy
  fallbacks.
- **Electron-parity approval UX**: provider-accented rows with the
  body detail (auto-monospaced for command/JSON-looking text),
  requested-at caption, and the FULL executor decision set — Allow
  once (primary, accent), Allow for session / Allow in workspace
  (menu), Deny, Cancel run (overflow; also kills Kimi children
  Mac-side). Tap → ApprovalDetailSheet: untruncated monospaced body,
  provider chip, all five decisions as full-width buttons.
- **Question UX**: canonical question text + context caption + expiry
  countdown; option chips (flow layout) AND always-available free-text
  (Mac answers are free-text; is_custom always true); Dismiss →
  questionReject (parked tool resolves cancelled).
- **Audit-found dead buttons fixed**: kimi approval cards OMIT
  workspaceId (and threadId is conditional) but the validators require
  both strings + the old guard-lets silently no-opped. replyContext()
  falls back card.workspaceId → owning task card's workspace → first
  allowlisted workspace (router only allowlist-gates it; executor
  never reads threadId post-gate).
- Process note: recon + adversarial contract audit ran as ultracode
  workflows; the audit independently re-derived both contract sides
  from final code and caught the kimi dead-button residual. Known
  Mac-side pre-existing hazard (not ours): an approvalReply whose
  toolCallId collides with a pending questionId routes as a question
  answer (index respondApprovalFn registry-membership routing).
- Scope deliberately NOT ported: external-path grant pickers,
  sub-thread/provider-native routing choices, intent note (the
  message field is validated but never read by the executor).

✅ iOS UX v1 signoff re-confirmed with the approval path actually
working. Sleep earned.

## v0.33 — side-by-side inspector + side-chat mini chat window

- **iPad inspector is a TRUE trailing column now**: `.inspector` was
  attached INSIDE the detail NavigationStack, which presents as an
  overlay; hoisted to the stack level (binding moved to
  model.inspectorPresented so the shell owns presentation) the
  transcript pane RESIZES to accommodate it — the desktop's three-pane
  anatomy. Column widened (320/390/500) for the mini composer. iPhone
  keeps the sheet automatically; canvas-created threads got their own
  wrapper so the toggle works everywhere.
- **Side-chat mini chat window**: tapping a side chat in the Side-chats
  tab now opens an inline MiniThreadView in the column — header (back ·
  identity badge + title · expand-to-main), the recent transcript
  window (last 30 rows, real ThreadRowViews + streaming bubble), and
  the REAL composer shell: the same Composer + hairline +
  TelemetryFooterRail + composerShellGlass as the main pane — identical
  conventions/tokens, slimmed naturally by the column (~2× the iPhone
  composer width on iPad). Sends ride the normal continueTask path.
  Expand hands off to the main pane via the cross-column nav.

## v0.33a — hand-rolled inspector column (field fix)

Field test showed SwiftUI's `.inspector` presents as an OVERLAY on iPad
regardless of attach level (tried inside the stack AND at stack level —
content clipped under the pane both ways). Replaced on iPad with a
hand-rolled HStack third column: ThreadDetailView + fixed-width (390)
ThreadInspector pane with leading rim + slide transition — the
transcript DETERMINISTICALLY resizes. iPhone keeps the `.inspector`
sheet. Canvas-created threads get the same HStack treatment
(size-class-gated). Note for testers: the side-chat mini window only
appears once a thread HAS side chats — tap one in the list (the
screenshot that prompted this was an empty state, working as designed).

## v0.34 — side-chat pane independence

The mini pane's sends were STEALING the main transcript: the generic
ack handler navigates to any threadId the ack carries (the right
behavior for new-chat creation), so a side-chat send claimed
navigationTarget and the shell reloaded the detail pane onto the side
chat. Codex had added a `navigateOnAck` knob on send() but it was
never threaded through — now it is, end to end:
`Composer(navigateOnSend:)` → `continueTask(navigateOnAck:)` →
`send(navigateOnAck:)`. The mini pane passes false; every other
composer keeps the navigate-on-create behavior. Side chat streams in
the inspector column while the parent stays live in the main pane —
both usable simultaneously.

## v0.36 — APNs end-to-end (BD2)

The Mac was ~95% built (HTTP/2 .p8 pusher, token store, build-gated
Devices-tab config panel for local/test builds, idle-gated + 30s-coalesced
attention fanout already firing on approvals/questions). This slice closed the
loop:

- **Mac**: DEFAULT_APNS_BUNDLE_ID fixed to com.taskwraith.companion
  (was com.example.* — APNs rejects mismatched topics); reason union
  gains runComplete/runFailed, fired on the running→success/failed
  transition detected in maybeNotifyRemoteTaskNeedsAttention (same
  idle gate + coalescing). pairID binding was already transport-
  derived (runtime overwrites it pre-route) — recon flag was stale.
- **iOS**: aps-environment entitlement via project.yml (XcodeGen
  regenerated; flips to production at TestFlight signing);
  PushAppDelegate adaptor (token → hex → model); authorization asked
  AFTER first successful session (never cold-launch);
  BridgeAction.registerApnsToken ships the token on establish, with a
  pending slot for tokens that arrive pre-connect; re-registers each
  launch (tokens rotate).
- Flow: attention/run-finish → APNs alert → tap → foreground →
  reconnectIfStale() → resolve → session → rehydrate. Every Mac/relay
  arrow pre-existed; the phone just joined the conversation.

## v0.37 — TestFlight security batch (part 1 of 2)

Codex's read-only security pass found real no-ship issues; fixed so
far (Mac slices committed; ios/ uncommitted as planned):

- **CRITICAL — transcript identity binding**: the v2 handshake
  transcript appends BOTH long-lived identity keys. Identity-splicing
  now changes the user-compared confirm code AND breaks the serverAuth
  signature the phone verifies. Node + Swift + golden vectors updated;
  the LIVE Swift↔Node relay handshake e2e passes. (In-flight pairings
  break by design — re-pair once after both ends update.)
- **ATS**: NSAllowsArbitraryLoads REMOVED → scoped
  NSAllowsLocalNetworking (LAN-relay dev). Remote use = wss:// (e.g.
  `tailscale cert` for a Tailnet relay).
- **Privacy manifest**: PrivacyInfo.xcprivacy (UserDefaults / CA92.1)
  in the app target.
- **App icon**: primary 1024 flattened (alpha = validation failure).
  Dark/Tinted variants KEEP alpha — Apple requires transparency for
  appearance-aware variants; review the white-composited primary edge
  pixels visually.
- **Capability migration**: legacy allowlist grants no longer inherit
  the file-editing trio; upsert materializes explicit capabilities.

Part 2 (landed once the Diff Studio agent cleared the bridge files):

- **Ownership validation** wired into BOTH production routers (the
  seam's missing-validator fallback was allow): threads must belong to
  the presented workspace, runs to the thread, questions to the thread.
- **Replay/expiry required**: mutating actions are denied without
  actionId + expiresAt; the phone stamps issuedAt/expiresAt (+120s) in
  the single shared encode() helper so no action helper can ship
  unguarded. Fake-iphone harness mirrors it.
- **Authenticated pairID**: the router stamps the transport-derived
  pairID over every decoded action (the inner payload's pairID was
  client-controlled — registerApnsToken now binds to the real
  identity).
- **Phone hygiene**: privacy shield over the app-switcher snapshot
  (scenePhase != active → opaque ghost overlay), forget-this-Mac now
  scrubs snapshots/streaming buffers/usage panels/APNs token, and the
  two URL force-unwraps in RelayTransportClient throw
  TransportError.invalidRelayUrl instead.

All nine findings closed. Remaining for TestFlight: archive
validation + the independent crypto review (dossier ready), visual
check of the flattened primary icon, on-device APNs field test.

## v0.35 — Diff Studio

The desktop Diff Studio, phone-sized. Same layout-swap architecture as
Files mode — a `plus.forwardslash.minus` toolbar button (next to
Files/Inspector, shown when the workspace grants `diffReview`) flips
the iPad shell into a NavigationSplitView and full-screen-covers on
iPhone:

- **Mac**: new read-only `workspaceDiff` bridge action (Payload →
  Router → Executor → index.ts wiring, mirroring the workspaceFile*
  trio). It runs the SAME git surface the desktop renders (`get-diff`
  IPC → getWorkspaceDiff) projected through
  `DiffService.buildBoundedWorkspaceDiff` so the ack stays inside the
  relay frame budget: ≤40 files, ≤200 hunk lines/file, lines clipped at
  400 chars, truncation flagged per-file and on the total. Noise files
  drop (the desktop's "Hide noise" default); sensitive/binary files
  keep their row but ship no hunks.
- **iOS**: left rail = changed files (name, Created/Modified/Deleted
  capsule, +N/−M in statusSuccess/statusFailed) with the Files-mode
  workspace Picker + Refresh + truncation footer; detail = unified
  diff in a two-axis scroll — monospaced rows with old/new line-number
  gutters, add rows on a 0.12 statusSuccess tint, del on statusFailed,
  ctx in textSecondary, hunk headers caption/tertiary. Fixed row widths
  (the widest clipped line sets the content width) keep the tints
  uniform under horizontal scroll. The Back-to-app/Changes header
  mirrors the file editor pane.
- **Transcript edit odometers**: the per-edit ± stats already projected
  on tool entries now render as "Edited <file> +N −M" on write-class
  cards (filename in accent) and the numbers roll with
  `.contentTransition(.numericText())` as consecutive edits collapse
  and their sums grow. Collapsed-group identity switched from
  content-derived to position-stable (ordinal+name) — content-derived
  ids made SwiftUI replace the row on every tick, which swallowed the
  animation.

## v0.38 — independent crypto review + fixes (BD4)

Ran the review the dossier was prepared for: 3 fresh-context adversarial
reviewers (protocol design / implementation / infra-trust), told not to
trust the dossier or comments. They found real no-ship issues — including
TWO independently flagging the same data-plane-before-auth bug (one
CRITICAL). All CRITICAL + HIGH fixed and verified:

- **CRITICAL** — onEncrypted gated app delivery on `keys`, not
  `established`: a relay completing only the ephemeral ECDH could land a
  forged action before identity proof. App messages now require
  established (control frames still ride pre-auth for the resume flow).
- **HIGH** — SAS confirm code was grindable (clientHello re-ran
  unboundedly, code shown only on clientAuth). Now refused while a
  handshake is in-flight. (First attempt keyed on the Mac's
  always-undefined peerIdentity and broke reconnect — corrected to the
  in-flight flag.)
- **HIGH** — approvalReply resolved approvals globally by id with no
  workspace/thread binding. Now scope-checked like questionReply.
- MED/LOW — replay-window clamp, relay room/IP caps, all-zero X25519
  reject, registerApnsToken replay-guarded, Swift epoch parity, phone QR
  expiresAt + un-importable-key rejection.

Full findings (fixed + residual) in docs/security/e2ee-review-findings.md
(local-only; docs/ is gitignored). Residual MED — silent identity
regeneration on safeStorage-unavailable / Keychain-write-failure — is the
one item flagged before submission; needs a surfaced-error UX pass.
Verified: 34 e2ee tests (2 new gate regressions), 4033 Mac tests, Swift
suite, both device builds, live Swift↔Node handshake.

## v0.39 — transcript ergonomics batch (T63)

Five boss asks, each fixed at the data source rather than patched in UI:

- **Copy message + delivery time** (T63a): long-press menu gains Copy
  message above Pin message, under a read-only "Delivered HH:mm" section
  header. The Mac always sent `row.timestamp`; the Swift Row just never
  decoded it.
- **Edit-file ±odometer** (T63b): Mac `bridgeToolDiffStats` only knew
  old/new_string + bare patch/diff keys — Codex's edit_file ships
  {changes, patchPreview}. Now mirrors the renderer's ToolParser lanes
  (codex_changes counts → patchPreview/unified_diff → structure-gated
  result_diff for shell-driven edits). ToolActivityCards' existing
  odometer lights up with no UI change.
- **Approvals pinned to the SCREEN** (T63c): the in-List section scrolled
  away — approvals went unseen until the user happened to scroll. Now a
  top safe-area-inset banner (content-hugging, self-scrolls past 340pt,
  attention-tinted border). Timeout parity: scheduler records each armed
  deadline; projectApprovalCard stamps it as expiresAt, so the new ticking
  "auto-denies in Ns" countdown matches Settings → Providers exactly.
- **Codex burst separation** (T63d): desktop already inserted
  \n\n---\n\n on agentMessage itemId transitions; the bridge-run
  persistence path and the iOS live bubble both ignored itemId and jammed
  bursts into one paragraph. Both now separate; MarkdownLite renders
  ---/***/___ as a hairline divider.
- **Run-summary file edits** (T63e): run summaries carried counts only,
  and the iOS card relied on the latest-run diffSummary envelope (so older
  cards / post-relaunch cards showed nothing). Every run summary now
  carries ≤12 lean per-file rows; TaskCompleteCard prefers them and gates
  the legacy diff lane on its own runId (stale-diff fix).

Also landed: prior-session uncommitted iOS work (ATS scoped exception,
PrivacyInfo manifest, keyboard-dismiss pill, picker rework, file-editor
models) carried into the tracked subset; AttentionRows /
RemoteSessionModel / WelcomeViews force-added (slice convention).
Verified: 118 Mac tests across the touched suites, swift build green.

## v0.40 — hydration tickers (audit batch)

Audited every surface that hydrates over the bridge for "authoritative
empty during in-flight data" traps. Four found, all fixed with a shared
HydrationTicker (StreamingDots + what's-loading caption):

- **Home list** — the worst: "No workspaces shared" + Mac Settings
  instructions on every cold connect before the first snapshot. New
  `projectionHydrated` gate on RemoteSessionModel: flips on real content
  or a 5s post-establish grace (Mac re-seeds settling snapshots at 1.5s);
  never resets on transient drops. Until it flips: "Syncing workspaces
  from your Mac…".
- **Side-chat mini window** — existing chats showed "No messages yet"
  while the on-open snapshot fetch ran; now gated on a DELIVERED snapshot
  with totalRows == 0.
- **New-chat canvas** — provider menus rendered empty pre-catalog; one
  ticker up top covers roster menus + picker sheet + composer pill.
- **Inspector Changes tab** — "No file changes yet" reserved for idle
  threads; active runs show "file changes appear here as the agent
  writes".

Already covered (no change): transcript cold-open loading branch,
reconnect banners, side-chat creation interstitial, File Editor / Diff
Studio spinners, Usage tab's expectation-setting copy.

## v0.41 — TestFlight blockers (residual MED closed)

Pre-submission audit fixes (the export-compliance plist key is parked
until the classification is confirmed):

- **Silent pushes were dropped** — Http2ApnsPusher sends
  content-available:1 wake pushes but the app never declared
  `UIBackgroundModes: remote-notification`; only alert pushes arrived.
  Declared + Info.plist regenerated.
- **Residual MED — silent identity regeneration — FIXED on both ends.**
  Mac: RemoteIdentityStore throws on existing-but-unreadable /
  unprotectable / unpersistable identities (was: silently minted a
  stranger every paired phone refuses); bridge startup holds the runtime
  down and surfaces the reason in Settings → Bridge networking ("Failed
  to start" pill + message). iOS: the Keychain seed store generates ONLY
  on a positive errSecItemNotFound, throws otherwise (and on write
  failure); the shell shows a dedicated recovery screen (unlock /
  restart / deliberate reinstall-and-re-pair) with Try again. Connect
  paths refuse while the identity is unavailable.
- **Cleartext relay preflight** — ATS allows ws:// only to local hosts;
  remote ws:// (public DNS/IP, Tailscale CGNAT 100.64/10) died with an
  opaque ATS error mid-socket. Pairing AND trusted reconnect now fail
  fast with an actionable wss:// message.

Verified: 25 Mac remote-store tests (3 new refusal regressions), Swift
suite, full xcodebuild of the app target, typecheck.

## Current follow-ups

1. Keep the first-launch, settings, usage, and provider-readiness surfaces in
   sync with the Mac projection schema as 1.6.0 hardens.
2. Tighten iPad-exclusive density: sub-thread tree, side-by-side transcript +
   diff review, and larger workflow/ensemble controls.
3. Continue device QA across offline Demo Mode, paired LAN, paired Tailscale,
   foreground reconnect, APNs wake, image attachments, and settings persistence.

## Non-goals

- Provider login flows, API-key entry, CLI installation, deep MCP server
  authoring, and provider account upgrades remain Mac-owned. The phone may show
  readiness, usage, and setup references, but it should not become a replacement
  for desktop provider configuration.
