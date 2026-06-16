# Changelog

Notable changes to TaskWraith, the local-first macOS desktop workbench for running
and reviewing AI coding agents. Entries are user-facing highlights; execution,
history, and workspace state stay on your machine throughout.

## 1.5.5 - 2026-06-16

### Fixed
- **iOS Ensemble participant editing.** Each participant chip can now set its own
  approval mode (Plan / Default / Full workspace) and reasoning/thinking (effort
  for Codex/Claude/Grok, extended thinking for Kimi, plus fast mode) from the
  phone — previously only provider / model / role were editable there.
- **iOS Ensemble reorder.** The Earlier / Later (and drag) participant reorder no
  longer snaps back: the new speaking order is confirmed to the phone immediately
  and held until the desktop echoes it.
- **Ensemble reasoning on concurrent rounds.** Per-participant reasoning / thinking
  is now applied on concurrent (fan-out) rounds too, not only serial turns.

The macOS build is notarized + stapled (universal). Windows (unsigned) and Linux
(AppImage/deb) installers are attached by CI.

## 1.5.4 - 2026-06-16

### Fixed
- **Local (Ollama) models can now edit files.** Choosing a file-edit tier (or
  Tier 4 / Provider parity) reliably grants edit tools: the per-workspace parity
  grant is matched tolerant of path form, and when Tier 4 is selected but the
  current workspace isn't granted you now get a clear in-run warning instead of a
  silent read-only downgrade. Small local models are also prompted to make
  focused edits directly at edit tiers rather than only drafting a plan to hand
  off.
- **iOS "always running" sub-thread tombstones.** Deleting a parent chat now
  cascades to its sub-threads / side-chats (and already-orphaned ones are
  reaped), so the phone no longer shows long-dead sub-threads stuck as "running."
- **iOS thread count.** Archived chats are hidden from the phone's lists and
  counts, matching the desktop sidebar.

### Changed
- **iOS notification banners.** Warnings, errors and confirmations now use a
  translucent glass style with a top-lit rim and consistently appear pinned at
  the top of the screen instead of crowding the composer.
- **iOS Ensemble @-mentions.** Tagging a single participant scopes the round to
  them, so the "Participants reachable" card narrows to the tagged participant
  (desktop parity).
- **iOS usage inspector.** Added 90-day daily token bar charts (TaskWraith Tokens
  and External Tokens) below the activity heatmaps.
- **Discord context.** Runs can be supplied with Discord channel context,
  including across ensemble participants.

The macOS build is notarized + stapled (universal). Windows (unsigned) and Linux
(AppImage/deb) installers are attached by CI.

## 1.5.3 - 2026-06-16

### Fixed
- **iOS Stop button.** Stop now targets the live run the moment streaming starts
  (rather than the throttled projection), and works on global chats and
  experimental providers — the desktop honors the cancel for those paths too.
- **iOS composer state.** Opening an existing thread re-syncs the composer's
  model / provider / reasoning picker to that thread instead of leaking the
  previously open thread's selection, and the new-chat welcome screen now follows
  the chosen provider's theme as you change it.
- **iOS new-chat workspace + global handling.** New chats can switch their
  workspace before the first message (the desktop relocates the still-empty
  draft), and global chats are classified by an authoritative scope check so the
  plan-mode pin and read-only treatment stay correct.
- **Stray draft cleanup.** Opening "New Chat" on iPhone and backing out no longer
  leaves a phantom "New Chat" row in the desktop sidebar or the phone list —
  unstarted drafts are hidden from chat lists and reaped on reconnect, including
  ones that had picked up a goal or pin.
- **iOS transcript crash.** Hardened the run-completion transcript scroll on
  iPhone to avoid a UICollectionView abort seen over cellular.

### Changed
- **App Store export compliance.** The iOS companion declares standard, exempt
  encryption (`ITSAppUsesNonExemptEncryption = NO`) per App Store Connect's
  questionnaire result, and TestFlight export entitlements are verified in the
  archive path.

## 1.5.2 - 2026-06-15

### Added
- **iOS companion TestFlight path.** The companion now has a release archive
  script, app lifecycle readiness coverage, lifted remote-pairing flags, APNs
  wake/reconnect hardening, and foreground/background reconnect fixes for paired
  iPhone and iPad sessions.
- **Remote composer parity.** iOS receives projected secondary workspace rows,
  richer mobile thread metadata, queue prompt projection/pumping, inspector
  affordances, and compact telemetry when the available rail is narrow.
- **Remote file and transcript parity.** iOS can lazily browse workspace files,
  load older transcript chunks, receive transcript chunks in ACK responses, and
  show run file changes in task-complete summaries.
- **Usage activity depth.** Model Usage gained stacked and 90-day activity
  heatmaps so provider activity history is easier to scan.

### Changed
- **Runtime prompt compaction.** The TaskWraith runtime preamble is more compact
  and carries an explicit persisted version so future prompt upgrades can be
  reasoned about and migrated deliberately.
- **iOS material polish.** Remote welcome, inspector, status banners, composer
  shell rows, run controls, streaming tails, and activity panels now track the
  desktop visual model more closely.
- **Desktop transcript polish.** Returned sub-thread cards, Diff/guest state,
  roster preset saving, composer shell themes, notes dock, activity viewport
  masks, and run-summary copy labelling were tightened.

### Fixed
- **Remote security and allowlists.** Explicit workspace capabilities now persist,
  secondary workspace writes require write allowlist coverage, APNs attention
  payloads are sanitized, stale bridge state is cleaned up, and workspace file
  list envelopes are capped more narrowly.
- **iOS E2EE and lifecycle safety.** Cipher validation rejects invalid sequence
  and key inputs predictably, and wake/reconnect paths avoid stale or slow bridge
  state after notification-driven launches.
- **Provider and cost projections.** Cache-aware cost estimates now propagate to
  iOS, Grok empty ACP tool failures surface correctly, welcome activity panels
  keep cycling, and iOS preserves composer model/workspace state across empty
  drafts.

## 1.5.1 - 2026-06-13

### Added
- **Persistent thread goals.** Use `/goal <objective>` or the new composer goal
  control to set an active objective and stopping condition for a chat. Codex can
  mirror goals into native app-server goal state when supported; other providers
  use TaskWraith-steered goal context plus `goal_read`, `goal_update`,
  `goal_complete`, and `goal_blocked` tools.
- **Audit orchestration.** `/audit` now runs a policy-aware multi-agent review
  pipeline with provider-selection controls, live progress cards, dismissible
  completion banners, structured findings/verdicts, and safer failure reporting.
- **Expanded local-model roster.** Ollama support now includes Qwen 3.6, Granite,
  MiniCPM-V, and Nemotron presets alongside the existing GPT-OSS, Gemma, and Qwen
  profiles.
- **Provider failover controls.** Providers can be paused so queued or recovered
  work can move to an available fallback rather than silently retrying a blocked
  runtime.

### Changed
- **GPT-OSS/Ollama coding harness.** Local models get richer model metadata,
  profile-aware context budgets, native-first tool calling, safer loop stopping
  around goal lifecycle tools, workspace symbols/git context, and stricter
  explore-before-edit/read-before-edit discipline.
- **Provider and transcript parity.** Cursor, Grok, Ollama, and native provider
  tool results now render with closer markdown/tool-card parity in the transcript
  pane, including expanded tool-result prose.
- **Model usage accounting.** Cursor IDE Composer activity, external provider
  usage, cached-token pricing, manual refresh, and local Ollama RAM samples are
  surfaced in the model-usage table with clearer provider rows.
- **Brand and onboarding polish.** The first-launch sheet and workspace mastheads
  use the theme-aware monoline ghost mark, clearer provider availability LEDs, and
  updated copy for the current seven-provider surface.

### Fixed
- **Audit runs no longer assume Claude.** Audit provider selection respects the
  configured provider set instead of spawning a provider the user may not have.
- **Audit banners are dismissible.** Completed audit run cards can be hidden after
  the user has seen the result.
- **Cursor cache stat handling.** External Cursor usage scans use the correct file
  stat helper and avoid crashing the cache prewarm path.
- **Light-mode sky reveal.** Weather/sky effects retain the visible sky band
  without washing out the transcript reading surface.

## 1.5.0 - 2026-06-13

### Added
- **iOS companion source publication.** The Swift package, iOS app target, assets,
  privacy manifest, entitlements, and interop fixtures are now tracked while
  signing-local state, build outputs, and provisioning material remain ignored.
- **Remote companion hardening.** Paired iPhone/iPad sessions gained richer
  transcript fidelity, reconnect recovery, Git workflow actions, global-chat
  visibility, and stricter bridge routing under the encrypted transport.
- **Release hardening.** macOS update-feed validation now checks artifact sha512
  and size parity, Swift bridge tests run in the macOS release path, and CI has
  unsigned Windows and Linux artifact jobs.

### Changed
- **Public provider/MCP docs.** The docs now describe the seven first-class
  providers and distinguish full brokered MCP providers from narrower Cursor,
  Grok, and Ollama tool surfaces.
- **Startup and persistence performance.** Chat hydration, workspace-change
  caching, and persisted raw-event compaction reduce launch and selection cost on
  large workspaces.

### Security
- **Public build boundary maintained.** Remote/iOS user-facing surfaces remain
  gated behind `IOS_REMOTE_TRUE` while TestFlight/export-compliance work
  continues.
- **Package hygiene.** The shipped app excludes internal docs, local-only folders,
  scripts, tests, and signing material from the production bundle.

## 1.4.8 — 2026-06-11

### Added
- **Remote companion preview groundwork.** Paired iPhone/iPad sessions now carry
  richer thread snapshots, run telemetry, tool transcript segments, model usage
  quota windows, thread notes, pinned messages, side-chat creation, guest
  participants, queued prompt controls, and ensemble roster/steering updates over
  the encrypted bridge.
- **Multi-device remote pairing.** The Devices panel can list multiple paired iOS
  devices and the workspace sidebar remote button now glows when a paired device
  is actively connected.
- **iOS shell parity polish.** The companion app picked up desktop-aligned
  thinking indicators, 90-day heatmap variants, manual swipe control for heatmap
  cycling, iPad rotation support, and a frosted composer shell pass.
- **Usage dashboard bridge data.** Usage rollups and model-quota windows now flow
  into the remote bridge feed, with refreshed heatmap labels.

### Changed
- **Remote run continuity.** Phone-initiated continuations now inherit the chat's
  model/session context, preserve interleaved tool transcripts, keep readable MCP
  tool details, and use the canonical compatibility vocabulary.
- **Remote reliability.** Bridge resume/reconnect paths were hardened against
  stale replay epochs, empty post-restart snapshots, heartbeat gaps, terminal run
  status races, and attachment-temp cleanup issues.
- **Weather FX fog polish.** Fog/mist weather effects now use warped, blurred
  bands for a softer naturalistic atmosphere.

### Fixed
- **Remote provider inheritance.** Gemini auth/session state, Ollama memory, and
  ensemble steering now preserve the expected provider context across phone runs.
- **Remote payload size.** Diff envelopes and thread projections were tightened
  so large workspaces stay within relay frame limits.

## 1.4.7 — 2026-06-10

### Added
- **Flag-gated iOS remote transport foundation.** End-to-end encrypted pairing,
  trusted reconnect, in-process relay hosting, ghost-branded QR pairing, remote
  workspace allowlists, live transcript streaming, model catalogs, ensemble roster
  editing, and image attachment transport landed behind the iOS remote build flag.
- **Ensemble identity polish.** Same-provider participants now carry
  model-labelled identities and can be addressed by role or model name.

### Changed
- **Ollama harness routing.** Small-talk prompts skip the heavier agentic scaffold,
  while `todo_write` routes to its real MCP handler.
- **Composer and sky polish.** Schedule/runtime rows, composer accessory rails, sky
  clouds, and the sun/moon orb received visual refinement.

## 1.4.6 — 2026-06-09

### Added
- **Local Servers.** TaskWraith detects workspace dev servers (Vite, Next, etc.),
  surfaces them in a new sidebar section and Settings tab, and maps legacy AGBench
  workspace labels to TaskWraith.
- **iOS transport foundation (T0–T3).** `taskwraith-e2ee-v1` protocol library +
  relay, Mac transport client, identity store, pairing flow, and the bridge
  runtime piping projections/actions through the encrypted channel — proven
  end-to-end by a fake-iPhone harness (pair → snapshot → actions → drop/resume).
  Dark by default; enabled via `IOS_REMOTE_TRUE=1` + `TASKWRAITH_RELAY_URL`.
- **Claude Fable 5.** Anthropic's new frontier tier (above Opus) joins the Claude
  model/reasoning picker as Claude Fable 5 and Claude Fable 5 1M, with context
  meter, usage rates, and ensemble support. Claude usage rates refreshed to the
  published pricing (Opus $5/$25, Haiku $1/$5, no 1M premium).
- **WWDC26 ghost mascot.** App chrome uses the new chrome PNG with cyan glow;
  source artwork lives under `design-assets/`.
- **Sidebar section reorder.** Drag to rearrange hierarchy sections (Pinned,
  Recents, Workspaces, etc.).

### Changed
- **Composer above-bar polish across every shell.** Canonical element order
  restored (git → files/diff → action); secondary rows group trailing controls as
  Push/Review → access icon → revoke; Cursor secondary workspaces render as
  detached satellite pills; Codex/Grok primary rows centre the files cluster;
  Claude ensemble above-rows use detached pills; native composer glass bezel and
  textarea chrome refined; attach/send glyphs doubled in size.
- **Transcript chrome.** Corner pills restyled as rim highlights; glass-pill
  dividers, hover glow, and title spacing polished; Agent Aura / Living Workspace
  background glows neutralised; top-edge chroma wash and side glows removed.

### Fixed
- **Above-bar trailing order regressions.** Push/Review no longer sits after the
  read/write and ✕ icons on secondary workspace rows.
- **Codex secondary workspace divider.** Hairline appears above the 2nd workspace
  row only (not duplicated on roster presets).
- **Grok roster presets divider.** Upper divider removed per shell design.

## 1.4.5 — 2026-06-09

### Added
- **Ollama explore-before-edit harness.** Local models are gated through an
  explore→read→edit workflow with a `todo_write` scaffold, replacing the narrower
  retrieval-first read policy — fewer blind edits, more grounded local runs.
- **Grok tucked above-row shell.** The Grok composer adopts the Codex-style
  tucked-tab stack (a narrower row nested under the composer lip), with matching
  Settings and First-Launch previews and a "Create PR" preview label.

### Changed
- **Accurate Ollama token chips in ensembles.** Per-participant token spend now
  reads the same canonical totals (snake_case + camelCase reconciled) as usage
  recording and the composer tally.

### Fixed
- **Ensemble participant chips collapsing to slivers.** On every composer shell,
  ensembles of 1–6 participants rendered as ~2px status-dot slivers (and, in an
  earlier state, overlapping labels). Chips now size to their content — short
  roles stay compact, long roles truncate with an ellipsis — and the Work Session
  band no longer crushes the strip. Root cause was inline-size containment on the
  chip zeroing its content-derived width in the single-row flex layout.

## 1.4.4 — 2026-06-09

### Added
- **Ollama context engineering.** Per-model conversation budgets (Qwen 4B vs 9B vs
  GPT-OSS vs Gemma differ), a pre-run workspace index (shallow file tree + symbol
  sample), retrieval-first read policy (search before unfamiliar `read_file`),
  heuristic tool-result summarization, and rolling working-memory compaction after
  every few tool turns so locals keep generation headroom.
- **Ollama session continuity.** Pruned tool trajectory (calls + summaries, not full
  file bodies) persists on each chat and re-injects on the next solo run.
- **GPT-OSS tool protocol hardening.** Compact tool schemas, one-tool-per-turn,
  JSON response mode when supported, and few-shot search→read→patch trajectories in
  the system prompt.
- **Mid-run Ollama tier guidance.** When a tool exceeds the active tier, the run
  surfaces a provider warning with the tier to raise instead of failing opaquely.
- **Ensemble Ollama reliability.** Dynamic transcript budgeting, degenerate-turn
  retry, compact tool schemas in ensemble runs, composer context-pressure hints,
  and concurrent fan-out lanes on by default with serial fallback when disabled.
- **One-click update pill.** When a new build is available, a rim-highlight pill
  appears at the top of the workspaces sidebar — click to download, then restart
  to install. The app also polls for updates every 15 minutes in the background.

### Changed
- **Concurrent ensemble lanes** default on (`TASKWRAITH_CONCURRENT_LANES` opt-out).
- **Ensemble thinking state** survives chat switches without losing the in-flight
  indicator.

### Fixed
- **Renderer crash** when reading Ollama feature gates from `process.env` in the
  packaged app (gates now come from the native capability snapshot).
- **Ensemble Ollama brand spoofing** no longer clobbers other participants' labels
  or merges provider assistant deltas into the orchestrator-owned transcript.

## 1.4.3 — 2026-06-09

### Added
- **Saved ensemble roster presets** with a recall picker above the work-in-folder row.
- **Role presets and goal brief** in the participant overflow popover; **apply-to-all**
  permissions control.
- **External-path grant preflight** in the composer when panelists need signed grants
  for connected workspaces (Ollama excluded from dispatch issuance).
- **Paste image/file attachments** into the composer; **Open in Finder** on the
  workspace picker; dismiss workspaces from the welcome folder row.
- **Composer context menu** and model-usage resize grip; dedicated git status counts
  row in the PR popover.

### Changed
- **Liquid-glass native composer** outer frame; agent aura fans to detached above-bar
  rows; Satellite shell flattens roster + ensemble rows; Cursor above-rows match the
  merged frosted instrument frame.
- **Continuous ensemble mode** max handoff cap raised to 100; welcome ensemble
  hierarchy provider icons enlarged.

### Fixed
- **Composer glass/aura** polish on default and native instrument shells (neutral
  smoked glass, no blue wash on above-bar stacks).
- **IPC schema** for `shell:reveal-in-finder`; external-path grant preflight types
  and `deferPersist` preload contract.

## 1.4.2 — 2026-06-08

### Added
- **Goal-step checklist (`todo_write`).** Universal TaskWraith MCP tool with a
  compact transcript card and live-viewport pin (Ollama from approved-edits tier).
- **Ollama local-model tuning.** Per-model preflight, model-aware prompts and
  compaction, tier suggestions, struggle handoff, health chip, and scout→implementer
  workflow hint.

### Changed
- **Live activity viewport** gains overflow-aware top/bottom edge fades and fixed
  jump/expand overlays while streaming.

## 1.4.1 — 2026-06-08

### Added
- **Native Ollama tool-calling** via Ollama's `tools` API (structured `tool_calls`
  instead of JSON-in-prose only).
- **Cursor-style live activity viewport** for in-flight tool calls and thinking
  (Settings → Density; on by default).
- **Cross-provider reasoning notes** — Ollama, Gemini API, and Claude stream
  internal reasoning as first-class thinking activity.

### Fixed
- **GPT-OSS empty replies** when answers land in the reasoning channel only.
- **Tool-intent stubs** and **malformed tool JSON** (tolerant re-parse + re-prompt
  instead of leaking protocol blobs to the user).
- **Multi-step Ollama tool loops** — raised cap and clearer follow-up prompting.

## 1.4.0 — 2026-06-08

### Added
- **Live web access for local models.** Local Ollama runs can now use `web_search`
  and `web_fetch`. Search returns ranked result links; fetch downloads a page and
  returns its readable text (HTML markup, scripts, and styles are stripped) so the
  model can summarize real content instead of raw markup.
- **Tiered tool control for Ollama.** A new tool-control tier ladder — read-only →
  approved edits → approved shell → provider parity — lets you decide how much
  local models can do, with a Settings surface and per-workspace grants. Read-only
  stays the default.
- **Qwen 3.5 (9B) preset.** Added to the curated local model line-up alongside the
  existing Qwen, Gemma, and GPT OSS presets.
- **Discord channel context.** Attach a scoped, run-only snapshot of the most recent
  messages from a Discord channel (you choose how many) as untrusted model context
  for collaborative projects. Reads only — agents don't post back.
- **Link favicons.** Links in prompts and transcripts now show a favicon for quicker
  visual scanning.
- **Local memory telemetry in the composer.** Ollama threads show the latest
  llama-server peak RAM (e.g. `17.0GB`) in the composer telemetry row, in place of
  the cost estimate shown for metered cloud providers.

### Fixed
- **GPT OSS replies again.** Harmony-format models (e.g. GPT OSS) that stream their
  answer into the reasoning channel no longer finish with an empty response;
  TaskWraith now surfaces that text when the normal content channel is empty.
- **Readable `web_fetch` results.** Page HTML is converted to readable text before
  truncation, so local models receive prose within the character budget rather than
  a head full of CSS and scripts. Non-HTML responses (JSON, plain text) pass through
  unchanged.
- **Local models recognize their web tools.** The Ollama system prompt now states
  explicitly that `web_search`/`web_fetch` reach the live internet, so models stop
  denying the capability and use the search → fetch → summarize flow.
- **Ollama run-card model labels.** Corrected the model label shown on local run
  cards.

### Changed
- **Ollama approval previews tightened.** Clearer previews before approved-edit and
  approved-shell tool calls.
- **Provider parity scoped to workspace grants.** Ollama provider-parity tooling is
  gated behind explicit per-workspace grants.

### Security
- **Local web + workspace tools stay policy-gated.** `web_search`/`web_fetch` are
  read-only and routed through TaskWraith policy; workspace tools keep every path
  inside the active workspace, and write/shell tiers require explicit approval.

## 1.3.0 — 2026-06-08

### Added
- **Local Ollama provider.** TaskWraith can talk to a local Ollama runtime without
  a cloud API key, starting with curated presets for Qwen 3 4B, Gemma 4 12B, and
  GPT OSS 20B. Local transcript labels present those models by their upstream
  family — Qwen, Google/Gemma, and OpenAI/GPT OSS — while the runtime remains
  the local Ollama provider.
- **Read-only tools for Ollama.** Local Ollama runs can now request
  TaskWraith-controlled workspace list/read/search tools. Shell and write tools
  are not exposed, and every path stays scoped to the active workspace.
- **Channel gateway foundation.** The dev/debug-only message bridge has been
  renamed into a broader Channels architecture with a canonical inbound event,
  adapter descriptors, route targets for existing chats / new provider threads /
  workspace default agents / ensembles / approval-status endpoints, and portable
  commands such as `approve`, `deny`, `status`, `pause`, `resume`, `show diff`,
  `open thread`, `send file`, and provider handoff.
- **Free/BYO channel adapters.** Telegram bot long polling, Matrix room polling,
  and local web/PWA chat now sit beside the experimental local iMessage adapter.
  Signal CLI, email, Discord, and Slack are represented as planned adapters so
  future work plugs into the same contract rather than a one-off bridge.
- **Guest participants in normal chats.** Standard chats can now invite linked
  provider guests for focused side replies, with deduped side-chat chips and
  clearer linked-chat sidecar presentation.
- **Pinned messages dock.** Important transcript messages can be pinned and
  reviewed from a dedicated dock/settings surface.

### Changed
- **Side-chat UX polish.** Linked sidecars have cleaner copy, sizing, and run
  presentation so they read as attached work surfaces rather than stray chats.
- **Faster chat hydration.** Thread selection and chat-list IPC are now hydrated
  after paint, reducing initial selection stalls on heavier workspaces.
- **First-launch local-model signposting.** Onboarding now includes a minimal
  Ollama card and install hint without treating local models like a cloud sign-in
  provider.
- **Seven-provider channel routing.** Channel handoff and provider-target choices
  cover Codex, Claude, Gemini, Kimi, Grok, Cursor, and local Ollama.

### Security
- **Channel gateway remains gated.** Channel user surfaces and bridge runtime are
  available only in development/debug builds while the remote message pipeline
  settles, preserving the 1.2.1 public-build boundary.
- **Channel-originated work stays policy-gated.** Inbound channel messages go
  through contact allow-lists, workspace allow-lists, provider policy, approval
  ledger handling, file/path checks, rate limits, and audit logging before a run
  can start or a file can be sent back.

## 1.2.1 — 2026-06-07

### Changed
- **Messages bridge is dev/debug-only.** The local Messages.app / iMessage relay is
  hidden from public release builds and its IPC surface returns a clear disabled
  status outside development or the packaged TaskWraith Debug app.
- **Cleaner transcript chrome.** The workspace toggle now owns the left pill, the
  remaining transcript controls sit in one right-side pill, and Diff Studio /
  File Editor / Pop-Out Chat are grouped behind one picker.
- **Help controls use real glyphs.** The changelog, onboarding, and bug-report
  controls now use info-circle, question-circle, and shield-warning symbols.

### Fixed
- **Dropdown pickers render again.** The condensed glass pill no longer clips the
  popout-tools picker or side-chat layout menu.
- **Changelog freshness.** Old downloaded-update notes no longer override the
  running app's bundled release notes after the app has moved past that version.

## 1.2.0 — 2026-06-07

### Added
- **First-class side chats.** Side chats are now durable and flexible — pop one out
  into its own window, dock it back, or promote it to a top-level chat, with draft
  text, scroll position, and presentation preserved across the move.
- **Approval-mode elevation failsafe.** Raising a chat's permission mode now asks
  first: a one-time notice per workspace when you enable Default Approval, and a
  sterner "only on disposable VMs or recoverable devices" confirm each time you
  enable Full Workspace Access. The acknowledgement is recorded in the approval ledger.
- **Smarter ensemble defaults.** A new ensemble seeds one participant per provider
  you actually have set up, instead of all six.
- **Windows testing installer.** Unsigned x64 + arm64 Windows installers are now
  produced on demand and attached to releases — a testing channel ahead of signed builds.

### Changed
- **Clearer MCP surface.** Settings → MCP no longer mislabels working providers:
  Cursor shows its TaskWraith web bridge (web_fetch + web_search) and Grok shows
  provider-managed status, replacing the misleading "unsupported / not installed" tags.
- **Tidier README.** Screenshots are now a grid instead of a long stack.

### Fixed
- **Grok no longer dead-ends.** A write/Default-mode Grok turn that reached for a
  shell command (e.g. `mkdir`) could cancel with no output; Grok is now steered to the
  Write/Edit tools and to adapt rather than end the turn when a tool is refused.
- **Windows CI launch smoke** now passes on the windows-latest runner.
- Side-chat composer, above-row, and presentation-lifecycle fixes.

### Security
- **Untrusted-input hardening.** External iMessage content is wrapped and replayed to
  the model as untrusted; IPC validation, shell-open policy, and prompt-composition
  sanitizers were extended for the new message surface.

## 1.1.0 — 2026-06-06

### Added
- **First-class workspace rows.** Every connected workspace row (primary and
  additional) now carries the full action set — Review changes → Push → Create PR
  + commit — scoped to that folder, with a compact read/edit access icon.
- **Adjustable ensemble history.** A shared-history budget slider (5K–500K
  characters) in the ensemble Turn picker controls how much recent panel context
  each agent sees.
- **Ensemble mode picker.** Turn / Continuous / Work Session moved into a
  hierarchical picker (matching the model picker); Fan-out (parallel read-only
  lanes) stays a separate toggle beside it.
- **Resizable side chat.** The side-chat split view resizes by drag or keyboard,
  with per-chat width persistence.
- **Top-center pop-out controls.** Diff Studio / File Editor / pop-out chat sit
  in their own glass pill row; the corner control pills are larger (1.6×) with a
  blurred backdrop.

### Changed
- **Provider-tinted composer pills.** Gemini (blue) and Kimi (olive) controls now
  carry the provider highlight; the native and other shells drop the redundant
  outer pill chrome for a cleaner row.
- **More transcript breathing room.** The clearance below the last message scales
  with the live composer height, so dense ensemble / multi-workspace composers
  never overlap the most recent message.

### Fixed
- **Grok no longer stalls.** A write-enabled Grok turn that ran a shell command
  was cancelling with no output; write mode now allows Bash, and read-only turns
  get a steer so they answer directly instead of dead-ending.
- **Ensemble context.** The shared transcript now keeps the most-recent messages
  when it has to truncate, and the default turn count is consistent.
- **Live usage meters.** Sidebar and settings usage totals refresh the moment a
  run finishes instead of going stale.
- **Kimi light mode + changelog rendering polish.**

## 1.0.75 — 2026-06-05

### Fixed
- **No more runaway background processes.** Fixed a loop where leftover Gemini
  MCP bridge registrations from before the rename could relaunch the app
  repeatedly in the background. Bridge detection is now rename-proof, and stale
  registrations are cleaned up automatically on launch.

## 1.0.74 — 2026-06-05

### Changed
- **AGBench is now TaskWraith.** The app is renamed end to end — name, icon,
  bundle ID, updater, MCP services, and docs. Your existing data carries over
  automatically on first launch: chats, settings, usage history, and saved state
  are migrated from the previous install.
- **Git-grounded workspace status.** The composer's "N files changed / +A −B"
  now reflects the real working tree via Git instead of tallying a thread's tool
  activity — so it drops to 0 the moment you commit, the way Codex/Claude desktop
  apps behave. Applies to the primary workspace and every additional workspace.
- **One clean row per additional workspace.** Adding a secondary/tertiary folder
  now shows a single native row per folder (with a combined read/edit access
  pill) instead of one row per participating provider, and revoking removes the
  whole folder in a click.

### Added
- **Push from the composer.** The Review changes menu now has a Push step
  between commit and Create PR — publish a new branch (sets its upstream) or push
  ahead commits in a click — and the primary action button names the real next
  step (Review changes → Push → Create PR) from live Git state.
- **Branch state at a glance.** The composer branch chip shows a
  merge / rebase / cherry-pick badge and a conflict count when the tree is
  mid-operation, and the CI check rollup is now clickable (opens the PR or the
  failing run).

### Fixed
- **Delegation cards read as one agent.** Sub-agent cards and the inspector
  timeline are tinted with each agent's identity colour as a full rim, replacing
  the left-edge accent sliver.
- **Composer above-rows.** The Git-status row stacks correctly in every composer
  shell (including Codex's tucked-tab layout), and a transcript render crash from
  a missing snapshot field is fixed.

## 1.0.73 — 2026-06-04

### Added
- **Commit & open PRs from the composer** — the Review changes menu now drives a
  real Git flow: see your branch and changed files, write a message and Stage all
  & Commit, then Create PR once the branch is pushed and ready (gated on a live
  readiness check).
- **Clearer Ensemble cost & escalation** — each round shows real vs. estimated
  spend (a latency line + an "API-equivalent" badge on estimates), and the
  orchestrator's escalation signals surface inline, so a multi-seat panel's value
  is visible rather than guessed.
- **Optional "why?" on approvals** — attach a short intent note when you allow or
  deny an agent action; it's recorded in the approval ledger.

### Changed
- **Refined native composer** — the TaskWraith shell is now a cohesive console: the
  input sits in a framed module (solid black/white outer frame, theme-tone inner
  panel + provider rim, full-bleed and squared), the Ensemble / Create-PR / Steer
  rows match the same solid frame, and the permission picker sits up front beside
  the + button. Onboarding and Settings → Appearance previews reflect the new look.
- **Deleting a chat tidies up after itself** — removing a chat now also clears
  that chat's own run-forensic artifacts (and only those).

### Fixed
- **Kimi tool calls** — repeated calls coalesce into a single inline card that
  updates in place (instead of stacking) and now show the target filename,
  matching the other providers.
- **Bug Report Refinement** — tidied how the in-app reporter shows your workspace
  (now a friendly `~/…` label).
- Onboarding, empty states, the welcome dashboard, provider accent colours, and
  the Diff Studio / File Editor light themes all got polish + readability fixes.

## 1.0.72 — 2026-06-04

### Security
- **Read-only means read-only** — choosing "Plan / read-only" for a run is now a
  hard floor that nothing downstream can quietly loosen: full-auto can't override
  it, delegated sub-agents inherit it, and uncategorised tools fail closed. The
  posture is enforced identically across Gemini, Claude, Kimi, Codex, and Grok.
- **Grok joins the read-only contract** — Grok now runs under read-only through a
  scoped, fail-closed tool bridge that exposes only non-mutating (read / list /
  search) tools, with the host denying any write the agent attempts.

### Added
- **Read-only that's still useful** — read-only agents keep full read parity
  (list / read / search) without prompts, and the run surface explains what a
  read-only seat can and can't do, by tool class.
- **Welcome dashboard controls** — a compact dashboard mode plus Settings →
  Appearance controls for heatmap layout, with swipeable heatmap cycles and
  animated transitions.
- **Clearer onboarding** — consistent provider hover states, all six usage
  meters, and a one-line role flow.
- **Bug reports as pre-filled GitHub issues** — the in-app reporter now opens a
  ready-to-file issue.

### Changed
- **Denied writes stay honest** — a blocked or rejected edit is no longer counted
  or shown as an applied file change; it reads "attempted (not applied)", and a
  read-only agent is told its posture up front so a refused write doesn't
  dead-end the turn.
- **Steadier transcript** — the Ensemble transcript no longer fights your
  scroll-up, agent questions resolve exactly once, and a message that anchors an
  open prompt can't be deleted out from under it.
- **Sturdier Codex** — a bad `config.toml` is surfaced clearly, a newer Codex CLI
  warns instead of breaking silently, and resuming no longer trips on a
  non-standard thread id; retired models were removed from the picker.
- **Settings & sidebar persistence** — general settings and sidebar section
  collapse now persist across launches.

### Fixed
- Ensemble: the "interrupted checkpoint" prompt no longer re-fires on every
  message, and stale checkpoint cards were removed from the composer.
- The MCP tool broker is confirmed up before a Claude run starts, with start
  failures surfaced instead of silently degrading.

## 1.0.71 — 2026-06-02

### Added
- **Onboarding clarity** — the first-launch sheet now shows copyable official
  install commands for each provider CLI, a sign-in primer (terminal-login vs
  in-app OAuth vs API key), a status-dot legend, and new "You stay in control"
  and "Track your usage & spend" sections. The Ensemble preview shows all six
  providers.
- **"Out of usage" provider state** — a provider that's signed in but at 100% of
  its quota now says so (with the reset time) instead of looking broken, in both
  onboarding and Settings.

### Changed
- **Confirmations** — deleting a chat or removing a workspace now asks first.
- **Failed runs explain themselves** — the completion card shows the exit code
  and last error instead of a bare "check Raw Events"; cancelled runs read "Run
  cancelled" rather than "code 130".
- **Consistent copy feedback** — copy buttons across the transcript, diffs,
  inspector, and media paths now confirm with "Copied".
- **Clearer states** — empty states for the Raw Events tab and the model picker,
  a loading state for the Gemini MCP test, and a mention popover that no longer
  runs off-screen.
- **Truer copy & numbers** — corrected file-mention syntax (`-@`), a shell-aware
  permission-colour hint, humanised byte sizes, pluralised counts, and clearer
  Gemini profile labels.
- **Ensemble** — Work Session presets show which is active, completed sessions
  reopen as "Restart" instead of silently restarting, finished strips no longer
  say "0s left", and failed participants offer an inline retry.

### Accessibility
- Search is focusable with ⌘F; sidebar menus support arrow-key navigation; the
  onboarding sheet now traps focus and focuses its first control on open.

## 1.0.7 — 2026-06-01

### Added
- **Ensemble shared blackboard** — a compact, scoped scratchpad of agreed facts,
  decisions, open risks, and do-not-repeat notes that panel participants consume
  instead of re-deriving context every round.
- **Session checkpoints** — long-running ensemble sessions snapshot their state
  and offer a transparent, timestamped resume after a crash or restart (it asks,
  it never silently auto-resumes).
- **Sticky screen-watch attachments** — a chat remembers the window it was
  watching and offers one-tap "Resume watching" when you return to it.
- **Solo scratchpad recall** — solo chats carry forward a recap of the last
  substantive turn and its tool trace across pause/resume.

### Changed
- **Long-transcript performance** — the transcript is virtualized, so dense
  ensemble threads stay smooth as they grow.
- **Usage & cost tracking** — ensemble runs now count toward the cumulative
  wall-clock and the activity heatmaps, and ensemble chats appear in Recents.
- **Ensemble coordination** — heuristics detect stuck / looping / disagreement
  patterns and *recommend* extending a round or synthesizing (never autonomous).
- More robust content-filter retries and provider rate-refresh fallbacks.

### Accessibility
- Status and indicator animations honour the in-app reduce-motion setting; the
  keyboard focus ring on message actions was restored.

### Security
- Signed and notarized macOS build.

## 1.0.6 — 2026-05-31

### Added
- **Two new first-class providers** — Grok (xAI agent CLI) and Cursor
  (Composer 2.5 CLI) — wired through composer shells, model pickers, sign-in
  flows, usage meters, and sub-thread inference alongside the existing lineup.
- **Scheduled pause / resume** — participants (and solo chats) can pause
  mid-run and resume later, with state surviving an app restart.
- **Workspace popout windows** — Diff Studio and the file editor in their own
  native windows with live refresh.
- **Currency layer** — display-currency picker, live FX refresh, and
  per-provider rate handling for cost estimates.
- Activity heatmaps (workspace / app / external), sub-agent identicons,
  provider glyphs, and an app-shell stats toolbar.

### Changed
- Welcome, dashboard, and composer polish; light-mode contrast fixes; a
  consolidated participant-health header for ensemble panels.

> 1.0.5 was an internal development milestone whose work rolled into 1.0.6.

## 1.0.4 — 2026-05-27

### Added
- **Ensemble mode** — run several coding agents as a panel with a chair /
  synthesizer, structured rounds, and per-participant review.
- **Work sessions** — grouped, resumable units of agent work.

## 1.0.3

### Added
- Local-first desktop workbench for running and reviewing coding-agent CLIs
  across multiple providers: workspace trust state, approval modes, activity
  timelines, command-output and status review, and run-scoped diff review.

---

See [`README.md`](README.md) for setup and [`SAFETY.md`](SAFETY.md) /
[`SECURITY.md`](SECURITY.md) for the safety and security boundaries.
